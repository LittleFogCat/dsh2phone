package tech.xiaoniu.dsh2phone;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** 一次成功配对的本机快照。origin + 两枚 cookie 就足以进入 DSH。 */
public final class Pairing {
    public final String origin;
    public final String pairPath;
    public final String entryPath;
    public final String deviceName;
    public final long pairedAt;
    public final List<Cookie> cookies;
    public final boolean allowBadCert;

    public Pairing(String origin, String pairPath, String entryPath, String deviceName,
                   long pairedAt, List<Cookie> cookies, boolean allowBadCert) {
        this.origin = origin;
        this.pairPath = (pairPath == null || pairPath.isEmpty()) ? "/dsh-pair" : pairPath;
        this.entryPath = normalizeEntry(entryPath);
        this.deviceName = (deviceName == null || deviceName.isEmpty()) ? "此设备" : deviceName;
        this.pairedAt = pairedAt;
        this.cookies = Collections.unmodifiableList(new ArrayList<>(cookies));
        this.allowBadCert = allowBadCert;
    }

    public String pairUrl() {
        return origin + pairPath;
    }

    public String entryUrl() {
        return origin + entryPath;
    }

    public String dshDevValue() {
        for (Cookie c : cookies) {
            if ("dshdev".equals(c.name) && !c.isExpired()) return c.value;
        }
        return null;
    }

    public String cookieHeader() {
        StringBuilder sb = new StringBuilder();
        long now = System.currentTimeMillis();
        for (Cookie c : cookies) {
            if (c.isExpired(now)) continue;
            if (sb.length() > 0) sb.append("; ");
            sb.append(c.toPair());
        }
        return sb.toString();
    }

    public Pairing withAllowBadCert(boolean allow) {
        return new Pairing(origin, pairPath, entryPath, deviceName, pairedAt, cookies, allow);
    }

    private static String normalizeEntry(String path) {
        if (path == null || path.isEmpty()) return "/dsh/";
        if (!path.startsWith("/")) return "/" + path;
        return path;
    }
}
