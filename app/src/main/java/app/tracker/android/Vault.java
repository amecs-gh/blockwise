package app.tracker.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.AtomicFile;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import javax.crypto.AEADBadTagException;

/**
 * Your Blockwise data on the phone (local-first): the engine's database, the
 * snapshot the notifications use, and changes made from the notification.
 *
 * Each file is encrypted with its own AES key in the Android Keystore (not
 * the app password's key), written atomically, kept out of backups (the
 * no-backup folder; backups are off anyway). If the Keystore fails, data is
 * kept in memory for this run only, never written down unencrypted: the app
 * then works from the server, as before.
 */
final class Vault {
    private static final String KEY_ALIAS = "tracker-data";
    private static final String OWNER_PREFS = "tracker-data";
    static final String DB = "db";
    static final String SNAPSHOT = "snapshot";
    static final String OUTBOX = "outbox";

    private static final Map<String, String> memory = new HashMap<>();

    private Vault() {
    }

    private static File file(Context c, String name) {
        File dir = new File(c.getApplicationContext().getNoBackupFilesDir(), "vault");
        if (!dir.isDirectory() && !dir.mkdirs()) {
            return null;
        }
        return new File(dir, name + ".bin");
    }

    /** Files the Keystore could not open this run: never replaced (see write). */
    private static final Set<String> unreadable = new HashSet<>();

    /**
     * null if missing, damaged or the key is gone (then the data is deleted and
     * comes again from the server), or if the Keystore can't be used right now
     * (then the file is kept: see unreadable()).
     */
    static synchronized String read(Context c, String name) {
        if (memory.containsKey(name)) {
            return memory.get(name);
        }
        File f = file(c, name);
        if (f == null) {
            return null;
        }
        AtomicFile af = new AtomicFile(f);
        byte[] bytes;
        try {
            bytes = af.readFully();
        } catch (IOException e) {
            return null; // not written yet
        }
        try {
            String text = Store.decrypt(KEY_ALIAS, new String(bytes, StandardCharsets.US_ASCII));
            unreadable.remove(name);
            return text;
        } catch (AEADBadTagException | IllegalArgumentException | IndexOutOfBoundsException e) {
            // Damaged, or encrypted with a key that no longer exists: start over from the server
            af.delete();
            return null;
        } catch (Exception e) {
            // The Keystore is not usable right now: keep the file, try again later
            unreadable.add(name);
            return null;
        }
    }

    /** Was this file there but not readable (Keystore problem)? */
    static synchronized boolean unreadable(String name) {
        return unreadable.contains(name);
    }

    /** @param text null deletes */
    static synchronized void write(Context c, String name, String text) {
        if (unreadable.contains(name)) {
            return; // never replace data we could not read (it may hold changes not yet synced)
        }
        File f = file(c, name);
        if (text == null) {
            memory.remove(name);
            if (f != null) {
                new AtomicFile(f).delete();
            }
            return;
        }
        String sealed;
        try {
            sealed = Store.encrypt(KEY_ALIAS, text);
        } catch (Exception e) {
            memory.put(name, text);
            return;
        }
        memory.remove(name);
        if (f == null) {
            memory.put(name, text);
            return;
        }
        AtomicFile af = new AtomicFile(f);
        FileOutputStream out = null;
        try {
            out = af.startWrite();
            out.write(sealed.getBytes(StandardCharsets.US_ASCII));
            af.finishWrite(out);
        } catch (IOException e) {
            if (out != null) {
                af.failWrite(out);
            }
            memory.put(name, text);
        }
    }

    /** Everything, and the key (logging out, or another account logging in). */
    static synchronized void wipe(Context c) {
        memory.clear();
        unreadable.clear();
        for (String name : new String[] {DB, SNAPSHOT, OUTBOX}) {
            File f = file(c, name);
            if (f != null) {
                new AtomicFile(f).delete();
            }
        }
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY_ALIAS);
        } catch (Exception ignored) {
            // nothing to delete
        }
        owner(c).edit().remove("owner").apply();
    }

    private static SharedPreferences owner(Context c) {
        return c.getApplicationContext().getSharedPreferences(OWNER_PREFS, Context.MODE_PRIVATE);
    }

    /**
     * Whose data this is. Logging in again as the same account keeps changes
     * not yet synced (e.g. after the app password was revoked); another
     * account starts empty.
     */
    static synchronized void claim(Context c, String server, String loginName) {
        String who = server + "\n" + loginName;
        String was = owner(c).getString("owner", null);
        if (was != null && !was.equals(who)) {
            wipe(c);
        }
        owner(c).edit().putString("owner", who).apply();
    }
}
