package app.tracker.android;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;

import app.tracker.core.I18n;
import app.tracker.core.Vars;
import app.tracker.core.ServerUrl;

/**
 * Talking to Nextcloud: login flow v2 (gives an app password) and the Blockwise
 * API with Basic auth. Redirects are never followed, so the password never
 * goes to another address. Blocking calls: run them off the main thread.
 */
final class Nextcloud {
    static final String USER_AGENT = "Blockwise for Android";
    private static final int TIMEOUT_MS = 20000;
    private static final int MAX_BODY = 8 * 1024 * 1024;

    static final class ApiException extends Exception {
        final int status;

        ApiException(String message, int status) {
            super(message);
            this.status = status;
        }
    }

    final String server;
    private final String auth;

    Nextcloud(String server, String loginName, String appPassword) {
        this.server = server;
        this.auth = "Basic " + Base64.getEncoder().encodeToString((loginName + ":" + appPassword).getBytes(StandardCharsets.UTF_8));
    }

    static String host(String server) {
        try {
            return new URL(server).getHost();
        } catch (IOException e) {
            return server;
        }
    }

    private static final class Response {
        final int status;
        final String body;

        Response(int status, String body) {
            this.status = status;
            this.body = body;
        }
    }

    private static Response request(String url, String method, Map<String, String> headers, byte[] body) throws IOException {
        URL u = new URL(url);
        requireTailnet(u);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        try {
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(TIMEOUT_MS);
            c.setReadTimeout(TIMEOUT_MS);
            c.setRequestMethod(method);
            c.setRequestProperty("User-Agent", USER_AGENT);
            for (Map.Entry<String, String> h : headers.entrySet()) {
                c.setRequestProperty(h.getKey(), h.getValue());
            }
            if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body);
                }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            return new Response(status, in == null ? "" : read(in));
        } finally {
            c.disconnect();
        }
    }

    /**
     * Plain http is allowed to Tailscale names (*.ts.net) because the tunnel is
     * encrypted. Without Tailscale on, someone else on the network could answer
     * for that name and get the app password in the clear: so the name must
     * lead to a Tailscale address, or nothing is sent (as if offline).
     */
    static void requireTailnet(URL u) throws IOException {
        if (!"http".equalsIgnoreCase(u.getProtocol()) || !u.getHost().toLowerCase(java.util.Locale.ROOT).endsWith(".ts.net")) {
            return;
        }
        java.net.InetAddress[] all = java.net.InetAddress.getAllByName(u.getHost());
        for (java.net.InetAddress a : all) {
            if (!ServerUrl.isTailnetAddress(a.getAddress())) {
                throw new IOException("Not connected through Tailscale");
            }
        }
    }

    private static String read(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BODY) {
                    throw new IOException("Response too large");
                }
            }
            return out.toString("UTF-8");
        }
    }

    /**
     * @param bodyJson JSON object text, or null
     * @return the response body (JSON text)
     */
    String api(String method, String path, String bodyJson, I18n t) throws ApiException {
        Response r;
        try {
            r = request(server + "/index.php/apps/tracker/api/" + path, method,
                    bodyJson != null
                            ? Vars.of("Authorization", auth, "OCS-APIRequest", "true", "Accept", "application/json", "Content-Type", "application/json")
                            : Vars.of("Authorization", auth, "OCS-APIRequest", "true", "Accept", "application/json"),
                    bodyJson != null ? bodyJson.getBytes(StandardCharsets.UTF_8) : null);
        } catch (IOException e) {
            throw new ApiException(t.t("Can't reach {host}. Check the address and your connection (and Tailscale).", Vars.of("host", host(server))), 0);
        }
        if (r.status >= 300 && r.status < 400) {
            throw new ApiException(t.t("Nextcloud redirected the request. Use the address Nextcloud is reachable at."), r.status);
        }
        if (r.status == 401) {
            throw new ApiException(t.t("Nextcloud rejected the app password. Log in again."), 401);
        }
        if (r.status == 503) {
            throw new ApiException(t.t("Nextcloud is in maintenance mode or updating."), 503);
        }
        if (r.status >= 400) {
            String message = null;
            try {
                message = new JSONObject(r.body).optString("message", null);
            } catch (JSONException ignored) {
                // not JSON
            }
            if (message == null && r.status == 404) {
                message = t.t("The Blockwise app is not enabled on this Nextcloud.");
            }
            throw new ApiException(message != null ? message : t.t("Request failed (HTTP {status}).", Vars.of("status", String.valueOf(r.status))), r.status);
        }
        return r.body.isEmpty() ? "null" : r.body;
    }

    /** Removes this app password on the server (log out). Errors are ignored. */
    void revoke() {
        try {
            request(server + "/ocs/v2.php/core/apppassword", "DELETE", Vars.of("Authorization", auth, "OCS-APIRequest", "true"), null);
        } catch (IOException ignored) {
            // offline: forget it locally anyway
        }
    }

    // --- login flow v2 ---

    static final class LoginFlow {
        final String server;
        final String loginUrl;
        final String pollUrl;
        final String token;
        volatile boolean cancelled;

        LoginFlow(String server, String loginUrl, String pollUrl, String token) {
            this.server = server;
            this.loginUrl = loginUrl;
            this.pollUrl = pollUrl;
            this.token = token;
        }
    }

    static LoginFlow startLoginFlow(String server, I18n t) throws ApiException {
        Response r;
        try {
            r = request(server + "/index.php/login/v2", "POST", Vars.of("Accept", "application/json"), new byte[0]);
        } catch (IOException e) {
            throw new ApiException(t.t("Can't reach {host}. Check the address and your connection (and Tailscale).", Vars.of("host", host(server))), 0);
        }
        String notNextcloud = t.t("This doesn't look like a Nextcloud server.");
        if (r.status != 200) {
            throw new ApiException(notNextcloud + " (HTTP " + r.status + ")", r.status);
        }
        try {
            JSONObject d = new JSONObject(r.body);
            JSONObject poll = d.getJSONObject("poll");
            // Pinned to the address you entered (see ServerUrl.onServer)
            String loginUrl = ServerUrl.onServer(server, d.getString("login"));
            String pollUrl = ServerUrl.onServer(server, poll.getString("endpoint"));
            String token = poll.getString("token");
            if (!loginUrl.contains("/login/v2/flow/") || !pollUrl.endsWith("/login/v2/poll") || token.isEmpty()) {
                throw new ApiException(notNextcloud, 0);
            }
            return new LoginFlow(server, loginUrl, pollUrl, token);
        } catch (JSONException | ServerUrl.InvalidServer e) {
            throw new ApiException(notNextcloud, 0);
        }
    }

    private static String encode(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (java.io.UnsupportedEncodingException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Polls until you granted access; returns { loginName, appPassword }. */
    static String[] poll(LoginFlow flow, I18n t) throws ApiException {
        long deadline = System.currentTimeMillis() + 20 * 60 * 1000;
        byte[] body = ("token=" + encode(flow.token)).getBytes(StandardCharsets.UTF_8);
        while (!flow.cancelled && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
            if (flow.cancelled) {
                break;
            }
            Response r;
            try {
                r = request(flow.pollUrl, "POST", Vars.of("Content-Type", "application/x-www-form-urlencoded"), body);
            } catch (IOException e) {
                continue; // network hiccup: keep polling
            }
            if (r.status == 200) {
                try {
                    JSONObject cred = new JSONObject(r.body);
                    String login = cred.getString("loginName");
                    String pw = cred.getString("appPassword");
                    if (login.isEmpty() || pw.isEmpty()) {
                        throw new JSONException("empty");
                    }
                    return new String[] {login, pw};
                } catch (JSONException e) {
                    throw new ApiException(t.t("This doesn't look like a Nextcloud server."), 0);
                }
            }
        }
        throw new ApiException(flow.cancelled ? t.t("Login cancelled.") : t.t("Login timed out."), 0);
    }
}
