package app.tracker.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Login and settings. The app password is encrypted with an AES key that lives
 * in the Android Keystore (it never leaves the phone's secure hardware, and
 * backups are off). If the Keystore fails, the password is kept in memory for
 * this run only and never written down unencrypted.
 */
final class Store {
    private static final String PREFS = "tracker";
    private static final String KEY_ALIAS = "tracker-app-password";
    private static final int GCM_TAG_BITS = 128;

    private static String memoryPassword; // only when the Keystore fails

    private Store() {
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Logged in = address, login name and a password that can still be decrypted. */
    static boolean loggedIn(Context c) {
        SharedPreferences p = prefs(c);
        return p.getString("server", null) != null && p.getString("loginName", null) != null && password(c) != null;
    }

    static String server(Context c) {
        return prefs(c).getString("server", null);
    }

    static String loginName(Context c) {
        return prefs(c).getString("loginName", null);
    }

    static boolean notifications(Context c) {
        return prefs(c).getBoolean("notifications", true);
    }

    static void setNotifications(Context c, boolean on) {
        prefs(c).edit().putBoolean("notifications", on).apply();
    }

    /** @return false if the Keystore failed and the password lives in memory only */
    static synchronized boolean saveLogin(Context c, String server, String loginName, String appPassword) {
        SharedPreferences.Editor e = prefs(c).edit()
                .putString("server", server)
                .putString("loginName", loginName)
                .remove("password")
                .remove("seen");
        boolean sealed;
        try {
            e.putString("password", encrypt(appPassword));
            memoryPassword = null;
            sealed = true;
        } catch (Exception ex) {
            memoryPassword = appPassword;
            sealed = false;
        }
        e.apply();
        return sealed;
    }

    /** null if not logged in or the key is gone (then log in again) */
    static synchronized String password(Context c) {
        if (memoryPassword != null) {
            return memoryPassword;
        }
        String stored = prefs(c).getString("password", null);
        if (stored == null) {
            return null;
        }
        try {
            return decrypt(stored);
        } catch (Exception ex) {
            return null;
        }
    }

    static synchronized boolean passwordInMemoryOnly() {
        return memoryPassword != null;
    }

    static Nextcloud client(Context c) {
        String server = server(c);
        String login = loginName(c);
        String pw = password(c);
        if (server == null || login == null || pw == null) {
            return null;
        }
        return new Nextcloud(server, login, pw);
    }

    static synchronized void clear(Context c) {
        memoryPassword = null;
        prefs(c).edit().clear().apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // nothing to delete
        }
    }

    // --- notifications already shown (so each appears once) ---

    static synchronized Set<String> seen(Context c) {
        return new HashSet<>(prefs(c).getStringSet("seen", new HashSet<>()));
    }

    static synchronized void saveSeen(Context c, Set<String> seen) {
        Set<String> keep = seen;
        if (seen.size() > 300) {
            keep = new HashSet<>();
            int skip = seen.size() - 200;
            for (String s : seen) {
                if (skip-- <= 0) {
                    keep.add(s);
                }
            }
        }
        prefs(c).edit().putStringSet("seen", new HashSet<>(keep)).apply();
    }

    // --- Android Keystore ---

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static String encrypt(String plain) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
        ByteBuffer b = ByteBuffer.allocate(1 + iv.length + ct.length);
        b.put((byte) iv.length).put(iv).put(ct);
        return Base64.getEncoder().encodeToString(b.array());
    }

    private static String decrypt(String stored) throws Exception {
        byte[] all = Base64.getDecoder().decode(stored);
        int ivLen = all[0];
        byte[] iv = new byte[ivLen];
        System.arraycopy(all, 1, iv, 0, ivLen);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        byte[] pt = cipher.doFinal(all, 1 + ivLen, all.length - 1 - ivLen);
        return new String(pt, StandardCharsets.UTF_8);
    }
}
