package tech.xiaoniu.dsh2phone;

import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 只在用户明确打开“允许此主机的证书不匹配”时调用。
 * 这是 IP 直连应急开关，默认关闭；不要在其他地方复用。
 */
final class Tls {
    private Tls() {
    }

    static void allow(HttpsURLConnection connection) throws GeneralSecurityException {
        TrustManager[] trustAll = new TrustManager[]{
                new X509TrustManager() {
                    @Override
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {
                    }

                    @Override
                    public X509Certificate[] getAcceptedIssuers() {
                        return new X509Certificate[0];
                    }
                }
        };
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trustAll, new SecureRandom());
        connection.setSSLSocketFactory(context.getSocketFactory());
        HostnameVerifier allowAll = (hostname, session) -> true;
        connection.setHostnameVerifier(allowAll);
    }
}
