package tech.xiaoniu.dsh2phone;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 服务器下发的一枚 cookie。这里刻意保留 HttpOnly / SameSite / Domain 等属性：
 * 配对成功后要原样注入 WebView，属性丢失会让 DSH 的 Strict cookie 或 relay 的设备 cookie 失效。
 */
public final class Cookie {
    public final String name;
    public final String value;
    public final String domain;
    public final String path;
    public final boolean secure;
    public final boolean httpOnly;
    public final String sameSite;
    /** Max-Age 秒数；-1 表示未提供。 */
    public final long maxAge;
    /** Expires 的 epoch 毫秒；-1 表示未提供。 */
    public final long expiresAt;

    public Cookie(String name, String value, String domain, String path, boolean secure,
                  boolean httpOnly, String sameSite, long maxAge, long expiresAt) {
        this.name = name;
        this.value = value;
        this.domain = domain == null ? "" : domain;
        this.path = (path == null || path.isEmpty()) ? "/" : path;
        this.secure = secure;
        this.httpOnly = httpOnly;
        this.sameSite = sameSite;
        this.maxAge = maxAge;
        this.expiresAt = expiresAt;
    }

    public boolean isExpired() {
        return isExpired(System.currentTimeMillis());
    }

    public boolean isExpired(long now) {
        // Max-Age 的绝对时间在解析时已经折算进 expiresAt；这里只认绝对时间，
        // 否则存了几天之后仍会把 30 天有效期的 cookie 当成永不过期。
        if (maxAge == 0) return true;
        return expiresAt >= 0 && expiresAt <= now;
    }

    /** 用于写回 CookieManager / WebView 的 Set-Cookie 形式。 */
    public String toHeaderValue() {
        StringBuilder sb = new StringBuilder();
        sb.append(name).append('=').append(value);
        if (!path.isEmpty()) sb.append("; Path=").append(path);
        if (!domain.isEmpty()) sb.append("; Domain=").append(domain);
        if (maxAge >= 0) sb.append("; Max-Age=").append(maxAge);
        if (expiresAt >= 0) {
            SimpleDateFormat fmt = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US);
            fmt.setTimeZone(TimeZone.getTimeZone("GMT"));
            sb.append("; Expires=").append(fmt.format(new Date(expiresAt)));
        }
        if (secure) sb.append("; Secure");
        if (httpOnly) sb.append("; HttpOnly");
        if (sameSite != null && !sameSite.isEmpty()) sb.append("; SameSite=").append(sameSite);
        return sb.toString();
    }

    /** 只保留 name=value，用于手工拼 Cookie 请求头。 */
    public String toPair() {
        return name + "=" + value;
    }
}
