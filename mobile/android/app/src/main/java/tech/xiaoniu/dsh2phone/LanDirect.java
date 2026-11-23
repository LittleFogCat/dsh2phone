package tech.xiaoniu.dsh2phone;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 局域网直连：电脑端 tunnel 会在同一局域网内开一个 HTTPS 反向代理（自签证书），
 * relay 把它的地址与证书 SHA-256 指纹（DER）转介给已配对设备。App 在进入 DSH
 * 前探测，可达则以直连地址进入（锁定指纹），否则照旧走公网中继。
 *
 * 信任模型：直连目标身份不由系统证书链保证，而由“relay 经设备门禁下发的指纹”
 * 保证——指纹匹配才连接，指纹不匹配立即回落公网。因此这里不复用 Tls.allow()
 * 的“全部信任”，也受 network_security_config 的 HTTPS-only 约束。
 *
 * 直连边缘与公网链路的 nginx 行为一致（Host 重写为 DSH authority、剥离 Origin），
 * 同一份 cookie 在两条链路都有效；区别是直连地址的根就是 DSH 根（没有 /dsh/ 前缀）。
 */
public final class LanDirect {
    /** relay 数据面信息端点；公网 URL 是 origin + /dsh/dsh-lan（nginx 剥离 /dsh/ 前缀）。 */
    public static final String INFO_PATH = "/dsh/dsh-lan";
    /** 直连边缘的免认证探活端点。 */
    public static final String HELLO_PATH = "/dsh2phone-lan-hello";
    private static final String HELLO_MARK = "\"dsh2phone-lan\"";
    private static final int MAX_INFO_BYTES = 64 * 1024;
    private static final int MAX_HELLO_BYTES = 8 * 1024;

    /** 一次可用的直连入口：origin（https://ip:port）+ 证书指纹。 */
    public static final class Direct {
        public final String origin;
        public final String fp;

        public Direct(String origin, String fp) {
            this.origin = origin;
            this.fp = fp;
        }
    }

    /** relay /dsh-lan 响应里的直连候选。 */
    public static final class Info {
        public final int port;
        public final String fp;
        public final List<String> ips;

        Info(int port, String fp, List<String> ips) {
            this.port = port;
            this.fp = fp;
            this.ips = ips;
        }
    }

    private LanDirect() {
    }

    // ---------- 纯逻辑（单测覆盖） ----------

    /** 归一化指纹：小写 hex、去冒号/空格；非法返回 null。 */
    public static String normalizeFp(String raw) {
        if (raw == null) return null;
        String s = raw.trim().toLowerCase(Locale.ROOT).replace(":", "").replace(" ", "");
        if (s.length() != 64) return null;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) return null;
        }
        return s;
    }

    /** 由 ip + 端口拼直连 origin；IPv6 自动加方括号。非法输入返回 null。 */
    public static String originFor(String ip, int port) {
        if (ip == null) return null;
        String host = ip.trim();
        if (host.isEmpty() || host.length() > 45 || port < 1 || port > 65535) return null;
        if (host.contains(":") && !host.startsWith("[")) host = "[" + host + "]";
        return "https://" + host + ":" + port;
    }

    /**
     * 解析 relay /dsh-lan 响应体。结构非法或 lan=null（电脑端没有通告直连边缘）
     * 都返回 null，调用方按“无直连”处理。
     */
    public static Info parseInfo(String body) {
        if (body == null) return null;
        try {
            Object root = MiniJson.parse(body);
            if (!(root instanceof Map)) return null;
            Object lan = ((Map<?, ?>) root).get("lan");
            if (!(lan instanceof Map)) return null;
            Map<?, ?> lanMap = (Map<?, ?>) lan;
            Object portObj = lanMap.get("port");
            Object fpObj = lanMap.get("fp");
            Object ipsObj = lanMap.get("ips");
            if (!(portObj instanceof Long) || !(fpObj instanceof String) || !(ipsObj instanceof List)) return null;
            int port = (int) (long) (Long) portObj;
            String fp = normalizeFp((String) fpObj);
            List<String> ips = new ArrayList<>();
            for (Object entry : (List<?>) ipsObj) {
                if (ips.size() >= 8) break;
                String ip = String.valueOf(entry == null ? "" : entry).trim().toLowerCase(Locale.ROOT);
                if (!ip.isEmpty() && ip.length() <= 45) ips.add(ip);
            }
            if (port < 1 || port > 65535 || fp == null || ips.isEmpty()) return null;
            return new Info(port, fp, ips);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 极小 JSON 解析器：只服务于 relay /dsh-lan 的小响应。不用 org.json，
     * 因为它在 JVM 单元测试里是 stub（返回默认值/抛异常），纯 Java 手写才可测。
     */
    private static final class MiniJson {
        private final String s;
        private int i;

        private MiniJson(String s) {
            this.s = s;
        }

        static Object parse(String text) {
            MiniJson parser = new MiniJson(text);
            parser.ws();
            Object value = parser.value();
            parser.ws();
            if (parser.i < parser.s.length()) throw new IllegalArgumentException("trailing content");
            return value;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        private char peek() {
            if (i >= s.length()) throw new IllegalArgumentException("unexpected end");
            return s.charAt(i);
        }

        private Object value() {
            char c = peek();
            switch (c) {
                case '{':
                    return object();
                case '[':
                    return array();
                case '"':
                    return string();
                case 't':
                    expect("true");
                    return Boolean.TRUE;
                case 'f':
                    expect("false");
                    return Boolean.FALSE;
                case 'n':
                    expect("null");
                    return null;
                default:
                    return number();
            }
        }

        private Map<String, Object> object() {
            expectChar('{');
            Map<String, Object> out = new LinkedHashMap<>();
            ws();
            if (peek() == '}') {
                i++;
                return out;
            }
            while (true) {
                ws();
                String key = string();
                ws();
                if (peek() != ':') throw new IllegalArgumentException("expected :");
                i++;
                ws();
                out.put(key, value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == '}') {
                    i++;
                    return out;
                }
                throw new IllegalArgumentException("expected , or }");
            }
        }

        private List<Object> array() {
            expectChar('[');
            List<Object> out = new ArrayList<>();
            ws();
            if (peek() == ']') {
                i++;
                return out;
            }
            while (true) {
                ws();
                out.add(value());
                ws();
                char c = peek();
                if (c == ',') {
                    i++;
                    continue;
                }
                if (c == ']') {
                    i++;
                    return out;
                }
                throw new IllegalArgumentException("expected , or ]");
            }
        }

        private String string() {
            if (peek() != '"') throw new IllegalArgumentException("expected string");
            i++;
            StringBuilder sb = new StringBuilder();
            while (true) {
                if (i >= s.length()) throw new IllegalArgumentException("unterminated string");
                char c = s.charAt(i++);
                if (c == '"') return sb.toString();
                if (c == '\\') {
                    if (i >= s.length()) throw new IllegalArgumentException("bad escape");
                    char e = s.charAt(i++);
                    switch (e) {
                        case '"': sb.append('"'); break;
                        case '\\': sb.append('\\'); break;
                        case '/': sb.append('/'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'n': sb.append('\n'); break;
                        case 'r': sb.append('\r'); break;
                        case 't': sb.append('\t'); break;
                        case 'u':
                            if (i + 4 > s.length()) throw new IllegalArgumentException("bad \\u escape");
                            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default:
                            throw new IllegalArgumentException("bad escape \\" + e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        private Object number() {
            int start = i;
            if (i < s.length() && (s.charAt(i) == '-' || s.charAt(i) == '+')) i++;
            boolean digits = false;
            while (i < s.length()) {
                char c = s.charAt(i);
                if (c >= '0' && c <= '9') {
                    digits = true;
                    i++;
                } else if (c == '.' || c == 'e' || c == 'E' || c == '-' || c == '+') {
                    i++;
                } else {
                    break;
                }
            }
            if (!digits) throw new IllegalArgumentException("bad number");
            try {
                return Long.parseLong(s.substring(start, i));
            } catch (NumberFormatException e) {
                return Double.parseDouble(s.substring(start, i));
            }
        }

        private void expect(String word) {
            if (!s.startsWith(word, i)) throw new IllegalArgumentException("expected " + word);
            i += word.length();
        }

        private void expectChar(char c) {
            if (peek() != c) throw new IllegalArgumentException("expected " + c);
            i++;
        }
    }

    /** 证书 DER 的 SHA-256 是否等于指纹（WebApp 的 SslError 校验也用它）。 */
    public static boolean certMatchesFp(X509Certificate certificate, String fp) {
        if (certificate == null || fp == null) return false;
        try {
            return fp.equalsIgnoreCase(sha256Hex(certificate.getEncoded()));
        } catch (Exception e) {
            return false;
        }
    }

    public static String sha256Hex(byte[] data) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] out = digest.digest(data);
        StringBuilder sb = new StringBuilder(out.length * 2);
        for (byte b : out) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    // ---------- 网络流程 ----------

    /**
     * 解析直连入口：
     * 1. 缓存地址（上次成功会话）用很短的超时并行快探，命中优先（避免在多个网卡地址间跳动）；
     * 2. 向 relay 查询候选（公网链路），逐个短超时探测。
     * 任何一步失败都返回 null（走公网）。预算：缓存 500ms、候选 800ms、查询 2500ms。
     */
    public static Direct resolve(Pairing pairing, String cachedOrigin, String cachedFp,
                                 int cachedProbeMs, int probeMs, int infoTimeoutMs) {
        final String fp = normalizeFp(cachedFp);
        final boolean tryCached = cachedOrigin != null && fp != null && cachedOrigin.startsWith("https://");
        final Direct[] cachedHit = new Direct[1];
        Thread cachedThread = null;
        if (tryCached) {
            cachedThread = new Thread(() -> {
                if (probe(cachedOrigin, fp, cachedProbeMs)) {
                    cachedHit[0] = new Direct(cachedOrigin, fp);
                }
            }, "dsh2phone-lan-cached");
            cachedThread.setDaemon(true);
            cachedThread.start();
        }
        Info info = fetchInfo(pairing, infoTimeoutMs);
        Direct fromInfo = null;
        if (info != null) {
            for (String ip : info.ips) {
                String origin = originFor(ip, info.port);
                if (origin != null && probe(origin, info.fp, probeMs)) {
                    fromInfo = new Direct(origin, info.fp);
                    break;
                }
            }
        }
        if (tryCached) {
            try {
                cachedThread.join(cachedProbeMs + 1000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        return cachedHit[0] != null ? cachedHit[0] : fromInfo;
    }

    /**
     * 探活一个直连地址：GET 免认证 hello，证书按指纹锁定（不匹配直接抛异常），
     * 200 且服务标识匹配才算可达。
     */
    public static boolean probe(String origin, String fp, int timeoutMs) {
        if (origin == null || fp == null) return false;
        HttpsURLConnection conn = null;
        try {
            URL url = new URL(origin + HELLO_PATH);
            conn = (HttpsURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", "dsh2phone-lan-probe");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Connection", "close");
            pinFingerprint(conn, fp);
            int status = conn.getResponseCode();
            if (status != 200) return false;
            String body = readAll(conn.getInputStream(), MAX_HELLO_BYTES);
            return body.contains(HELLO_MARK);
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // 尽力而为。
                }
            }
        }
    }

    /** 给连接装上“只信任这张证书”的 SSLSocketFactory；主机名校验由指纹代替。 */
    public static void pinFingerprint(HttpsURLConnection conn, final String fp) throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0 || !certMatchesFp(chain[0], fp)) {
                    throw new CertificateException("certificate fingerprint mismatch");
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }}, new SecureRandom());
        conn.setSSLSocketFactory(context.getSocketFactory());
        HostnameVerifier pinInsteadOfName = (hostname, session) -> true;
        conn.setHostnameVerifier(pinInsteadOfName);
    }

    /** 向 relay 查询直连候选（走公网链路，带设备 cookie 过门禁）。 */
    private static Info fetchInfo(Pairing pairing, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(pairing.origin + INFO_PATH).openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", "dsh2phone-lan");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Accept-Encoding", "identity");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Connection", "close");
            String cookie = pairing.cookieHeader();
            if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            if (pairing.allowBadCert && conn instanceof HttpsURLConnection) {
                Tls.allow((HttpsURLConnection) conn);
            }
            int status = conn.getResponseCode();
            if (status != 200) return null;
            // 旧 relay 没有该端点：请求会被转发给 DSH 并返回它的 404/HTML，解析失败即视为无直连。
            return parseInfo(readAll(conn.getInputStream(), MAX_INFO_BYTES));
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // 尽力而为。
                }
            }
        }
    }

    private static String readAll(InputStream input, int limit) throws IOException {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > limit) break;
                out.write(buffer, 0, read);
            }
            return out.toString("UTF-8");
        }
    }
}
