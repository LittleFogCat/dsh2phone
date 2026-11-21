package tech.xiaoniu.dsh2phone;

import java.net.HttpURLConnection;
import java.net.URL;

import javax.net.ssl.HttpsURLConnection;

/** 主页/进入前的一次轻量探活：只请求 /dsh-pair，不触碰 DSH 数据面。 */
public final class PairProbe {
    public enum State {
        ONLINE,
        OFFLINE,
        UNAUTHORIZED,
        UNKNOWN,
    }

    private PairProbe() {
    }

    public static State check(Pairing pairing, int timeoutMs) {
        if (pairing == null) return State.UNKNOWN;
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(pairing.pairUrl()).openConnection();
            conn.setRequestMethod("GET");
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setUseCaches(false);
            conn.setRequestProperty("User-Agent", "dsh2phone-probe");
            conn.setRequestProperty("Accept", "text/html");
            conn.setRequestProperty("Cache-Control", "no-cache");
            conn.setRequestProperty("Connection", "close");
            String cookie = pairing.cookieHeader();
            if (!cookie.isEmpty()) conn.setRequestProperty("Cookie", cookie);
            if (pairing.allowBadCert && conn instanceof HttpsURLConnection) {
                Tls.allow((HttpsURLConnection) conn);
            }
            int status = conn.getResponseCode();
            if (status == 200) return State.ONLINE;
            if (status == 503) return State.OFFLINE;
            if (status == 403) return State.UNAUTHORIZED;
            return State.UNKNOWN;
        } catch (Exception e) {
            // 连接失败/证书失败在用户视角都是“电脑端不可达”，比“状态未知”更有用。
            return State.OFFLINE;
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                    // 忽略。
                }
            }
        }
    }
}
