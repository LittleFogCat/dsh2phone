// Minimal dsh-relay control-plane admin client (text JSON frames only).
// Protocol (see docs/HANDOFF.md section 4):
//   → {t:"hello", key, mode:"admin"}   ← {t:"hello.ok"}
//   → {t:"pair.start"}                  ← {t:"pair.session", code, expiresAt}
//                                       ← {t:"pair.request", reqId, code, ua, ip, existing?}
//                                         existing={id,name} when this browser is already paired
//   → {t:"pair.response", reqId, approved, device?, dshCookie?}
//                                       ← {t:"ok"} / {t:"error", message}
//   → {t:"devices.list"}                ← {t:"devices", devices:[...]}
//   → {t:"devices.set"|"devices.remove"|"devices.panic"} ← {t:"ok"}
// Uses the `ws` package when the host tree provides it (needed for
// rejectUnauthorized on an IP-addressed relay), otherwise Node's global
// WebSocket. Relay sends/receives text frames only.

/**
 * Open one admin control connection and wait for hello.ok.
 * @param {{ relayUrl: string, key: string, timeoutMs?: number,
 *           WebSocketImpl?: any, insecure?: boolean }} options
 *   `insecure` skips certificate verification — required when the relay is
 *   addressed by IP while its certificate is issued for a domain name.
 * @returns {Promise<WebSocket>} the connected, authenticated WebSocket.
 */
export function openControl({
  relayUrl,
  key,
  timeoutMs = 15000,
  WebSocketImpl = globalThis.WebSocket,
  insecure = false,
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    try {
      ws = insecure ? new WebSocketImpl(relayUrl, { rejectUnauthorized: false }) : new WebSocketImpl(relayUrl);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => fail(new Error(`relay connect timeout (${relayUrl})`)), timeoutMs);
    function fail(err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(err);
    }
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify({ t: "hello", key, mode: "admin" })); } catch (err) { fail(err); }
    });
    ws.addEventListener("message", (ev) => {
      if (settled) return;
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.t === "hello.ok") {
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      } else if (msg.t === "error") {
        fail(new Error(`relay: ${msg.message ?? "rejected"}`));
      }
    });
    ws.addEventListener("close", () => fail(new Error("relay closed the connection before hello.ok")));
    ws.addEventListener("error", () => fail(new Error("relay connection failed")));
  });
}

/**
 * Send one request and resolve with the first frame whose `t` matches expectT.
 * Rejects on {t:"error"} frames, close, or timeout. Listener is removed after settle.
 */
export function sendExpect(ws, request, expectT, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`relay timeout waiting for "${expectT}"`)); }, timeoutMs);
    const onMessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.t === expectT) {
        cleanup();
        resolve(msg);
      } else if (msg.t === "error") {
        cleanup();
        reject(new Error(`relay: ${msg.message ?? "error"}`));
      }
    };
    const onClose = () => { cleanup(); reject(new Error("relay connection closed")); };
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    }
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.send(JSON.stringify(request));
  });
}
