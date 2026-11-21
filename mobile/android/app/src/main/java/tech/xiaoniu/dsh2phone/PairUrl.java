package tech.xiaoniu.dsh2phone;

import java.net.URI;
import java.net.URISyntaxException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 二维码 / 粘贴链接的唯一校验入口。只接受 http(s) 的配对地址，且必须带 code。
 * HTTP 仅在 debug 包的本机地址上允许，正式包一律要求 HTTPS。
 */
public final class PairUrl {
    public enum Error {
        EMPTY,
        MALFORMED,
        BAD_SCHEME,
        HTTPS_REQUIRED,
        USERINFO,
        BAD_HOST,
        BAD_PATH,
        MISSING_CODE,
        BAD_CODE,
    }

    public static final class Invalid extends Exception {
        public final Error error;

        Invalid(Error error) {
            super(error.name());
            this.error = error;
        }
    }

    public final String url;
    public final String origin;
    public final String host;
    public final int port;
    public final String scheme;
    public final String pairPath;
    public final String code;

    private PairUrl(String url, String origin, String host, int port, String scheme,
                    String pairPath, String code) {
        this.url = url;
        this.origin = origin;
        this.host = host;
        this.port = port;
        this.scheme = scheme;
        this.pairPath = pairPath;
        this.code = code;
    }

    public boolean isInsecure() {
        return "http".equals(scheme);
    }

    /** 没有从入口页解析到 href 时的兜底路径。 */
    public String defaultEntryPath() {
        String path = pairPath;
        if (path.endsWith("/dsh-pair")) {
            return path.substring(0, path.length() - "dsh-pair".length()) + "dsh/";
        }
        return "/dsh/";
    }

    public static PairUrl parse(String raw, boolean allowInsecureLocal) throws Invalid {
        if (raw == null || raw.trim().isEmpty()) throw new Invalid(Error.EMPTY);
        String trimmed = raw.trim();

        URI uri;
        try {
            uri = new URI(trimmed);
        } catch (URISyntaxException e) {
            throw new Invalid(Error.MALFORMED);
        }
        if (uri.isOpaque()) throw new Invalid(Error.MALFORMED);

        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) {
            throw new Invalid(Error.BAD_SCHEME);
        }
        if (uri.getRawUserInfo() != null && !uri.getRawUserInfo().isEmpty()) {
            throw new Invalid(Error.USERINFO);
        }

        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new Invalid(Error.BAD_HOST);
        host = host.toLowerCase(Locale.ROOT);
        // URI.getHost 对 IPv6 可能返回带方括号的形式，统一去掉再拼 origin。
        String bareHost = host.startsWith("[") && host.endsWith("]")
                ? host.substring(1, host.length() - 1) : host;
        int port = uri.getPort();

        if (scheme.equals("http") && !(allowInsecureLocal && isLocalHost(bareHost))) {
            throw new Invalid(Error.HTTPS_REQUIRED);
        }

        String path = uri.getPath();
        if (path == null || path.isEmpty()) throw new Invalid(Error.BAD_PATH);
        boolean isPairPath = path.equals("/dsh-pair") || path.endsWith("/dsh-pair")
                || path.equals("/pair") || path.endsWith("/pair");
        if (!isPairPath) throw new Invalid(Error.BAD_PATH);

        String code = extractCode(uri.getRawQuery());
        if (code == null) throw new Invalid(Error.MISSING_CODE);
        if (code.isEmpty() || code.length() > 512 || hasControl(code)) {
            throw new Invalid(Error.BAD_CODE);
        }

        String hostPart = bareHost.indexOf(':') >= 0 ? "[" + bareHost + "]" : bareHost;
        boolean defaultPort = (scheme.equals("https") && port == 443)
                || (scheme.equals("http") && port == 80);
        String origin = scheme + "://" + hostPart + (port > 0 && !defaultPort ? ":" + port : "");

        String rawPath = uri.getRawPath() == null ? path : uri.getRawPath();
        String url = origin + rawPath
                + (uri.getRawQuery() == null || uri.getRawQuery().isEmpty() ? "" : "?" + uri.getRawQuery());

        return new PairUrl(url, origin, bareHost, port, scheme, path, code);
    }

    private static boolean isLocalHost(String host) {
        return host.equals("localhost")
                || host.equals("127.0.0.1")
                || host.equals("::1")
                || host.equals("10.0.2.2");
    }

    private static String extractCode(String rawQuery) {
        if (rawQuery == null || rawQuery.isEmpty()) return null;
        for (String pair : rawQuery.split("&")) {
            int eq = pair.indexOf('=');
            if (eq < 0) continue;
            String key;
            try {
                key = URLDecoder.decode(pair.substring(0, eq), StandardCharsets.UTF_8.name());
            } catch (Exception e) {
                continue;
            }
            if (!"code".equals(key)) continue;
            try {
                return URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8.name());
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    private static boolean hasControl(String value) {
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch < 0x20 || ch == 0x7f) return true;
        }
        return false;
    }

    public static String displayHost(String host, int port) {
        String h = host;
        if (port > 0) h += ":" + port;
        return h;
    }
}
