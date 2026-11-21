package tech.xiaoniu.dsh2phone;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 用 Android Keystore 里的 AES-GCM 密钥加密配对凭证。
 * Keystore 密钥不会被导出，root 之外很难直接读出 SharedPreferences 里的 cookie。
 */
final class SecurePrefs {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "dsh2phone_pairing_v1";
    private static final String PREFIX = "v1";
    private static final int GCM_TAG_BITS = 128;

    String encrypt(String plain) {
        if (plain == null) return null;
        try {
            SecretKey key = getOrCreateKey();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key);
            byte[] iv = cipher.getIV();
            byte[] cipherText = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX + ":" + Base64.encodeToString(iv, Base64.NO_WRAP)
                    + ":" + Base64.encodeToString(cipherText, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }

    String decrypt(String blob) {
        if (blob == null) return null;
        try {
            String[] parts = blob.split(":", -1);
            if (parts.length != 3 || !PREFIX.equals(parts[0])) return null;
            byte[] iv = Base64.decode(parts[1], Base64.NO_WRAP);
            byte[] cipherText = Base64.decode(parts[2], Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
            return new String(cipher.doFinal(cipherText), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    void resetKey() {
        try {
            KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
            keyStore.load(null);
            if (keyStore.containsAlias(ALIAS)) keyStore.deleteEntry(ALIAS);
        } catch (Exception ignored) {
            // 删除失败时保留旧 key；下次启动仍会尝试解密。
        }
    }

    private synchronized SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(ALIAS)) {
            return (SecretKey) keyStore.getKey(ALIAS, null);
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }
}
