package tech.xiaoniu.dsh2phone;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;
import java.util.regex.Pattern;

/**
 * 解析 Set-Cookie。没有用 HttpCookie：它会丢弃 SameSite/HttpOnly 等属性，
 * 而且对同一条头里合并多个 cookie 的处理并不可靠。
 */
public final class SetCookie {
    private static final Pattern NAME = Pattern.compile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$");
    // 逗号后紧跟 name= 才视为下一枚 cookie；Expires=Wed, 21 Oct... 的逗号不会命中。
    private static final Pattern COMBINED_SPLIT = Pattern.compile(",(?=\\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)");

    private SetCookie() {
    }

    public static List<Cookie> parseHeaders(List<String> headers, String requestHost) {
        List<Cookie> out = new ArrayList<>();
        if (headers == null) return out;
        Map<String, Cookie> byKey = new LinkedHashMap<>();
        long now = System.currentTimeMillis();
        for (String header : headers) {
            if (header == null || header.isEmpty()) continue;
            for (String part : COMBINED_SPLIT.split(header)) {
                Cookie cookie = parse(part, requestHost);
                if (cookie == null || cookie.isExpired(now)) continue;
                // 同名同路径后出现的覆盖前面的（浏览器语义）。
                byKey.put(cookie.name + "|" + cookie.domain + "|" + cookie.path, cookie);
            }
        }
        out.addAll(byKey.values());
        return out;
    }

    public static Cookie parse(String header, String requestHost) {
        if (header == null) return null;
        String raw = header.trim();
        if (raw.isEmpty()) return null;

        List<String> parts = splitAttributes(raw);
        if (parts.isEmpty()) return null;

        String first = parts.get(0).trim();
        int eq = first.indexOf('=');
        if (eq <= 0) return null;
        String name = first.substring(0, eq).trim();
        if (!NAME.matcher(name).matches()) return null;

        String value = first.substring(eq + 1).trim();
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1);
        }
        if (containsControl(value) || value.indexOf(';') >= 0) return null;

        boolean secure = false;
        boolean httpOnly = false;
        String domain = "";
        String path = "/";
        String sameSite = null;
        long maxAge = -1;
        long expiresAt = -1;

        for (int i = 1; i < parts.size(); i++) {
            String attr = parts.get(i).trim();
            if (attr.isEmpty()) continue;
            int at = attr.indexOf('=');
            String key = (at < 0 ? attr : attr.substring(0, at)).trim().toLowerCase(Locale.ROOT);
            String val = at < 0 ? "" : attr.substring(at + 1).trim();
            switch (key) {
                case "domain":
                    domain = val.startsWith(".") ? val.substring(1) : val;
                    domain = domain.toLowerCase(Locale.ROOT);
                    break;
                case "path":
                    if (val.startsWith("/")) path = val;
                    break;
                case "max-age":
                    try {
                        maxAge = Long.parseLong(val);
                    } catch (NumberFormatException ignored) {
                        // 忽略非法值，保留 Expires 语义。
                    }
                    break;
                case "expires":
                    expiresAt = parseHttpDate(val);
                    break;
                case "secure":
                    secure = true;
                    break;
                case "httponly":
                    httpOnly = true;
                    break;
                case "samesite":
                    if ("strict".equalsIgnoreCase(val)) sameSite = "Strict";
                    else if ("lax".equalsIgnoreCase(val)) sameSite = "Lax";
                    else if ("none".equalsIgnoreCase(val)) sameSite = "None";
                    break;
                default:
                    break;
            }
        }

        String host = requestHost == null ? "" : requestHost.toLowerCase(Locale.ROOT);
        if (!domain.isEmpty()) {
            // 只接受属于请求主机的 Domain，避免恶意服务器给别的站点写 cookie。
            boolean match = host.equals(domain) || host.endsWith("." + domain);
            if (!match) return null;
        }

        // Max-Age 是相对时间。存盘后没有“收到时间”，所以在解析时折算成绝对过期时间。
        if (expiresAt < 0 && maxAge > 0) {
            expiresAt = System.currentTimeMillis() + maxAge * 1000L;
        }

        return new Cookie(name, value, domain, path, secure, httpOnly, sameSite, maxAge, expiresAt);
    }

    /** 按分号切分，但引号里的分号不切。 */
    private static List<String> splitAttributes(String raw) {
        List<String> parts = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < raw.length(); i++) {
            char ch = raw.charAt(i);
            if (ch == '"') quoted = !quoted;
            if (ch == ';' && !quoted) {
                parts.add(current.toString());
                current.setLength(0);
                continue;
            }
            current.append(ch);
        }
        parts.add(current.toString());
        return parts;
    }

    private static boolean containsControl(String value) {
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '\r' || ch == '\n' || ch == 0) return true;
        }
        return false;
    }

    private static long parseHttpDate(String value) {
        String[] patterns = {
                "EEE, dd MMM yyyy HH:mm:ss zzz",
                "EEE, dd-MMM-yyyy HH:mm:ss zzz",
                "EEE, dd MMM yyyy HH:mm:ss Z",
                "yyyy-MM-dd'T'HH:mm:ss'Z'",
        };
        for (String pattern : patterns) {
            try {
                SimpleDateFormat fmt = new SimpleDateFormat(pattern, Locale.US);
                fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
                fmt.setLenient(false);
                return fmt.parse(value).getTime();
            } catch (ParseException ignored) {
                // 尝试下一种格式。
            }
        }
        return -1;
    }
}
