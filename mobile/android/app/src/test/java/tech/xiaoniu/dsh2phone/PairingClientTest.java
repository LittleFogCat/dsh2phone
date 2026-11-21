package tech.xiaoniu.dsh2phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 用裸 ServerSocket 起一个最小 HTTP 服务，避免依赖 com.sun.net.httpserver
 * （Android 单元测试的 android.jar 里没有这个包）。
 */
public final class PairingClientTest {
    private TestServer server;
    private final AtomicReference<String> lastCookie = new AtomicReference<>();
    private final AtomicReference<String> lastUserAgent = new AtomicReference<>();

    @Before
    public void setUp() throws Exception {
        server = new TestServer();
        server.start();
    }

    @After
    public void tearDown() {
        if (server != null) server.close();
    }

    @Test
    public void successParsesCookiesDeviceAndEntry() {
        PairingClient.Result result = client().pair(target("ok"), null, false);
        assertEquals(PairingClient.Status.SUCCESS, result.status);
        assertEquals(200, result.httpStatus);
        assertEquals(2, result.cookies.size());
        assertEquals("Pixel E2E", result.deviceName);
        assertEquals("/dsh/", result.entryPath);
        assertEquals("test-agent/1.0", lastUserAgent.get());
    }

    @Test
    public void sendsExistingDeviceCookie() {
        PairingClient.Result result = client().pair(target("echo"), "old.id", false);
        assertEquals(PairingClient.Status.SUCCESS, result.status);
        assertNotNull(lastCookie.get());
        assertTrue(lastCookie.get().contains("dshdev=old.id"));
    }

    @Test
    public void mapsExpiredCode() {
        PairingClient.Result result = client().pair(target("expired"), null, false);
        assertEquals(PairingClient.Status.CODE_EXPIRED, result.status);
        assertEquals(403, result.httpStatus);
        assertTrue(result.serverDetail.contains("配对码无效"));
    }

    @Test
    public void mapsRejected() {
        PairingClient.Result result = client().pair(target("rejected"), null, false);
        assertEquals(PairingClient.Status.REJECTED, result.status);
    }

    @Test
    public void mapsTunnelOffline() {
        PairingClient.Result result = client().pair(target("offline"), null, false);
        assertEquals(PairingClient.Status.TUNNEL_OFFLINE, result.status);
    }

    @Test
    public void mapsMissingCredential() {
        PairingClient.Result result = client().pair(target("nocred"), null, false);
        assertEquals(PairingClient.Status.NO_CREDENTIAL, result.status);
    }

    @Test
    public void mapsHttpError() {
        PairingClient.Result result = client().pair(target("fail500"), null, false);
        assertEquals(PairingClient.Status.HTTP_ERROR, result.status);
        assertEquals(500, result.httpStatus);
    }

    @Test
    public void keepsCookiesWhenBodyIsTruncated() {
        PairingClient.Result result = client().pair(target("truncated"), null, false);
        assertEquals(PairingClient.Status.SUCCESS, result.status);
        assertNotNull(result.cookies);
        assertTrue(result.cookies.size() >= 1);
        assertEquals("/dsh/", result.entryPath);
    }

    @Test
    public void cancelledBeforeStart() {
        PairingClient client = client();
        client.cancel();
        assertEquals(PairingClient.Status.CANCELLED, client.pair(target("ok"), null, false).status);
    }

    private PairingClient client() {
        return new PairingClient("test-agent/1.0");
    }

    private PairUrl target(String code) {
        try {
            return PairUrl.parse("http://127.0.0.1:" + server.port() + "/dsh-pair?code=" + code, true);
        } catch (PairUrl.Invalid invalid) {
            throw new AssertionError(invalid);
        }
    }

    private final class TestServer implements Runnable {
        private final ServerSocket socket;
        private final Thread thread;

        TestServer() throws IOException {
            socket = new ServerSocket(0, 20, InetAddress.getByName("127.0.0.1"));
            thread = new Thread(this, "pairing-test-http");
            thread.setDaemon(true);
        }

        void start() {
            thread.start();
        }

        int port() {
            return socket.getLocalPort();
        }

        void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // 已关闭。
            }
        }

        @Override
        public void run() {
            while (!socket.isClosed()) {
                try (Socket client = socket.accept()) {
                    handle(client);
                } catch (IOException e) {
                    if (!socket.isClosed()) {
                        // 单个连接失败不影响后续用例。
                    }
                }
            }
        }

        private void handle(Socket client) throws IOException {
            BufferedReader in = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
            String requestLine = in.readLine();
            if (requestLine == null) return;
            String cookie = null;
            String userAgent = null;
            String line;
            while ((line = in.readLine()) != null && !line.isEmpty()) {
                int at = line.indexOf(':');
                if (at <= 0) continue;
                String key = line.substring(0, at).trim();
                String value = line.substring(at + 1).trim();
                if ("Cookie".equalsIgnoreCase(key)) cookie = value;
                if ("User-Agent".equalsIgnoreCase(key)) userAgent = value;
            }
            lastCookie.set(cookie);
            lastUserAgent.set(userAgent);

            int space = requestLine.indexOf(' ');
            String target = space > 0 ? requestLine.substring(space + 1).split(" ")[0] : "/";
            String query = target.contains("?") ? target.substring(target.indexOf('?') + 1) : "";
            String code = query.startsWith("code=") ? query.substring(5) : "";

            if ("expired".equals(code)) {
                send(client, 403, "<html><head><title>配对失败</title></head><body>"
                        + "<h1>配对失败</h1><p>配对码无效或已过期。</p></body></html>");
                return;
            }
            if ("rejected".equals(code)) {
                send(client, 403, "<html><head><title>配对被拒绝</title></head><body>"
                        + "<h1>配对被拒绝</h1><p>电脑端拒绝了这个设备。</p></body></html>");
                return;
            }
            if ("offline".equals(code)) {
                send(client, 503, "<html><head><title>电脑端连接中</title></head><body>"
                        + "<h1>电脑端连接中</h1></body></html>");
                return;
            }
            if ("nocred".equals(code)) {
                send(client, 200, "<html><head><title>需要先配对</title></head><body>"
                        + "<h1>需要先配对</h1></body></html>");
                return;
            }
            if ("fail500".equals(code)) {
                send(client, 500, "<html><head><title>err</title></head><body>err</body></html>");
                return;
            }
            if ("truncated".equals(code)) {
                String partial = "<html><head><title>已连接 DSH</title></head><body><h1>配对成功</h1>";
                String head = "HTTP/1.1 200 OK\r\n"
                        + "Content-Type: text/html; charset=utf-8\r\n"
                        + "Set-Cookie: dshdev=abc.def; Path=/; HttpOnly; SameSite=Lax\r\n"
                        + "Set-Cookie: dsh-auth-test=v1.body.sig; Path=/; HttpOnly; SameSite=Strict\r\n"
                        + "Content-Length: 500\r\n"
                        + "Connection: close\r\n\r\n";
                OutputStream out = client.getOutputStream();
                out.write(head.getBytes(StandardCharsets.US_ASCII));
                out.write(partial.getBytes(StandardCharsets.UTF_8));
                out.flush();
                return;
            }

            String body = "<html><head><title>已连接 DSH</title></head><body>"
                    + "<h1>配对成功</h1><p><span class=\"device\">Pixel E2E</span> 已加入设备白名单。</p>"
                    + "<a class=\"enter\" href=\"/dsh/\">进入 DSH</a></body></html>";
            String head = "HTTP/1.1 200 OK\r\n"
                    + "Content-Type: text/html; charset=utf-8\r\n"
                    + "Set-Cookie: dshdev=abc.def; Path=/; HttpOnly; SameSite=Lax\r\n"
                    + "Set-Cookie: dsh-auth-test=v1.body.sig; Path=/; HttpOnly; SameSite=Strict\r\n"
                    + "Content-Length: " + body.getBytes(StandardCharsets.UTF_8).length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = client.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(body.getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        private void send(Socket client, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            String head = "HTTP/1.1 " + status + " X\r\n"
                    + "Content-Type: text/html; charset=utf-8\r\n"
                    + "Content-Length: " + bytes.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream out = client.getOutputStream();
            out.write(head.getBytes(StandardCharsets.US_ASCII));
            out.write(bytes);
            out.flush();
        }
    }
}
