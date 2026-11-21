package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class LanDirectTest {
    private static final String FP = "a3f1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728394a5b6c7d8e9f";

    @Test
    public void normalizesFingerprint() {
        String colonized = FP.toUpperCase(java.util.Locale.ROOT);
        StringBuilder spaced = new StringBuilder();
        for (int i = 0; i < colonized.length(); i += 2) {
            if (i > 0) spaced.append(':');
            spaced.append(colonized, i, i + 2);
        }
        assertEquals(FP, LanDirect.normalizeFp(spaced.toString()));
        assertEquals(FP, LanDirect.normalizeFp(FP));
        assertNull(LanDirect.normalizeFp(null));
        assertNull(LanDirect.normalizeFp(""));
        assertNull(LanDirect.normalizeFp(FP.substring(0, 63)));
        assertNull(LanDirect.normalizeFp(FP.substring(0, 63) + "g"));
        assertNull("md5 长度也要拒绝", LanDirect.normalizeFp("0123456789abcdef0123456789abcdef"));
    }

    @Test
    public void buildsOrigins() {
        assertEquals("https://192.168.1.10:43220", LanDirect.originFor("192.168.1.10", 43220));
        assertEquals("https://[fd00::5]:43220", LanDirect.originFor("fd00::5", 43220));
        assertEquals("https://[fd00::5]:43220", LanDirect.originFor("[fd00::5]", 43220));
        assertNull(LanDirect.originFor(null, 43220));
        assertNull(LanDirect.originFor("", 43220));
        assertNull(LanDirect.originFor("192.168.1.10", 0));
        assertNull(LanDirect.originFor("192.168.1.10", 70000));
    }

    @Test
    public void parsesLanInfo() {
        LanDirect.Info info = LanDirect.parseInfo(
                "{\"lan\":{\"port\":43220,\"fp\":\"" + FP.toUpperCase() + "\",\"ips\":[\"192.168.31.83\",\"FD00::5\"]}}");
        assertNotNull(info);
        assertEquals(43220, info.port);
        assertEquals(FP, info.fp);
        assertEquals(java.util.Arrays.asList("192.168.31.83", "fd00::5"), info.ips);
    }

    @Test
    public void rejectsBadLanInfo() {
        assertNull("lan=null 表示电脑端没有直连边缘", LanDirect.parseInfo("{\"lan\":null}"));
        assertNull(LanDirect.parseInfo("{}"));
        assertNull(LanDirect.parseInfo("not json"));
        assertNull(LanDirect.parseInfo(null));
        assertNull("port 非法", LanDirect.parseInfo("{\"lan\":{\"port\":70000,\"fp\":\"" + FP + "\",\"ips\":[\"10.0.0.1\"]}}"));
        assertNull("fp 非法", LanDirect.parseInfo("{\"lan\":{\"port\":43220,\"fp\":\"abc\",\"ips\":[\"10.0.0.1\"]}}"));
        assertNull("ips 为空", LanDirect.parseInfo("{\"lan\":{\"port\":43220,\"fp\":\"" + FP + "\",\"ips\":[]}}"));
        assertNull("ips 全部非法", LanDirect.parseInfo("{\"lan\":{\"port\":43220,\"fp\":\"" + FP + "\",\"ips\":[\"\"]}}"));
        // 旧 relay 会把请求转给 DSH，返回的是 HTML：必须安静地判为无直连。
        assertNull(LanDirect.parseInfo("<!doctype html><html><body>404</body></html>"));
    }

    @Test
    public void capsAndDedupesIps() {
        StringBuilder json = new StringBuilder("{\"lan\":{\"port\":1,\"fp\":\"" + FP + "\",\"ips\":[");
        for (int i = 0; i < 20; i++) {
            if (i > 0) json.append(',');
            json.append("\"10.0.0.").append(i).append("\"");
        }
        json.append("]}}");
        LanDirect.Info info = LanDirect.parseInfo(json.toString());
        assertNotNull(info);
        assertEquals("候选最多 8 个", 8, info.ips.size());
    }

    @Test
    public void sha256MatchesKnownVector() throws Exception {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                LanDirect.sha256Hex("abc".getBytes("UTF-8")));
    }

    @Test
    public void probeRejectsMissingInputs() {
        assertFalse(LanDirect.probe(null, FP, 100));
        assertFalse(LanDirect.probe("https://127.0.0.1:1", null, 100));
    }

    @Test
    public void pathsMatchRelayMapping() {
        // 公网 URL /dsh/dsh-lan → nginx 剥前缀 → relay 数据面 /dsh-lan。
        assertEquals("/dsh/dsh-lan", LanDirect.INFO_PATH);
        assertEquals("/dsh2phone-lan-hello", LanDirect.HELLO_PATH);
    }
}
