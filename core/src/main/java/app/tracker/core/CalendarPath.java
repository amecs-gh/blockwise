package app.tracker.core;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;

/**
 * Matching a calendar on the phone (synced by DAVx5 or similar, which keeps
 * the calendar's full address) to a commitment's calendar address on the
 * server ("/remote.php/dav/calendars/<user>/<calendar>/").
 */
public final class CalendarPath {
    private CalendarPath() {
    }

    private static final String DAV = "/remote.php/dav/calendars/";

    /**
     * The "/remote.php/dav/calendars/<user>/<calendar>/" part of an address,
     * percent-decoded, or null if it isn't a Nextcloud calendar's address.
     */
    public static String of(String address) {
        if (address == null) {
            return null;
        }
        int q = address.indexOf('?');
        if (q >= 0) {
            address = address.substring(0, q);
        }
        int at = address.indexOf(DAV);
        if (at < 0) {
            return null;
        }
        String rest = address.substring(at + DAV.length());
        if (rest.endsWith("/")) {
            rest = rest.substring(0, rest.length() - 1);
        }
        String[] parts = rest.split("/", -1);
        if (parts.length != 2 || parts[0].isEmpty() || parts[1].isEmpty()) {
            return null;
        }
        try {
            String user = URLDecoder.decode(parts[0].replace("+", "%2B"), "UTF-8");
            String cal = URLDecoder.decode(parts[1].replace("+", "%2B"), "UTF-8");
            if (user.contains("/") || cal.contains("/")) {
                return null;
            }
            return DAV + user + "/" + cal + "/";
        } catch (UnsupportedEncodingException | IllegalArgumentException e) {
            return null;
        }
    }

    /** Do two addresses name the same Nextcloud calendar? */
    public static boolean same(String a, String b) {
        String pa = of(a);
        return pa != null && pa.equals(of(b));
    }
}
