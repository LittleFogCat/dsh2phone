package tech.xiaoniu.dsh2phone;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.UnknownHostException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLException;

/**
 * 原生配对请求。刻意不跟随重定向：配对码只能发给二维码里的那个 origin，
 * 否则一个 302 就能把一次性 code 带到别的服务器。
 */
public final class PairingClient {
    public enum Status {
        SUCCESS,
        CODE_EXPIRED,
        REJECTED,
        TUNNEL_OFFLINE,
        NO_CREDENTIAL,
        CERT_ERROR,
        DNS_ERROR,
        CONNECT_ERROR,
        TIMEOUT,
        HTTP_ERROR,
        NETWORK_ERROR,
        UNEXPECTED,
        CANCELLED,
    }

    public static final class Result {
        public final Status status;
        public final int httpStatus;
        public final String serverTitle;
        public final String serverDetail;
        public final List<Cookie> cookies;
        public final String deviceName;
        public final String entryPath;

        Result(Status status, int httpStatus, String serverTitle, String serverDetail,
               List<Cookie> cookies, String deviceName, String entryPath) {
            this.status = status;
            this.httpStatus = httpStatus;
            this.serverTitle = serverTitle == null ? "" : serverTitle;
            this.serverDetail = serverDetail == null ? "" : serverDetail;
            this.cookies = Collections.unmodifiableList(new ArrayList<>(cookies));
            this.deviceName = deviceName == null ? "" : deviceName;
            this.entryPath = entryPath == null ? "" : entryPath;
        }

        static Result error(Status status, int httpStatus) {
            return new Result(status, httpStatus, "", "", Collections.emptyList(), "", "");
        }

        public boolean isSuccess() {
            return status == Status.SUCCESS;
        }
    }

    private static final int CONNECT_TIMEOUT_MS = 15_000;
    // relay 的确认超时是 120s；读超时必须比它长，否则会在电脑端点“允许”前先断。
    private static final int READ_TIMEOUT_MS = 155_000;
    private static final int MAX_BODY_BYTES = 512 * 1024;

    private final String userAgent;
    private volatile HttpURLConnection connection;
    private volatile boolean cancelled;

    public PairingClient(String userAgent) {
        this.userAgent = userAgent == null ? "dsh2phone" : userAgent;
    }

    public void cancel() {
        cancelled = true;
        HttpURLConnection c = connection;
        if (c != null) {
            try {
                c.disconnect();
            } catch (Exception ignored) {
                // 断开是尽力而为；socket 读会随之中断。
            }
        }
    }

    public Result pair(PairUrl target, String existingDeviceValue, boolean allowBadCert) {
        if (cancelled) return Result.error(Status.CANCELLED, 0);
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(target.url).openConnection();
            connection = conn;
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", userAgent);
            conn.setRequestProperty("Accept", "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
            conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Connection", "close");
            if (existingDeviceValue != null && !existingDeviceValue.isEmpty()) {
                // 复用旧设备身份，relay 会按 dshdev 而非 UA 去重。
                conn.setRequestProperty("Cookie", "dshdev=" + existingDeviceValue);
            }
            if (allowBadCert && conn instanceof HttpsURLConnection) {
                Tls.allow((HttpsURLConnection) conn);
            }

            int httpStatus = conn.getResponseCode();
            if (cancelled) return Result.error(Status.CANCELLED, httpStatus);

            // 先拿 Set-Cookie。正文只用于设备名和入口 href，属于“可选展示信息”：
            // 某些网络栈/中间层会在响应末尾提前 EOF（ProtocolException），
            // 不应因此把已经下发的 dshdev 丢掉、让用户重扫一次二维码。
            List<Cookie> cookies = SetCookie.parseHeaders(setCookies(conn), target.host);
            String body = "";
            try {
                body = readBody(httpStatus >= 400 ? conn.getErrorStream() : conn.getInputStream());
            } catch (IOException ignored) {
                // 正文截断：保留 cookies，后面用 fallback 入口路径。
            }

            if (httpStatus == 200) {
                Cookie device = find(cookies, "dshdev");
                if (device == null) {
                    return new Result(Status.NO_CREDENTIAL, 200, HtmlText.title(body),
                            HtmlText.firstParagraph(body), cookies, "", "");
                }
                String name = HtmlText.textByClass(body, "device");
                String entry = resolveEntryPath(target, HtmlText.hrefByClass(body, "enter"));
                return new Result(Status.SUCCESS, 200, HtmlText.title(body),
                        HtmlText.firstParagraph(body), cookies, name, entry);
            }

            String title = HtmlText.title(body);
            String detail = HtmlText.firstParagraph(body);

            if (httpStatus == 403) {
                boolean rejected = title.contains("配对被拒绝")
                        || detail.contains("拒绝")
                        || detail.contains("超时")
                        || detail.contains("中断");
                return new Result(rejected ? Status.REJECTED : Status.CODE_EXPIRED,
                        403, title, detail, cookies, "", "");
            }
            if (httpStatus == 503) {
                return new Result(Status.TUNNEL_OFFLINE, 503, title, detail, cookies, "", "");
            }
            return new Result(Status.HTTP_ERROR, httpStatus, title, detail, cookies, "", "");
        } catch (SSLException e) {
            return new Result(cancelled ? Status.CANCELLED : Status.CERT_ERROR, 0, "",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), Collections.emptyList(), "", "");
        } catch (UnknownHostException e) {
            return new Result(Status.DNS_ERROR, 0, "",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), Collections.emptyList(), "", "");
        } catch (ConnectException e) {
            return new Result(Status.CONNECT_ERROR, 0, "",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), Collections.emptyList(), "", "");
        } catch (SocketTimeoutException e) {
            return new Result(Status.TIMEOUT, 0, "",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), Collections.emptyList(), "", "");
        } catch (IOException e) {
            return new Result(cancelled ? Status.CANCELLED : Status.NETWORK_ERROR, 0, "",
                    e.getClass().getSimpleName() + ": " + e.getMessage(), Collections.emptyList(), "", "");
        } catch (GeneralSecurityException e) {
            return Result.error(Status.CERT_ERROR, 0);
        } catch (RuntimeException e) {
            return Result.error(Status.UNEXPECTED, 0);
        } finally {
            connection = null;
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // 已经结束的连接，忽略。
                }
            }
        }
    }

    private static Cookie find(List<Cookie> cookies, String name) {
        for (Cookie c : cookies) {
            if (name.equals(c.name) && !c.isExpired()) return c;
        }
        return null;
    }

    private static List<String> setCookies(HttpURLConnection conn) {
        Set<String> values = new LinkedHashSet<>();
        Map<String, List<String>> fields = conn.getHeaderFields();
        if (fields != null) {
            for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
                if (entry.getKey() != null && "Set-Cookie".equalsIgnoreCase(entry.getKey())) {
                    values.addAll(entry.getValue());
                }
            }
        }
        if (values.isEmpty()) {
            String single = conn.getHeaderField("Set-Cookie");
            if (single != null) values.add(single);
        }
        return new ArrayList<>(values);
    }

    private static String readBody(InputStream input) throws IOException {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > MAX_BODY_BYTES) break;
                out.write(buffer, 0, read);
            }
            return out.toString("UTF-8");
        }
    }

    private static String resolveEntryPath(PairUrl target, String href) {
        String fallback = target.defaultEntryPath();
        if (href == null || href.isEmpty()) return fallback;
        try {
            URI base = new URI(target.url);
            URI resolved = base.resolve(href);
            if (resolved.isOpaque()) return fallback;
            String host = resolved.getHost();
            if (host == null || !host.equalsIgnoreCase(target.host)) return fallback;
            if (effectivePort(resolved) != effectivePort(base)) return fallback;
            String path = resolved.getRawPath();
            if (path == null || !path.startsWith("/")) return fallback;
            String query = resolved.getRawQuery();
            return query == null || query.isEmpty() ? path : path + "?" + query;
        } catch (Exception e) {
            return fallback;
        }
    }

    private static int effectivePort(URI uri) {
        if (uri.getPort() > 0) return uri.getPort();
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if ("https".equals(scheme)) return 443;
        if ("http".equals(scheme)) return 80;
        return -1;
    }
}
