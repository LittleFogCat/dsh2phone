package tech.xiaoniu.dsh2phone;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import com.google.android.material.dialog.MaterialAlertDialogBuilder;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

import javax.net.ssl.HttpsURLConnection;

/**
 * 极简自动升级：进入主页时读取同源 /dsh2phone/latest.json，versionCode 更大就提示，
 * 原生下载（沿用配对时的证书策略）→ SHA-256 校验 → FileProvider 交给系统安装器。
 *
 * latest.json:
 * { "versionCode": 2, "versionName": "1.1.0",
 *   "apkUrl": "dsh2phone-1.1.0-release.apk", "sha256": "...", "size": 1687000,
 *   "notes": "..." }
 */
final class UpdateManager {
    private static final String MANIFEST_PATH = "/dsh2phone/latest.json";
    private static final int MAX_MANIFEST_BYTES = 64 * 1024;

    private static final long AUTO_CHECK_COOLDOWN_MS = 15_000;
    private static final int MAX_AUTO_RETRIES = 2;

    private static long lastAutoCheckAt;
    private static int autoRetries;
    private static boolean checking;

    private UpdateManager() {
    }

    static final class Info {
        final long versionCode;
        final String versionName;
        final String apkUrl;
        final String sha256;
        final long size;
        final String notes;

        Info(long versionCode, String versionName, String apkUrl, String sha256, long size, String notes) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.apkUrl = apkUrl;
            this.sha256 = sha256 == null ? "" : sha256.trim().toLowerCase(Locale.ROOT);
            this.size = size;
            this.notes = notes == null ? "" : notes;
        }
    }

    static void check(Activity activity, Pairing pairing, boolean manual) {
        if (activity == null || activity.isFinishing()) return;
        if (pairing == null) {
            if (manual) toast(activity, R.string.update_no_pairing);
            return;
        }
        if (checking) {
            if (manual) toast(activity, R.string.update_checking);
            return;
        }
        // 不能只在“进程首次”检查：App 可能长时间留在后台，用户再次进入时
        // 已经错过新版本。用 60s 冷却，并在失败时自动重试（手动检查不受限）。
        long now = SystemClock.elapsedRealtime();
        if (!manual && now - lastAutoCheckAt < AUTO_CHECK_COOLDOWN_MS) return;
        if (!manual) lastAutoCheckAt = now;
        checking = true;
        if (manual) toast(activity, R.string.update_checking);

        final String manifestUrl = pairing.origin + MANIFEST_PATH;
        new Thread(() -> {
            try {
                Info info = fetch(activity, pairing, manifestUrl);
                activity.runOnUiThread(() -> {
                    checking = false;
                    autoRetries = 0;
                    lastAutoCheckAt = SystemClock.elapsedRealtime();
                    if (isDead(activity)) return;
                    if (info == null) {
                        if (manual) toast(activity, R.string.update_latest);
                        return;
                    }
                    prompt(activity, pairing, info);
                });
            } catch (Exception e) {
                activity.runOnUiThread(() -> {
                    checking = false;
                    // 自动检查失败后允许下一次 resume 或 3s 后重试；不把失败当成“已检查”。
                    lastAutoCheckAt = 0;
                    if (manual && !isDead(activity)) {
                        toast(activity, activity.getString(R.string.update_failed, shortMessage(e)));
                    } else if (!manual && autoRetries < MAX_AUTO_RETRIES && !isDead(activity)) {
                        autoRetries++;
                        activity.getWindow().getDecorView().postDelayed(
                                () -> check(activity, pairing, false), 3000);
                    }
                });
            }
        }, "dsh2phone-update-check").start();
    }

    private static Info fetch(Activity activity, Pairing pairing, String manifestUrl) throws Exception {
        HttpURLConnection conn = open(activity, pairing, manifestUrl, "application/json");
        try {
            int status = conn.getResponseCode();
            if (status != 200) throw new IOException("HTTP " + status);
            String body = readText(conn.getInputStream(), MAX_MANIFEST_BYTES);
            JSONObject json = new JSONObject(body);
            long remoteCode = json.optLong("versionCode", 0);
            long localCode = localVersionCode(activity);
            if (remoteCode <= localCode) return null;

            String apk = json.optString("apkUrl", "").trim();
            if (apk.isEmpty()) throw new IOException("apkUrl missing");
            URL manifest = new URL(manifestUrl);
            URL apkUrl = new URL(manifest, apk);
            if (!sameOrigin(manifest, apkUrl)) throw new IOException("apkUrl must be same origin");
            String versionName = json.optString("versionName", String.valueOf(remoteCode));
            String sha = json.optString("sha256", "").trim();
            if (sha.isEmpty()) throw new IOException("sha256 missing");
            long size = json.optLong("size", 0);
            String notes = json.optString("notes", "");
            return new Info(remoteCode, versionName, apkUrl.toString(), sha, size, notes);
        } finally {
            conn.disconnect();
        }
    }

    private static void prompt(Activity activity, Pairing pairing, Info info) {
        String notes = info.notes.isEmpty()
                ? activity.getString(R.string.update_notes_default) : info.notes;
        if (info.size > 0) {
            notes += "\n" + String.format(Locale.US, "%.1f MB", info.size / 1048576.0);
        }
        new MaterialAlertDialogBuilder(activity)
                .setTitle(activity.getString(R.string.update_title, info.versionName))
                .setMessage(activity.getString(R.string.update_message, notes))
                .setNegativeButton(R.string.update_later, null)
                .setPositiveButton(R.string.update_download,
                        (dialog, which) -> download(activity, pairing, info))
                .show();
    }

    private static void download(Activity activity, Pairing pairing, Info info) {
        File dir = new File(activity.getFilesDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) {
            toast(activity, activity.getString(R.string.update_failed, "mkdirs"));
            return;
        }
        File target = new File(dir, "update-" + info.versionCode + ".apk");
        if (target.isFile() && verifyFile(target, info)) {
            install(activity, target);
            return;
        }
        File tmp = new File(dir, target.getName() + ".tmp");

        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (20 * activity.getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);
        TextView label = new TextView(activity);
        label.setText(activity.getString(R.string.update_progress, 0));
        ProgressBar bar = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        bar.setMax(100);
        bar.setProgress(0);
        if (info.size <= 0) bar.setIndeterminate(true);
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        barParams.topMargin = pad / 2;
        box.addView(label);
        box.addView(bar, barParams);

        AlertDialog dialog = new MaterialAlertDialogBuilder(activity)
                .setTitle(R.string.update_downloading)
                .setView(box)
                .setCancelable(false)
                .show();

        new Thread(() -> {
            try {
                downloadTo(activity, pairing, info, tmp, bar, label);
                if (info.size > 0 && tmp.length() != info.size) {
                    throw new IOException("size mismatch");
                }
                if (!info.sha256.isEmpty() && !sha256(tmp).equalsIgnoreCase(info.sha256)) {
                    throw new IOException("sha256 mismatch");
                }
                if (target.exists() && !target.delete()) throw new IOException("delete old apk");
                if (!tmp.renameTo(target)) throw new IOException("rename apk");
                activity.runOnUiThread(() -> {
                    dismiss(dialog);
                    if (!isDead(activity)) install(activity, target);
                });
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                tmp.delete();
                activity.runOnUiThread(() -> {
                    dismiss(dialog);
                    if (!isDead(activity)) {
                        toast(activity, activity.getString(R.string.update_failed, shortMessage(e)));
                    }
                });
            }
        }, "dsh2phone-update-download").start();
    }

    private static void downloadTo(Activity activity, Pairing pairing, Info info, File tmp,
                                   ProgressBar bar, TextView label) throws Exception {
        HttpURLConnection conn = open(activity, pairing, info.apkUrl, "application/octet-stream");
        try {
            int status = conn.getResponseCode();
            if (status != 200) throw new IOException("HTTP " + status);
            long total = info.size > 0 ? info.size : conn.getContentLength();
            try (InputStream in = conn.getInputStream();
                 OutputStream out = new FileOutputStream(tmp)) {
                byte[] buffer = new byte[16 * 1024];
                long readTotal = 0;
                int lastPercent = -1;
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    readTotal += read;
                    if (total > 0) {
                        int percent = (int) Math.min(100, readTotal * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            final int p = percent;
                            activity.runOnUiThread(() -> {
                                label.setText(activity.getString(R.string.update_progress, p));
                                bar.setProgress(p);
                            });
                        }
                    }
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    private static void install(Activity activity, File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            new MaterialAlertDialogBuilder(activity)
                    .setTitle(R.string.update_install_permission_title)
                    .setMessage(R.string.update_install_permission_body)
                    .setNegativeButton(R.string.action_cancel, null)
                    .setPositiveButton(R.string.update_install_permission_action, (d, w) -> {
                        try {
                            // 从系统设置返回时 MainActivity 会重新 onResume，允许再检查一次；
                            // 已下载的 APK 会走 install()，不用重新下载。
                            lastAutoCheckAt = 0;
                            autoRetries = 0;
                            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName()));
                            activity.startActivity(intent);
                        } catch (Exception e) {
                            toast(activity, activity.getString(R.string.update_failed, shortMessage(e)));
                        }
                    })
                    .show();
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(activity,
                    activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            toast(activity, R.string.update_install_opening);
        } catch (Exception e) {
            toast(activity, activity.getString(R.string.update_failed, shortMessage(e)));
        }
    }

    private static HttpURLConnection open(Activity activity, Pairing pairing, String url, String accept)
            throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        conn.setUseCaches(false);
        conn.setRequestProperty("User-Agent", AppIdentity.userAgent(activity));
        conn.setRequestProperty("Accept", accept);
        conn.setRequestProperty("Accept-Encoding", "identity");
        conn.setRequestProperty("Cache-Control", "no-cache");
        if (conn instanceof HttpsURLConnection && pairing.allowBadCert) {
            Tls.allow((HttpsURLConnection) conn);
        }
        return conn;
    }

    private static boolean verifyFile(File file, Info info) {
        if (!file.isFile()) return false;
        if (info.size > 0 && file.length() != info.size) return false;
        if (info.sha256.isEmpty()) return true;
        try {
            return sha256(file).equalsIgnoreCase(info.sha256);
        } catch (Exception e) {
            return false;
        }
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : digest.digest()) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    private static long localVersionCode(Activity activity) {
        try {
            PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            return PackageInfoCompat.getLongVersionCode(info);
        } catch (Exception e) {
            return 0;
        }
    }

    private static boolean sameOrigin(URL a, URL b) {
        if (!a.getProtocol().equalsIgnoreCase(b.getProtocol())) return false;
        if (a.getHost() == null || b.getHost() == null
                || !a.getHost().equalsIgnoreCase(b.getHost())) return false;
        return effectivePort(a) == effectivePort(b);
    }

    private static int effectivePort(URL url) {
        if (url.getPort() > 0) return url.getPort();
        return "https".equalsIgnoreCase(url.getProtocol()) ? 443 : 80;
    }

    private static String readText(InputStream input, int limit) throws IOException {
        if (input == null) return "";
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > limit) throw new IOException("manifest too large");
                out.write(buffer, 0, read);
            }
            return out.toString("UTF-8");
        }
    }

    private static void dismiss(AlertDialog dialog) {
        try {
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
        } catch (Exception ignored) {
            // Activity may be gone.
        }
    }

    private static void toast(Activity activity, int res) {
        Toast.makeText(activity, res, Toast.LENGTH_SHORT).show();
    }

    private static void toast(Activity activity, String text) {
        Toast.makeText(activity, text, Toast.LENGTH_SHORT).show();
    }

    private static boolean isDead(Activity activity) {
        return activity.isFinishing() || activity.isDestroyed();
    }

    private static String shortMessage(Exception e) {
        String m = e.getMessage();
        if (m == null || m.trim().isEmpty()) return e.getClass().getSimpleName();
        return m.length() > 180 ? m.substring(0, 180) : m;
    }
}
