package tech.xiaoniu.dsh2phone;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 不敏感的全局偏好（与加密的 PairStore 分开）。
 *
 * 目前只有「局域网直连」开关：关闭后即使手机和电脑在同一局域网也强制走公网中继，
 * 用于验证公网链路 / 排除直连干扰。
 */
final class AppPrefs {
    private static final String FILE = "dsh2phone_prefs";
    private static final String KEY_LAN_DIRECT = "lan_direct_enabled";

    private AppPrefs() {
    }

    static boolean lanDirectEnabled(Context context) {
        return prefs(context).getBoolean(KEY_LAN_DIRECT, true);
    }

    static void setLanDirectEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_LAN_DIRECT, enabled).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }
}
