package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class StaticCacheTest {
    private File root;

    @Before
    public void setUp() throws Exception {
        root = Files.createTempDirectory("dsh-static-cache").toFile();
    }

    @After
    public void tearDown() {
        delete(root);
    }

    @Test
    public void putAndGetRoundTrip() {
        StaticCache cache = new StaticCache(root, 4096);
        byte[] body = "console.log(1);".getBytes(StandardCharsets.UTF_8);
        String url = "https://example.test/assets/index-abc.js?rev=1";
        cache.put(url, "text/javascript", body);

        StaticCache.Entry entry = cache.get(url);
        assertNotNull(entry);
        assertEquals("text/javascript", entry.mime);
        assertEquals(body.length, entry.size);
        assertTrue(entry.file.isFile());
    }

    @Test
    public void evictsOldestWhenOverLimit() throws Exception {
        StaticCache cache = new StaticCache(root, 1024);
        byte[] body = new byte[800];
        cache.put("https://example.test/assets/a.js", "text/javascript", body);
        Thread.sleep(1100); // 让 lastModified 有可比较的差异（部分文件系统按秒取整）
        cache.put("https://example.test/assets/b.js", "text/javascript", body);

        assertNull(cache.get("https://example.test/assets/a.js"));
        assertNotNull(cache.get("https://example.test/assets/b.js"));
    }

    @Test
    public void expiresAfterTtl() throws Exception {
        StaticCache cache = new StaticCache(root, 4096, 1);
        cache.put("https://example.test/assets/a.css", "text/css", new byte[]{1, 2, 3});
        Thread.sleep(20);
        assertNull(cache.get("https://example.test/assets/a.css"));
    }

    @Test
    public void clearRemovesEverything() {
        StaticCache cache = new StaticCache(root, 4096);
        cache.put("https://example.test/assets/a.js", "text/javascript", new byte[]{1});
        cache.put("https://example.test/assets/b.css", "text/css", new byte[]{2});
        assertTrue(cache.sizeBytes() > 0);
        cache.clear();
        assertEquals(0, cache.sizeBytes());
        assertNull(cache.get("https://example.test/assets/a.js"));
    }

    private static void delete(File file) {
        if (file == null) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) delete(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }
}
