package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AppIdentityTest {
    @Test
    public void buildsStableAsciiUserAgent() {
        String ua = AppIdentity.build("1.2.3", "14", "Pixel 9 Pro", "abcdef0123456789");
        assertTrue(ua.startsWith("dsh2phone/1.2.3 (Android 14; Pixel 9 Pro; "));
        assertTrue(ua.endsWith(")"));
        assertEquals(ua, AppIdentity.build("1.2.3", "14", "Pixel 9 Pro", "abcdef0123456789"));
        for (int i = 0; i < ua.length(); i++) {
            assertTrue(ua.charAt(i) >= 0x20 && ua.charAt(i) < 0x7f);
        }
    }

    @Test
    public void sanitizesModelAndHandlesMissingId() {
        String ua = AppIdentity.build("1.0", "13", "小米\u0001Phone", null);
        assertTrue(ua.contains("Phone"));
        assertTrue(ua.contains("Android 13"));
    }
}
