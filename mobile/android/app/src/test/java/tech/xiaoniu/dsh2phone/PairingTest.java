package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;

public final class PairingTest {
    @Test
    public void exposesDeviceValueAndCookieHeader() {
        Cookie dev = new Cookie("dshdev", "abc.def", "", "/", false, true, "Lax",
                -1, System.currentTimeMillis() + 60_000);
        Cookie auth = new Cookie("dsh-auth-x", "v1.a.b", "", "/", false, true, "Strict",
                -1, System.currentTimeMillis() + 60_000);
        Pairing pairing = new Pairing("https://dsh.example.com", "/dsh-pair", "/foo/dsh/",
                "Pixel", 1L, Arrays.asList(dev, auth), false);
        assertEquals("abc.def", pairing.dshDevValue());
        assertTrue(pairing.cookieHeader().contains("dshdev=abc.def"));
        assertTrue(pairing.cookieHeader().contains("dsh-auth-x=v1.a.b"));
        assertEquals("https://dsh.example.com/foo/dsh/", pairing.entryUrl());
    }

    @Test
    public void ignoresExpiredCookies() {
        Cookie expired = new Cookie("dshdev", "old", "", "/", false, false, null,
                0, 0);
        Pairing pairing = new Pairing("https://h", "/dsh-pair", "/dsh/", "d", 0L,
                Arrays.asList(expired), false);
        assertEquals(null, pairing.dshDevValue());
        assertEquals("", pairing.cookieHeader());
    }
}
