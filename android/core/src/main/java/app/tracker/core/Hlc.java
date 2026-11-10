package app.tracker.core;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Clock values for changes, the same format as the engine's and the server's
 * ("<ms, 13 digits>-<counter, 4 hex>-<node>"), ordered as strings. Used for the
 * changes the app makes without the page (Stop in the notification).
 */
public final class Hlc {
    private Hlc() {
    }

    public static final Pattern VALID = Pattern.compile("^(\\d{13})-([0-9a-f]{4})-[A-Za-z0-9_-]{1,32}$");
    private static final Pattern NODE = Pattern.compile("^[A-Za-z0-9_-]{1,31}$");

    /** The next clock after `prev` (any node's, may be null) for `node`, at `nowMs`. */
    public static String next(String prev, long nowMs, String node) {
        if (node == null || !NODE.matcher(node).matches()) {
            throw new IllegalArgumentException("node");
        }
        long ms = 0;
        int counter = 0;
        if (prev != null) {
            Matcher m = VALID.matcher(prev);
            if (m.matches()) {
                ms = Long.parseLong(m.group(1));
                counter = Integer.parseInt(m.group(2), 16);
            }
        }
        if (nowMs > ms) {
            return format(nowMs, 0, node);
        }
        return format(ms, Math.min(counter + 1, 0xffff), node);
    }

    /** The later of two clocks (null if both are missing or invalid). */
    public static String max(String a, String b) {
        boolean va = a != null && VALID.matcher(a).matches();
        boolean vb = b != null && VALID.matcher(b).matches();
        if (!va) {
            return vb ? b : null;
        }
        if (!vb) {
            return a;
        }
        return a.compareTo(b) >= 0 ? a : b;
    }

    private static String format(long ms, int counter, String node) {
        return String.format(Locale.ROOT, "%013d-%04x-%s", ms, counter, node);
    }
}
