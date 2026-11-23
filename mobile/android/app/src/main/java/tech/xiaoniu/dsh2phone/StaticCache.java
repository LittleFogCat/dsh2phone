package tech.xiaoniu.dsh2phone;

import android.content.Context;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;

/**
 * 页面静态资源的 App 侧磁盘缓存。
 *
 * 为什么不用 WebView 自带的 HTTP 缓存：部分机型/系统清理策略下 WebView 磁盘缓存不生效，
 * 每次冷启动都会重新下载 2.5 MB。这里按「完整 URL（含 rev）」做键，自己在 filesDir 里存一份，
 * DSH 升级后 rev 变化 → URL 变化 → 自动 miss；再配合 TTL 与 LRU 兜底。
 *
 * 只存静态资源（JS/CSS/字体/图片），不存 HTML、API、SSE、WebSocket。
 */
final class StaticCache {
    static final long DEFAULT_MAX_BYTES = 64L * 1024 * 1024;
    static final long DEFAULT_TTL_MS = 30L * 24 * 60 * 60 * 1000;

    private final File dir;
    private final long maxBytes;
    private final long ttlMs;

    StaticCache(Context context) {
        this(context.getFilesDir(), DEFAULT_MAX_BYTES, DEFAULT_TTL_MS);
    }

    StaticCache(File baseDir, long maxBytes) {
        this(baseDir, maxBytes, DEFAULT_TTL_MS);
    }

    StaticCache(File baseDir, long maxBytes, long ttlMs) {
        this.dir = new File(baseDir, "webcache");
        this.maxBytes = Math.max(1024, maxBytes);
        this.ttlMs = Math.max(0, ttlMs);
        // 目录创建失败时后续 put 会失败，读取则直接 miss，不影响页面加载。
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
    }

    static final class Entry {
        final File file;
        final String mime;
        final long size;

        Entry(File file, String mime, long size) {
            this.file = file;
            this.mime = mime;
            this.size = size;
        }
    }

    synchronized Entry get(String url) {
        File data = dataFile(url);
        File meta = metaFile(url);
        if (!data.isFile() || data.length() == 0 || !meta.isFile()) return null;
        String[] parsed = readMeta(meta);
        if (parsed == null) {
            delete(url);
            return null;
        }
        long fetchedAt;
        try {
            fetchedAt = Long.parseLong(parsed[1]);
        } catch (NumberFormatException e) {
            delete(url);
            return null;
        }
        if (ttlMs > 0 && System.currentTimeMillis() - fetchedAt > ttlMs) {
            delete(url);
            return null;
        }
        // 用 lastModified 记录最近访问，LRU 淘汰时按它排序。
        //noinspection ResultOfMethodCallIgnored
        data.setLastModified(System.currentTimeMillis());
        return new Entry(data, parsed[0], data.length());
    }

    synchronized void put(String url, String mime, byte[] body) {
        if (body == null || body.length == 0 || mime == null || mime.isEmpty()) return;
        if (!dir.isDirectory() && !dir.mkdirs()) return;
        File data = dataFile(url);
        File tmp = new File(dir, data.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(body);
            out.flush();
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(data)) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return;
        }
        writeMeta(metaFile(url), mime, System.currentTimeMillis());
        trim();
    }

    synchronized void clear() {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
    }

    synchronized long sizeBytes() {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".bin"));
        if (files == null) return 0;
        long total = 0;
        for (File file : files) total += file.length();
        return total;
    }

    synchronized int count() {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".bin"));
        return files == null ? 0 : files.length;
    }

    private void trim() {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".bin"));
        if (files == null || files.length == 0) return;
        long total = 0;
        for (File file : files) total += file.length();
        if (total <= maxBytes) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            if (total <= maxBytes) break;
            long length = file.length();
            if (file.delete()) {
                String name = file.getName();
                File meta = new File(dir, name.substring(0, name.length() - 4) + ".meta");
                //noinspection ResultOfMethodCallIgnored
                meta.delete();
                total -= length;
            }
        }
    }

    private void delete(String url) {
        //noinspection ResultOfMethodCallIgnored
        dataFile(url).delete();
        //noinspection ResultOfMethodCallIgnored
        metaFile(url).delete();
    }

    private File dataFile(String url) {
        return new File(dir, sha256(url) + ".bin");
    }

    private File metaFile(String url) {
        return new File(dir, sha256(url) + ".meta");
    }

    private static String[] readMeta(File file) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String mime = reader.readLine();
            String fetchedAt = reader.readLine();
            if (mime == null || mime.isEmpty() || fetchedAt == null) return null;
            return new String[]{mime, fetchedAt};
        } catch (IOException e) {
            return null;
        }
    }

    private static void writeMeta(File file, String mime, long fetchedAt) {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write((mime + "\n" + fetchedAt + "\n").getBytes(StandardCharsets.UTF_8));
        } catch (IOException ignored) {
            // 元数据写失败时下次 get 会当作 miss，不影响主流程。
        }
    }

    private static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            // SHA-256 一定存在；这里只做兜底。
            return Integer.toHexString(value.hashCode());
        }
    }

    static byte[] readAll(InputStream input, int limit) throws IOException {
        try (InputStream in = input; ByteArrayOutputStream out = new ByteArrayOutputStream(8192)) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total > limit) return null;
                out.write(buffer, 0, read);
            }
            return out.toByteArray();
        }
    }
}
