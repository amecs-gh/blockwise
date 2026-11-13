package app.tracker.android;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Dropbox and Google Drive as sync folders, like on the Mac (mac/src/drives.js):
 *
 * - Dropbox: an "App folder" app, so Blockwise only ever sees Apps/Blockwise.
 * - Google Drive: the hidden app data folder (scope drive.appdata), so Blockwise
 *   can't see or change any of your other files.
 *
 * You log in in your browser (OAuth 2 with PKCE); the provider sends a one-time
 * code back to a small server in the app on this phone (127.0.0.1 only), checked
 * against a random `state`. Only the refresh token is kept, encrypted by the
 * Keystore (Store); access tokens live in memory. Every request goes to the
 * provider's fixed https address; nothing from an answer is used as a URL.
 * The files are end-to-end encrypted by the page (web/filesync.js) before
 * they get here: the drive only sees random-looking bytes.
 */
final class Drives {
    static final String DROPBOX = "dropbox";
    static final String GOOGLE = "gdrive";

    private static final Pattern NAME = Pattern.compile("^[A-Za-z0-9_-][A-Za-z0-9._-]{0,79}$");
    private static final Pattern ID = Pattern.compile("^[A-Za-z0-9_-]{1,200}$");
    private static final int MAX_FILE = 32 * 1024 * 1024;
    private static final int LOGIN_SECONDS = 300;

    // Dropbox: the redirect address is registered in the Dropbox app's settings (same as the Mac app)
    private static final int DROPBOX_PORT = 53682;
    private static final String DROPBOX_AUTHORIZE = "https://www.dropbox.com/oauth2/authorize";
    private static final String DROPBOX_TOKEN = "https://api.dropboxapi.com/oauth2/token";
    private static final String DROPBOX_API = "https://api.dropboxapi.com/2/";
    private static final String DROPBOX_CONTENT = "https://content.dropboxapi.com/2/";
    // Waiting for changes: no token is sent there, only the folder's cursor
    private static final String DROPBOX_NOTIFY = "https://notify.dropboxapi.com/2/files/list_folder/longpoll";

    private static final String GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
    private static final String GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
    private static final String GOOGLE_REVOKE = "https://oauth2.googleapis.com/revoke";
    private static final String GOOGLE_FILES = "https://www.googleapis.com/drive/v3/files";
    private static final String GOOGLE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
    private static final String GOOGLE_CHANGES = "https://www.googleapis.com/drive/v3/changes";
    private static final String GOOGLE_ABOUT = "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)";
    private static final String GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

    private Drives() {
    }

    static final class DriveException extends Exception {
        final int status;
        final boolean exists;
        final boolean offline;

        DriveException(String message, int status, boolean exists, boolean offline) {
            super(message);
            this.status = status;
            this.exists = exists;
            this.offline = offline;
        }

        DriveException(String message) {
            this(message, 0, false, false);
        }
    }

    // --- the app keys (from the build: not secrets, PKCE protects the logins) ---------------------

    static final class Keys {
        String dropboxAppKey = "";
        String googleClientId = "";
        String googleClientSecret = "";
    }

    private static Keys keys;

    static synchronized Keys keys(Context c) {
        if (keys != null) {
            return keys;
        }
        Keys k = new Keys();
        try (InputStream in = c.getAssets().open("providers.json")) {
            JSONObject j = new JSONObject(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            String d = j.optString("dropboxAppKey", "");
            String id = j.optString("googleClientId", "");
            String secret = j.optString("googleClientSecret", "");
            if (d.matches("^[a-z0-9]{8,32}$")) {
                k.dropboxAppKey = d;
            }
            if (id.matches("^[0-9]{6,30}-[a-z0-9]{10,64}\\.apps\\.googleusercontent\\.com$") && secret.matches("^[A-Za-z0-9_-]{10,80}$")) {
                k.googleClientId = id;
                k.googleClientSecret = secret;
            }
        } catch (IOException | JSONException e) {
            // this build has no keys: the drives are not offered
        }
        keys = k;
        return k;
    }

    static boolean available(Context c, String provider) {
        Keys k = keys(c);
        return DROPBOX.equals(provider) ? !k.dropboxAppKey.isEmpty() : GOOGLE.equals(provider) && !k.googleClientId.isEmpty();
    }

    static String displayName(String provider) {
        return DROPBOX.equals(provider) ? "Dropbox" : "Google Drive";
    }

    // --- logging in -------------------------------------------------------------------------------

    interface Browser {
        void open(String url);
    }

    /** A login in progress: cancel() ends the wait. */
    static final class Login {
        volatile boolean cancelled;
        private volatile ServerSocket server;

        void cancel() {
            cancelled = true;
            ServerSocket s = server;
            if (s != null) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closed already
                }
            }
        }
    }

    /** @return {refresh token, account id or null} */
    static String[] login(Context c, String provider, Browser browser, Login login) throws DriveException {
        Keys k = keys(c);
        if (!available(c, provider)) {
            throw new DriveException("This build of Blockwise can't connect to " + displayName(provider) + ".");
        }
        boolean dropbox = DROPBOX.equals(provider);
        String verifier = b64url(random(32));
        String challenge;
        try {
            challenge = b64url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
        } catch (Exception e) {
            throw new DriveException("Something went wrong.");
        }
        String state = b64url(random(24));
        String path = dropbox ? "/dropbox" : "/google";
        ServerSocket server;
        try {
            server = new ServerSocket(dropbox ? DROPBOX_PORT : 0, 4, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(1000);
        } catch (IOException e) {
            throw new DriveException("Port " + DROPBOX_PORT + " on this phone is in use. Close the app using it and try again.");
        }
        login.server = server;
        try {
            String redirect = "http://127.0.0.1:" + server.getLocalPort() + path;
            Map<String, String> q = new LinkedHashMap<>();
            String authorize;
            if (dropbox) {
                q.put("client_id", k.dropboxAppKey);
                q.put("response_type", "code");
                q.put("code_challenge", challenge);
                q.put("code_challenge_method", "S256");
                q.put("token_access_type", "offline");
                q.put("redirect_uri", redirect);
                q.put("state", state);
                authorize = DROPBOX_AUTHORIZE;
            } else {
                q.put("client_id", k.googleClientId);
                q.put("response_type", "code");
                q.put("scope", GOOGLE_SCOPE);
                q.put("code_challenge", challenge);
                q.put("code_challenge_method", "S256");
                q.put("access_type", "offline");
                q.put("prompt", "consent");
                q.put("redirect_uri", redirect);
                q.put("state", state);
                authorize = GOOGLE_AUTHORIZE;
            }
            browser.open(authorize + "?" + form(q));
            String code = waitForCode(server, path, state, login);
            Map<String, String> p = new LinkedHashMap<>();
            p.put("code", code);
            p.put("grant_type", "authorization_code");
            p.put("client_id", dropbox ? k.dropboxAppKey : k.googleClientId);
            if (!dropbox) {
                // Google's "client secret" for installed apps ships in every copy; PKCE protects the code
                p.put("client_secret", k.googleClientSecret);
            }
            p.put("code_verifier", verifier);
            p.put("redirect_uri", redirect);
            JSONObject t = tokenRequest(dropbox ? DROPBOX_TOKEN : GOOGLE_TOKEN, p);
            String refresh = t.optString("refresh_token", "");
            if (refresh.isEmpty()) {
                throw new DriveException(dropbox ? "Dropbox did not allow offline access." : "Google did not allow offline access.");
            }
            if (!dropbox && t.has("scope") && !(" " + t.optString("scope") + " ").contains(" " + GOOGLE_SCOPE + " ")) {
                throw new DriveException("Allow Blockwise to use its app data in Google Drive, then try again.");
            }
            String account = dropbox ? t.optString("account_id", "") : "";
            account = account.replaceAll("[^\\w:-]", "");
            return new String[] {refresh, account.isEmpty() ? null : account.substring(0, Math.min(64, account.length()))};
        } finally {
            login.server = null;
            try {
                server.close();
            } catch (IOException ignored) {
                // closed already
            }
        }
    }

    private static String waitForCode(ServerSocket server, String path, String state, Login login) throws DriveException {
        long until = System.currentTimeMillis() + LOGIN_SECONDS * 1000L;
        while (!login.cancelled) {
            if (System.currentTimeMillis() > until) {
                throw new DriveException("The login took too long. Try again.");
            }
            try (Socket s = server.accept()) {
                s.setSoTimeout(5000);
                String line = requestLine(s.getInputStream());
                String target = null;
                if (line != null && line.startsWith("GET ")) {
                    int sp = line.indexOf(' ', 4);
                    target = sp > 0 ? line.substring(4, sp) : null;
                }
                int qm = target == null ? -1 : target.indexOf('?');
                if (target == null || !path.equals(qm < 0 ? target : target.substring(0, qm))) {
                    respond(s, 404, "Not found", "");
                    continue;
                }
                Map<String, String> q = parseQuery(qm < 0 ? "" : target.substring(qm + 1));
                if (!state.equals(q.get("state"))) {
                    // Someone else's answer, or a page trying its luck: ignored, the login goes on
                    respond(s, 400, "Not this login", "You can close this tab.");
                    continue;
                }
                if (q.containsKey("error")) {
                    respond(s, 200, "Not connected", "You can close this tab and try again in Blockwise.");
                    throw new DriveException("The connection was not allowed.");
                }
                String code = q.get("code");
                if (code == null || code.isEmpty() || code.length() > 2048) {
                    respond(s, 400, "Not connected", "");
                    continue;
                }
                respond(s, 200, "Connected", "Blockwise is connected. Go back to Blockwise.");
                return code;
            } catch (SocketTimeoutException e) {
                // check for cancel and time, then wait again
            } catch (IOException e) {
                if (login.cancelled) {
                    break;
                }
            }
        }
        throw new DriveException("Cancelled.");
    }

    private static String requestLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int ch;
        while ((ch = in.read()) != -1 && ch != '\n') {
            if (b.size() > 4096) {
                return null;
            }
            if (ch != '\r') {
                b.write(ch);
            }
        }
        return b.toString("US-ASCII");
    }

    private static void respond(Socket s, int status, String title, String text) throws IOException {
        String html = "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Blockwise</title>"
                + "<style>body{font:17px system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#24223a;background:#f6f5fb}main{text-align:center;max-width:24em;padding:24px}h1{font-size:24px}</style>"
                + "</head><body><main><h1>" + title + "</h1><p>" + text + "</p></main></body></html>";
        byte[] body = html.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + (status == 200 ? "OK" : status == 404 ? "Not Found" : "Bad Request") + "\r\n"
                + "Content-Type: text/html; charset=utf-8\r\n"
                + "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n"
                + "Cache-Control: no-store\r\nConnection: close\r\nContent-Length: " + body.length + "\r\n\r\n";
        OutputStream out = s.getOutputStream();
        out.write(head.getBytes(StandardCharsets.US_ASCII));
        out.write(body);
        out.flush();
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> out = new HashMap<>();
        for (String part : q.split("&")) {
            int eq = part.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            try {
                out.put(URLDecoder.decode(part.substring(0, eq), "UTF-8"), URLDecoder.decode(part.substring(eq + 1), "UTF-8"));
            } catch (IOException | IllegalArgumentException ignored) {
                // malformed: skipped
            }
        }
        return out;
    }

    /** POST a form, JSON back; errors without secrets in them. */
    private static JSONObject tokenRequest(String url, Map<String, String> params) throws DriveException {
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "application/x-www-form-urlencoded");
        h.put("Accept", "application/json");
        Resp r = http("POST", url, h, form(params).getBytes(StandardCharsets.UTF_8));
        JSONObject j = r.json();
        if (r.status != 200 || j == null || j.optString("access_token", "").isEmpty()) {
            String code = j == null ? "HTTP " + r.status : j.optString("error", "HTTP " + r.status);
            code = code.replaceAll("[^\\w .-]", "");
            throw new DriveException("The login was refused (" + code.substring(0, Math.min(60, code.length())) + ").",
                    "invalid_grant".equals(code) ? 401 : r.status, false, false);
        }
        return j;
    }

    // --- the folder ---------------------------------------------------------------------------------

    /** The drive's Blockwise folder: list, read, write, remove (names checked). */
    static final class Folder {
        final String provider;
        final String refreshToken;
        private final Keys k;
        private String access;
        private long until;

        Folder(Context c, String provider, String refreshToken) {
            this.provider = provider;
            this.refreshToken = refreshToken;
            this.k = keys(c);
        }

        private boolean dropbox() {
            return DROPBOX.equals(provider);
        }

        private synchronized String token(boolean force) throws DriveException {
            if (!force && access != null && System.currentTimeMillis() < until - 60000) {
                return access;
            }
            Map<String, String> p = new LinkedHashMap<>();
            p.put("grant_type", "refresh_token");
            p.put("refresh_token", refreshToken);
            p.put("client_id", dropbox() ? k.dropboxAppKey : k.googleClientId);
            if (!dropbox()) {
                p.put("client_secret", k.googleClientSecret);
            }
            JSONObject t;
            try {
                t = tokenRequest(dropbox() ? DROPBOX_TOKEN : GOOGLE_TOKEN, p);
            } catch (DriveException e) {
                if (e.status == 401 || e.status == 400) {
                    throw new DriveException("The drive no longer accepts Blockwise. Connect it again.", 401, false, false);
                }
                throw e;
            }
            access = t.optString("access_token");
            long seconds = Math.min(t.optLong("expires_in", 3600), 4 * 3600);
            until = System.currentTimeMillis() + seconds * 1000;
            return access;
        }

        /** With the access token; one retry after a 401 (the token ended early). */
        private Resp authed(String method, String url, Map<String, String> headers, byte[] body) throws DriveException {
            for (int attempt = 0; attempt < 2; attempt++) {
                Map<String, String> h = new HashMap<>(headers == null ? new HashMap<>() : headers);
                h.put("Authorization", "Bearer " + token(attempt > 0));
                Resp r = http(method, url, h, body);
                if (r.status == 401 && attempt == 0) {
                    continue;
                }
                if (r.status == 401) {
                    throw new DriveException("The drive no longer accepts Blockwise. Connect it again.", 401, false, false);
                }
                if (r.status == 429 || r.status >= 500) {
                    throw new DriveException("The drive is busy. Blockwise tries again later.", r.status, false, true);
                }
                return r;
            }
            throw new DriveException("Unexpected answer from the drive.");
        }

        private static String check(String name) throws DriveException {
            if (name == null || !NAME.matcher(name).matches()) {
                throw new DriveException("Invalid file name");
            }
            return name;
        }

        private static String arg(JSONObject o) {
            // Dropbox-API-Arg must be ASCII
            StringBuilder sb = new StringBuilder();
            for (char ch : o.toString().toCharArray()) {
                if (ch > 126) {
                    sb.append(String.format(Locale.ROOT, "\\u%04x", (int) ch));
                } else {
                    sb.append(ch);
                }
            }
            return sb.toString();
        }

        private JSONObject rpc(String route, JSONObject body, int[] status) throws DriveException {
            Map<String, String> h = new HashMap<>();
            h.put("Content-Type", "application/json");
            Resp r = authed("POST", DROPBOX_API + route, h, body.toString().getBytes(StandardCharsets.UTF_8));
            status[0] = r.status;
            return r.json();
        }

        List<String> list() throws DriveException {
            List<String> names = new ArrayList<>();
            if (dropbox()) {
                int[] st = {0};
                try {
                    JSONObject d = rpc("files/list_folder", new JSONObject().put("path", "").put("limit", 2000), st);
                    for (int page = 0; page < 200; page++) {
                        JSONArray e = d == null ? null : d.optJSONArray("entries");
                        if (st[0] != 200 || e == null) {
                            throw new DriveException("Dropbox could not list the folder (HTTP " + st[0] + ").", st[0], false, false);
                        }
                        for (int i = 0; i < e.length(); i++) {
                            JSONObject f = e.optJSONObject(i);
                            if (f != null && "file".equals(f.optString(".tag")) && !f.optString("name").isEmpty()) {
                                names.add(f.optString("name"));
                            }
                        }
                        if (!d.optBoolean("has_more")) {
                            break;
                        }
                        d = rpc("files/list_folder/continue", new JSONObject().put("cursor", d.optString("cursor")), st);
                    }
                } catch (JSONException e) {
                    throw new DriveException("Unexpected answer from the drive.");
                }
                return names;
            }
            names.addAll(ids().keySet());
            return names;
        }

        /** Google: name -> its files, oldest first (Drive allows the same name twice) */
        private Map<String, List<String>> ids() throws DriveException {
            Map<String, List<String>> map = new LinkedHashMap<>();
            String pageToken = "";
            for (int page = 0; page < 200; page++) {
                Map<String, String> q = new LinkedHashMap<>();
                q.put("spaces", "appDataFolder");
                q.put("fields", "nextPageToken,files(id,name,createdTime)");
                q.put("pageSize", "1000");
                q.put("orderBy", "createdTime");
                if (!pageToken.isEmpty()) {
                    q.put("pageToken", pageToken);
                }
                Resp r = authed("GET", GOOGLE_FILES + "?" + form(q), null, null);
                JSONObject d = r.json();
                JSONArray files = d == null ? null : d.optJSONArray("files");
                if (r.status != 200 || files == null) {
                    throw new DriveException("Google Drive could not list the folder (HTTP " + r.status + ").", r.status, false, false);
                }
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.optJSONObject(i);
                    if (f == null || !ID.matcher(f.optString("id")).matches() || f.optString("name").isEmpty()) {
                        continue;
                    }
                    map.computeIfAbsent(f.optString("name"), x -> new ArrayList<>()).add(f.optString("id"));
                }
                pageToken = d.optString("nextPageToken", "");
                if (pageToken.isEmpty()) {
                    break;
                }
            }
            return map;
        }

        /** null if there is no such file */
        byte[] read(String name) throws DriveException {
            check(name);
            if (dropbox()) {
                Map<String, String> h = new HashMap<>();
                try {
                    h.put("Dropbox-API-Arg", arg(new JSONObject().put("path", "/" + name)));
                } catch (JSONException e) {
                    throw new DriveException("Invalid file name");
                }
                Resp r = authed("POST", DROPBOX_CONTENT + "files/download", h, null);
                if (r.status == 409) {
                    return null;
                }
                if (r.status != 200) {
                    throw new DriveException("Dropbox could not read a file (HTTP " + r.status + ").", r.status, false, false);
                }
                return r.body;
            }
            List<String> found = ids().get(name);
            if (found == null) {
                return null;
            }
            Resp r = authed("GET", GOOGLE_FILES + "/" + found.get(0) + "?alt=media", null, null);
            if (r.status == 404) {
                return null;
            }
            if (r.status != 200) {
                throw new DriveException("Google Drive could not read a file (HTTP " + r.status + ").", r.status, false, false);
            }
            return r.body;
        }

        void write(String name, byte[] bytes, boolean create) throws DriveException {
            check(name);
            if (bytes.length > MAX_FILE) {
                throw new DriveException("A sync file is too large.");
            }
            if (dropbox()) {
                Map<String, String> h = new HashMap<>();
                h.put("Content-Type", "application/octet-stream");
                try {
                    h.put("Dropbox-API-Arg", arg(new JSONObject().put("path", "/" + name).put("mode", create ? "add" : "overwrite").put("autorename", false).put("mute", true)));
                } catch (JSONException e) {
                    throw new DriveException("Invalid file name");
                }
                Resp r = authed("POST", DROPBOX_CONTENT + "files/upload", h, bytes);
                if (r.status == 409 && create) {
                    throw new DriveException("exists", 409, true, false);
                }
                if (r.status != 200) {
                    throw new DriveException("Dropbox could not save a file (HTTP " + r.status + ").", r.status, false, false);
                }
                return;
            }
            List<String> existing = ids().get(name);
            if (existing != null && create) {
                throw new DriveException("exists", 409, true, false);
            }
            String boundary = "blockwise" + b64url(random(12)).replace("-", "a").replace("_", "b");
            String meta;
            try {
                meta = existing != null ? new JSONObject().put("name", name).toString()
                        : new JSONObject().put("name", name).put("parents", new JSONArray().put("appDataFolder")).toString();
            } catch (JSONException e) {
                throw new DriveException("Invalid file name");
            }
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] head = ("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n--" + boundary
                    + "\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8);
            body.write(head, 0, head.length);
            body.write(bytes, 0, bytes.length);
            byte[] tail = ("\r\n--" + boundary + "--").getBytes(StandardCharsets.UTF_8);
            body.write(tail, 0, tail.length);
            Map<String, String> h = new HashMap<>();
            h.put("Content-Type", "multipart/related; boundary=" + boundary);
            // PATCH isn't supported by HttpURLConnection: Google's method override
            String url = existing != null ? GOOGLE_UPLOAD + "/" + existing.get(0) + "?uploadType=multipart" : GOOGLE_UPLOAD + "?uploadType=multipart";
            if (existing != null) {
                h.put("X-HTTP-Method-Override", "PATCH");
            }
            Resp r = authed("POST", url, h, body.toByteArray());
            if (r.status != 200) {
                throw new DriveException("Google Drive could not save a file (HTTP " + r.status + ").", r.status, false, false);
            }
            if (create) {
                // Two devices made the same file at the same moment: the oldest one counts
                List<String> now = ids().get(name);
                JSONObject mine = r.json();
                String id = mine == null ? "" : mine.optString("id", "");
                if (now != null && now.size() > 1 && !now.get(0).equals(id)) {
                    if (ID.matcher(id).matches()) {
                        try {
                            delete(id);
                        } catch (DriveException ignored) {
                            // left for later
                        }
                    }
                    throw new DriveException("exists", 409, true, false);
                }
            }
        }

        private void delete(String id) throws DriveException {
            Resp r = authed("DELETE", GOOGLE_FILES + "/" + id, null, null);
            if (r.status != 204 && r.status != 200 && r.status != 404) {
                throw new DriveException("Google Drive could not remove a file (HTTP " + r.status + ").", r.status, false, false);
            }
        }

        void remove(String name) throws DriveException {
            check(name);
            if (dropbox()) {
                int[] st = {0};
                try {
                    rpc("files/delete_v2", new JSONObject().put("path", "/" + name), st);
                } catch (JSONException e) {
                    throw new DriveException("Invalid file name");
                }
                if (st[0] != 200 && st[0] != 409) {
                    throw new DriveException("Dropbox could not remove a file (HTTP " + st[0] + ").", st[0], false, false);
                }
                return;
            }
            List<String> found = ids().get(name);
            for (String id : found == null ? new ArrayList<String>() : found) {
                delete(id);
            }
        }

        /** Google: which account (an id, no name or e-mail), so another account's data is not mixed in */
        String account() {
            if (dropbox()) {
                return null;
            }
            try {
                JSONObject d = authed("GET", GOOGLE_ABOUT, null, null).json();
                JSONObject u = d == null ? null : d.optJSONObject("user");
                String id = u == null ? "" : u.optString("permissionId", "").replaceAll("[^\\w-]", "");
                return id.isEmpty() ? null : id.substring(0, Math.min(64, id.length()));
            } catch (DriveException e) {
                return null;
            }
        }

        // --- watching the folder for other devices' changes ---

        /** Where the folder is now, to look for changes from there */
        String changeCursor() throws DriveException {
            if (dropbox()) {
                int[] st = {0};
                JSONObject d;
                try {
                    d = rpc("files/list_folder/get_latest_cursor", new JSONObject().put("path", ""), st);
                } catch (JSONException e) {
                    throw new DriveException("Unexpected answer from the drive.");
                }
                if (st[0] != 200 || d == null || d.optString("cursor", "").isEmpty()) {
                    throw new DriveException("Dropbox could not watch the folder (HTTP " + st[0] + ").", st[0], false, false);
                }
                return d.optString("cursor");
            }
            Resp r = authed("GET", GOOGLE_CHANGES + "/startPageToken", null, null);
            JSONObject d = r.json();
            if (r.status != 200 || d == null || d.optString("startPageToken", "").isEmpty()) {
                throw new DriveException("Google Drive could not watch the folder (HTTP " + r.status + ").", r.status, false, false);
            }
            return d.optString("startPageToken");
        }

        /**
         * Has anything changed since `cursor`, at once (the background check: no
         * connection held open, so the phone can sleep again right away).
         * Dropbox: one look at the folder's list; Google Drive: as changes().
         */
        JSONObject changesNow(String cursor) throws DriveException {
            if (!dropbox()) {
                return changes(cursor, 0);
            }
            if (cursor == null || cursor.isEmpty() || cursor.length() > 4096) {
                throw new DriveException("The folder's watch cursor expired.", 409, false, false);
            }
            int[] st = {0};
            try {
                boolean changed = false;
                String c = cursor;
                for (int page = 0; page < 50; page++) {
                    JSONObject d = rpc("files/list_folder/continue", new JSONObject().put("cursor", c), st);
                    if (st[0] == 409) {
                        throw new DriveException("The folder's watch cursor expired.", 409, false, false);
                    }
                    if (st[0] != 200 || d == null) {
                        throw new DriveException("The drive is busy. Blockwise tries again later.", st[0], false, true);
                    }
                    JSONArray e = d.optJSONArray("entries");
                    changed |= e != null && e.length() > 0;
                    c = d.optString("cursor", c);
                    if (!d.optBoolean("has_more")) {
                        break;
                    }
                }
                return new JSONObject().put("changed", changed).put("cursor", c).put("retryAfter", 0);
            } catch (JSONException e) {
                throw new DriveException("Unexpected answer from the drive.");
            }
        }

        /**
         * Has anything changed since `cursor`? Dropbox: waits up to `seconds` and
         * answers at the change (only the cursor is sent, no token). Google
         * Drive: one look at the app data folder's change list, at once.
         * @return {changed, cursor, retryAfter seconds}; status 409 = the cursor expired
         */
        JSONObject changes(String cursor, int seconds) throws DriveException {
            if (cursor == null || cursor.isEmpty() || cursor.length() > 4096) {
                throw new DriveException("The folder's watch cursor expired.", 409, false, false);
            }
            try {
                if (dropbox()) {
                    Map<String, String> h = new HashMap<>();
                    h.put("Content-Type", "application/json");
                    int timeout = Math.max(30, Math.min(480, seconds));
                    Resp r = http("POST", DROPBOX_NOTIFY, h, new JSONObject().put("cursor", cursor).put("timeout", timeout).toString().getBytes(StandardCharsets.UTF_8), timeout + 90);
                    JSONObject d = r.json();
                    if (r.status == 400 || r.status == 409) {
                        throw new DriveException("The folder's watch cursor expired.", 409, false, false);
                    }
                    if (r.status != 200 || d == null) {
                        throw new DriveException("The drive is busy. Blockwise tries again later.", r.status, false, true);
                    }
                    boolean changed = d.optBoolean("changes", false);
                    return new JSONObject().put("changed", changed).put("cursor", changed ? changeCursor() : cursor)
                            .put("retryAfter", Math.min(3600, d.optInt("backoff", 0)));
                }
                String token = cursor;
                boolean changed = false;
                for (int page = 0; page < 50; page++) {
                    Map<String, String> q = new LinkedHashMap<>();
                    q.put("pageToken", token);
                    q.put("spaces", "appDataFolder");
                    q.put("pageSize", "100");
                    q.put("fields", "nextPageToken,newStartPageToken,changes(fileId)");
                    Resp r = authed("GET", GOOGLE_CHANGES + "?" + form(q), null, null);
                    JSONObject d = r.json();
                    if (r.status == 400 || r.status == 404) {
                        throw new DriveException("The folder's watch cursor expired.", 409, false, false);
                    }
                    if (r.status != 200 || d == null) {
                        throw new DriveException("Google Drive could not watch the folder (HTTP " + r.status + ").", r.status, false, false);
                    }
                    JSONArray ch = d.optJSONArray("changes");
                    changed |= ch != null && ch.length() > 0;
                    if (!d.optString("newStartPageToken", "").isEmpty()) {
                        return new JSONObject().put("changed", changed).put("cursor", d.optString("newStartPageToken")).put("retryAfter", 0);
                    }
                    if (d.optString("nextPageToken", "").isEmpty()) {
                        break;
                    }
                    token = d.optString("nextPageToken");
                }
                return new JSONObject().put("changed", changed).put("cursor", token).put("retryAfter", 0);
            } catch (JSONException e) {
                throw new DriveException("Unexpected answer from the drive.");
            }
        }

        /** Disconnecting: the token stops working (offline: forgotten anyway) */
        void revoke() {
            try {
                if (dropbox()) {
                    authed("POST", DROPBOX_API + "auth/token/revoke", null, null);
                } else {
                    Map<String, String> h = new HashMap<>();
                    h.put("Content-Type", "application/x-www-form-urlencoded");
                    Map<String, String> p = new HashMap<>();
                    p.put("token", refreshToken);
                    http("POST", GOOGLE_REVOKE, h, form(p).getBytes(StandardCharsets.UTF_8));
                }
            } catch (DriveException ignored) {
                // offline
            }
        }
    }

    // --- http ----------------------------------------------------------------------------------------

    static final class Resp {
        int status;
        byte[] body;

        JSONObject json() {
            try {
                return new JSONObject(new String(body, StandardCharsets.UTF_8));
            } catch (JSONException e) {
                return null;
            }
        }
    }

    private static Resp http(String method, String url, Map<String, String> headers, byte[] body) throws DriveException {
        return http(method, url, headers, body, 60);
    }

    private static Resp http(String method, String url, Map<String, String> headers, byte[] body, int readSeconds) throws DriveException {
        HttpURLConnection con = null;
        try {
            con = (HttpURLConnection) new URL(url).openConnection();
            con.setInstanceFollowRedirects(false);
            con.setConnectTimeout(20000);
            con.setReadTimeout(readSeconds * 1000);
            con.setUseCaches(false);
            con.setRequestMethod(method);
            if (headers != null) {
                for (Map.Entry<String, String> e : headers.entrySet()) {
                    con.setRequestProperty(e.getKey(), e.getValue());
                }
            }
            if (body != null) {
                con.setDoOutput(true);
                con.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = con.getOutputStream()) {
                    out.write(body);
                }
            } else if ("POST".equals(method)) {
                con.setDoOutput(true);
                con.setFixedLengthStreamingMode(0);
                con.getOutputStream().close();
            }
            Resp r = new Resp();
            r.status = con.getResponseCode();
            if (con.getContentLengthLong() > MAX_FILE) {
                throw new DriveException("A sync file is too large.");
            }
            InputStream in = r.status >= 400 ? con.getErrorStream() : con.getInputStream();
            r.body = in == null ? new byte[0] : readAll(in, MAX_FILE);
            return r;
        } catch (IOException e) {
            throw new DriveException("No connection to the drive.", 0, false, true);
        } finally {
            if (con != null) {
                con.disconnect();
            }
        }
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) != -1) {
                out.write(buf, 0, n);
                if (out.size() > max) {
                    throw new IOException("too large");
                }
            }
            return out.toByteArray();
        }
    }

    private static String form(Map<String, String> params) {
        StringBuilder sb = new StringBuilder();
        try {
            for (Map.Entry<String, String> e : params.entrySet()) {
                if (sb.length() > 0) {
                    sb.append('&');
                }
                sb.append(URLEncoder.encode(e.getKey(), "UTF-8")).append('=').append(URLEncoder.encode(e.getValue(), "UTF-8"));
            }
        } catch (IOException e) {
            // UTF-8 is always there
        }
        return sb.toString();
    }

    private static byte[] random(int n) {
        byte[] b = new byte[n];
        new SecureRandom().nextBytes(b);
        return b;
    }

    private static String b64url(byte[] b) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(b);
    }
}
