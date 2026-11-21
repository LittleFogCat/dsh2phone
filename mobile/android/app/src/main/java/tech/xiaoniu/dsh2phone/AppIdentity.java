package tech.xiaoniu.dsh2phone;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.provider.Settings;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * 稳定 UA：relay 对“没有 dshdev cookie 的新请求”会按 UA 去重，
 * 因此 UA 里带 Android ID 的哈希，既能区分同型号手机，又能在重装后复用同一条设备记录。
 */
public final class AppIdentity {
    private AppIdentity() {
    }

    public static String userAgent(Context context) {
        String version = "1.0.0";
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            if (info.versionName != null) version = info.versionName;
        } catch (Exception ignored) {
            // 版本号拿不到不影响配对。
        }
        String androidId;
        try {
            androidId = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ANDROID_ID);
        } catch (Exception e) {
            androidId = null;
        }
        return build(version, Build.VERSION.RELEASE, Build.MODEL, androidId);
    }

    /** 纯函数，便于 JVM 单测。 */
    public static String build(String version, String release, String model, String androidId) {
        String v = sanitize(version, "1.0.0");
        String os = sanitize(release, "?");
        String m = sanitize(model, "Android");
        String id = androidId == null || androidId.isEmpty() ? "unknown" : androidId;
        String hash = sha256(id).substring(0, 8);
        String ua = "dsh2phone/" + v + " (Android " + os + "; " + m + "; " + hash + ")";
        return ua.length() > 180 ? ua.substring(0, 180) : ua;
    }

    private static String sanitize(String value, String fallback) {
        if (value == null) return fallback;
        String cleaned = value.replaceAll("[^A-Za-z0-9 _.,;:+()\\[\\]\\-]", "").trim();
        cleaned = cleaned.replaceAll("\\s+", " ");
        if (cleaned.isEmpty()) return fallback;
        return cleaned.length() > 48 ? cleaned.substring(0, 48) : cleaned;
    }

    public static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                sb.append(String.format(Locale.US, "%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            return "0000000000000000";
        }
    }
}
