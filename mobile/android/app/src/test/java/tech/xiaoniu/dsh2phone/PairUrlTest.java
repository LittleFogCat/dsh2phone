package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

public final class PairUrlTest {
    @Test
    public void parsesProductionUrl() throws Exception {
        PairUrl url = PairUrl.parse("https://dsh.example.com/dsh-pair?code=abc123", false);
        assertEquals("https://dsh.example.com", url.origin);
        assertEquals("dsh.example.com", url.host);
        assertEquals("/dsh-pair", url.pairPath);
        assertEquals("abc123", url.code);
        assertEquals("/dsh/", url.defaultEntryPath());
        assertFalse(url.isInsecure());
    }

    @Test
    public void keepsPathPrefixAndExplicitPort() throws Exception {
        PairUrl url = PairUrl.parse("https://dsh.example.com:8443/foo/dsh-pair?code=x", false);
        assertEquals("https://dsh.example.com:8443", url.origin);
        assertEquals("/foo/dsh-pair", url.pairPath);
        assertEquals("/foo/dsh/", url.defaultEntryPath());
    }

    @Test
    public void decodesCode() throws Exception {
        PairUrl url = PairUrl.parse("https://dsh.example.com/dsh-pair?code=a%2Bb%3D", false);
        assertEquals("a+b=", url.code);
    }

    @Test
    public void rejectsPlainHttpForPublicHosts() {
        assertError("http://dsh.example.com/dsh-pair?code=x", false, PairUrl.Error.HTTPS_REQUIRED);
        assertError("http://dsh.example.com/dsh-pair?code=x", true, PairUrl.Error.HTTPS_REQUIRED);
    }

    @Test
    public void allowsPlainHttpOnlyForLocalDebug() throws Exception {
        PairUrl url = PairUrl.parse("http://10.0.2.2:13200/pair?code=x", true);
        assertTrue(url.isInsecure());
        assertEquals("http://10.0.2.2:13200", url.origin);
        assertEquals("/dsh/", url.defaultEntryPath());
        assertError("http://10.0.2.2:13200/pair?code=x", false, PairUrl.Error.HTTPS_REQUIRED);
    }

    @Test
    public void rejectsMissingCodeAndWrongPath() {
        assertError("https://dsh.example.com/dsh-pair", false, PairUrl.Error.MISSING_CODE);
        assertError("https://dsh.example.com/dsh-pair?code=", false, PairUrl.Error.BAD_CODE);
        assertError("https://dsh.example.com/other?code=x", false, PairUrl.Error.BAD_PATH);
        assertError("https://dsh.example.com/dsh-pair/?code=x", false, PairUrl.Error.BAD_PATH);
    }

    @Test
    public void rejectsBadSchemesAndUserInfo() {
        assertError("dsh2phone://pair?url=x", false, PairUrl.Error.BAD_SCHEME);
        assertError("https://user:pass@dsh.example.com/dsh-pair?code=x", false, PairUrl.Error.USERINFO);
        assertError("", false, PairUrl.Error.EMPTY);
    }

    @Test
    public void handlesIpv6Literal() throws Exception {
        PairUrl url = PairUrl.parse("https://[::1]/dsh-pair?code=x", false);
        assertEquals("https://[::1]", url.origin);
        assertEquals("::1", url.host);
    }

    private static void assertError(String raw, boolean allowInsecure, PairUrl.Error expected) {
        try {
            PairUrl.parse(raw, allowInsecure);
            fail("expected error " + expected + " for " + raw);
        } catch (PairUrl.Invalid invalid) {
            assertEquals(expected, invalid.error);
        }
    }
}
