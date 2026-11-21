package tech.xiaoniu.dsh2phone;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 单主机配对快照的加密持久化。 */
public final class PairStore {
    private static final String PREFS = "dsh2phone_pairing";
    private static final String KEY_PAYLOAD = "payload";
    private static final String KEY_LAN_ORIGIN = "lanOrigin";
    private static final String KEY_LAN_FP = "lanFp";
    private static final int VERSION = 1;

    private final SharedPreferences prefs;
    private final SecurePrefs secure = new SecurePrefs();

    public PairStore(Context context) {
        this.prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public Pairing load() {
        String blob = prefs.getString(KEY_PAYLOAD, null);
        if (blob == null || blob.isEmpty()) return null;
        String json = secure.decrypt(blob);
        if (json == null) return null;
        try {
            JSONObject root = new JSONObject(json);
            if (root.optInt("v", 0) != VERSION) return null;
            String origin = root.optString("origin", "");
            if (origin.isEmpty()) return null;
            List<Cookie> cookies = new ArrayList<>();
            JSONArray array = root.optJSONArray("cookies");
            if (array != null) {
                for (int i = 0; i < array.length(); i++) {
                    JSONObject o = array.optJSONObject(i);
                    if (o == null) continue;
                    cookies.add(new Cookie(
                            o.optString("name", ""),
                            o.optString("value", ""),
                            o.optString("domain", ""),
                            o.optString("path", "/"),
                            o.optBoolean("secure", false),
                            o.optBoolean("httpOnly", false),
                            o.optString("sameSite", ""),
                            o.optLong("maxAge", -1),
                            o.optLong("expiresAt", -1)));
                }
            }
            return new Pairing(
                    origin,
                    root.optString("pairPath", "/dsh-pair"),
                    root.optString("entryPath", "/dsh/"),
                    root.optString("deviceName", "此设备"),
                    root.optLong("pairedAt", 0),
                    cookies,
                    root.optBoolean("allowBadCert", false));
        } catch (Exception e) {
            // 结构坏了就清掉，避免每次启动都尝试解析同一份坏数据。
            prefs.edit().remove(KEY_PAYLOAD).apply();
            return null;
        }
    }

    public boolean save(Pairing pairing) {
        if (pairing == null) return false;
        try {
            JSONObject root = new JSONObject();
            root.put("v", VERSION);
            root.put("origin", pairing.origin);
            root.put("pairPath", pairing.pairPath);
            root.put("entryPath", pairing.entryPath);
            root.put("deviceName", pairing.deviceName);
            root.put("pairedAt", pairing.pairedAt);
            root.put("allowBadCert", pairing.allowBadCert);
            JSONArray array = new JSONArray();
            for (Cookie c : pairing.cookies) {
                JSONObject o = new JSONObject();
                o.put("name", c.name);
                o.put("value", c.value);
                o.put("domain", c.domain);
                o.put("path", c.path);
                o.put("secure", c.secure);
                o.put("httpOnly", c.httpOnly);
                o.put("sameSite", c.sameSite == null ? "" : c.sameSite);
                o.put("maxAge", c.maxAge);
                o.put("expiresAt", c.expiresAt);
                array.put(o);
            }
            root.put("cookies", array);
            String encrypted = secure.encrypt(root.toString());
            if (encrypted == null) return false;
            return prefs.edit().putString(KEY_PAYLOAD, encrypted).commit();
        } catch (Exception e) {
            return false;
        }
    }

    public void clear() {
        prefs.edit().clear().apply();
    }

    public boolean isPaired() {
        return load() != null;
    }

    // ---- 局域网直连入口缓存（LAN IP 与证书指纹都不是机密，明文存放即可；
    //      解除配对时 clear() 会一并清掉）----

    /** 上次成功的直连 origin（https://ip:port），没有则 null。 */
    public String lanOrigin() {
        return prefs.getString(KEY_LAN_ORIGIN, null);
    }

    /** 与 lanOrigin 配套的证书指纹（SHA-256 of DER，小写 hex）。 */
    public String lanFp() {
        return prefs.getString(KEY_LAN_FP, null);
    }

    public void saveLanDirect(String origin, String fp) {
        if (origin == null || origin.isEmpty() || fp == null || fp.isEmpty()) {
            prefs.edit().remove(KEY_LAN_ORIGIN).remove(KEY_LAN_FP).apply();
            return;
        }
        prefs.edit().putString(KEY_LAN_ORIGIN, origin).putString(KEY_LAN_FP, fp).apply();
    }

    public boolean setAllowBadCert(boolean allow) {
        Pairing current = load();
        if (current == null) return false;
        return save(current.withAllowBadCert(allow));
    }
}
