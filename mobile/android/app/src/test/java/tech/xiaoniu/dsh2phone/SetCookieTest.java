package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

public final class SetCookieTest {
    @Test
    public void parsesAttributes() {
        Cookie cookie = SetCookie.parse(
                "dshdev=abc.def; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax",
                "dsh.example.com");
        assertNotNull(cookie);
        assertEquals("dshdev", cookie.name);
        assertEquals("abc.def", cookie.value);
        assertEquals("/", cookie.path);
        assertTrue(cookie.httpOnly);
        assertFalse(cookie.secure);
        assertEquals("Lax", cookie.sameSite);
        assertTrue(cookie.expiresAt > System.currentTimeMillis());
        assertFalse(cookie.isExpired());
    }

    @Test
    public void splitsCombinedHeaderWithoutBreakingExpires() {
        String header = "dshdev=abc; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/; SameSite=Lax, "
                + "dsh-auth-x=v1.abc.def; Path=/; Expires=Wed, 21 Oct 2030 07:28:00 GMT; HttpOnly; SameSite=Strict";
        List<Cookie> cookies = SetCookie.parseHeaders(Arrays.asList(header), "dsh.example.com");
        assertEquals(2, cookies.size());
        assertEquals("dshdev", cookies.get(0).name);
        assertEquals("dsh-auth-x", cookies.get(1).name);
        assertEquals("Strict", cookies.get(1).sameSite);
        assertTrue(cookies.get(1).httpOnly);
    }

    @Test
    public void dropsForeignDomainAndExpiredCookies() {
        assertNull(SetCookie.parse("evil=1; Domain=other.example", "dsh.example.com"));
        assertTrue(SetCookie.parse("gone=1; Max-Age=0", "dsh.example.com").isExpired());
        assertTrue(SetCookie.parse("gone=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
                "dsh.example.com").isExpired());
        assertTrue(SetCookie.parseHeaders(Arrays.asList("gone=1; Max-Age=0"), "dsh.example.com").isEmpty());
    }

    @Test
    public void acceptsQuotedValue() {
        Cookie cookie = SetCookie.parse("x=\"a b\"; Path=/", "dsh.example.com");
        assertNotNull(cookie);
        assertEquals("a b", cookie.value);
    }

    @Test
    public void rejectsHeaderInjection() {
        assertNull(SetCookie.parse("x=abc\r\nSet-Cookie: y=1", "dsh.example.com"));
        assertNull(SetCookie.parse("bad name=1", "dsh.example.com"));
    }

    @Test
    public void roundTripsToHeaderValue() {
        Cookie cookie = new Cookie("dsh-auth-x", "v1.a.b", "", "/", false, true, "Strict",
                -1, System.currentTimeMillis() + 3600_000);
        String header = cookie.toHeaderValue();
        assertTrue(header.startsWith("dsh-auth-x=v1.a.b; Path=/"));
        assertTrue(header.contains("HttpOnly"));
        assertTrue(header.contains("SameSite=Strict"));
        assertTrue(header.contains("Expires="));
    }
}
