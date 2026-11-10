package app.tracker.core;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The Nextcloud address: normalizing what you type, and keeping the login flow
 * on that address. Same rules as the Mac app.
 */
public final class ServerUrl {
    private ServerUrl() {
    }

    /** Thrown with a message that can be shown as is (translated by the caller). */
    public static final class InvalidServer extends Exception {
        public InvalidServer(String message) {
            super(message);
        }
    }

    private static final Pattern HAS_SCHEME = Pattern.compile("^[a-zA-Z][a-zA-Z0-9+.-]*://.*");
    private static final Pattern LOCAL_START = Pattern.compile("^(localhost|127\\.|\\[::1\\]|10\\.0\\.2\\.2)", Pattern.CASE_INSENSITIVE);

    /** This phone (or the emulator's view of the computer it runs on). */
    static boolean isLoopback(String host) {
        String h = host.toLowerCase(Locale.ROOT);
        return h.equals("localhost") || h.matches("127(\\.\\d+){3}") || h.equals("[::1]") || h.equals("::1") || h.equals("10.0.2.2");
    }

    /** Tailscale MagicDNS names: the tunnel itself is encrypted. */
    static boolean isTailnetName(String host) {
        return host.toLowerCase(Locale.ROOT).endsWith(".ts.net");
    }

    /**
     * "cloud.example.com/" -> "https://cloud.example.com". Plain http only for
     * this phone and Tailscale names (Android's network security config allows
     * exactly these), since the app password would otherwise travel unencrypted.
     */
    public static String normalize(String input) throws InvalidServer {
        String s = input == null ? "" : input.trim();
        if (s.isEmpty()) {
            throw new InvalidServer("Enter the address of your Nextcloud.");
        }
        if (!HAS_SCHEME.matcher(s).matches()) {
            s = (LOCAL_START.matcher(s).find() ? "http://" : "https://") + s;
        }
        URI uri;
        try {
            uri = new URI(s);
        } catch (URISyntaxException e) {
            throw new InvalidServer("That is not a valid address.");
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) {
            throw new InvalidServer("Use an https:// address.");
        }
        String host = uri.getHost();
        if (host == null || host.isEmpty()) {
            throw new InvalidServer("That is not a valid address.");
        }
        if (scheme.equals("http") && !isLoopback(host) && !isTailnetName(host)) {
            throw new InvalidServer("Use an https:// address: over plain http your password could be read on the network.");
        }
        // Drop a pasted page path like /index.php/apps/files (and any user:password@)
        String path = uri.getRawPath() == null ? "" : uri.getRawPath();
        path = path.replaceAll("/index\\.php(/.*)?$", "").replaceAll("/+$", "");
        String hostPart = host.contains(":") && !host.startsWith("[") ? "[" + host + "]" : host;
        int port = uri.getPort();
        return scheme + "://" + hostPart.toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "") + path;
    }

    /** "https://host:port" of a normalized server address. */
    public static String origin(String server) {
        URI u = URI.create(server);
        return u.getScheme() + "://" + u.getRawAuthority();
    }

    /**
     * Nextcloud's login flow answers with absolute URLs. They are rebuilt on the
     * address you entered, so the login page and the token never go to another
     * host (a misconfigured or hostile server could name any URL there).
     */
    public static String onServer(String server, String value) throws InvalidServer {
        try {
            URI base = URI.create(server + "/");
            URI u = base.resolve(new URI(value.trim()));
            String path = u.getRawPath() == null ? "" : u.getRawPath();
            String query = u.getRawQuery() == null ? "" : "?" + u.getRawQuery();
            return origin(server) + path + query;
        } catch (URISyntaxException | IllegalArgumentException e) {
            throw new InvalidServer("This doesn't look like a Nextcloud server.");
        }
    }

    /** Is this URL on the given server (same scheme, host and port)? */
    public static boolean sameOrigin(String server, String url) {
        try {
            URI u = new URI(url);
            if (u.getScheme() == null || u.getRawAuthority() == null) {
                return false;
            }
            return (u.getScheme().toLowerCase(Locale.ROOT) + "://" + u.getRawAuthority().toLowerCase(Locale.ROOT))
                    .equals(origin(server).toLowerCase(Locale.ROOT));
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
