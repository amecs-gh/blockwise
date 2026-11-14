package app.tracker.core;

import java.util.regex.Pattern;

/**
 * What the app's page may ask the account's calendar for (Google Calendar; the
 * login also opens its Drive app folder, which the page never reaches this way).
 * Only the calendar requests Blockwise makes (js/cloudcal.js): its calendars,
 * their events, and the calendar's color. Ids and query values are checked, so
 * a path can't step elsewhere ("..", other APIs) or carry anything unexpected.
 * The login (calendar.app.created) only reaches calendars Blockwise made anyway.
 */
public final class CloudGuard {
    private CloudGuard() {
    }

    /** A calendar id as it appears in a path: URL-encoded (alice%40gmail.com, x%40group.calendar.google.com) */
    private static final String CAL = "[A-Za-z0-9%._-]{1,300}";
    /** An event id (Google: lowercase base32hex; an occurrence adds _20261116T090000Z) */
    private static final String EVENT = "[A-Za-z0-9_%-]{1,300}";
    private static final String VALUE = "[A-Za-z0-9:._%+-]{0,300}";
    private static final String EVENTS_QUERY = "(timeMin|timeMax|singleEvents|maxResults|showDeleted|orderBy|pageToken)=" + VALUE;

    private static final Pattern GOOGLE_GET = Pattern.compile(
            "^calendars/" + CAL + "/events(\\?" + EVENTS_QUERY + "(&" + EVENTS_QUERY + "){0,7})?$"
            + "|^calendars/" + CAL + "/events/" + EVENT + "$");
    private static final Pattern GOOGLE_POST = Pattern.compile(
            "^calendars$|^calendars/" + CAL + "/events$|^calendars/" + CAL + "/events/" + EVENT + "/move\\?destination=" + CAL + "$");
    private static final Pattern GOOGLE_PATCH = Pattern.compile(
            "^calendars/" + CAL + "/events/" + EVENT + "$|^users/me/calendarList/" + CAL + "\\?colorRgbFormat=true$");
    private static final Pattern GOOGLE_DELETE = Pattern.compile(
            "^calendars/" + CAL + "$|^calendars/" + CAL + "/events/" + EVENT + "$");

    private static boolean odd(String method, String path) {
        return method == null || path == null || path.length() > 1500 || path.contains("..") || path.contains("%2e%2e") || path.contains("%2E%2E")
                || path.contains("%2f") || path.contains("%2F") || path.contains("%5c") || path.contains("%5C") || path.contains("//");
    }

    public static boolean google(String method, String path) {
        if (odd(method, path)) {
            return false;
        }
        switch (method) {
            case "GET":
                return GOOGLE_GET.matcher(path).matches();
            case "POST":
                return GOOGLE_POST.matcher(path).matches();
            case "PATCH":
                return GOOGLE_PATCH.matcher(path).matches();
            case "DELETE":
                return GOOGLE_DELETE.matcher(path).matches();
            default:
                return false;
        }
    }

    // --- Outlook (Microsoft Graph, below https://graph.microsoft.com/v1.0/) ---
    //
    // Microsoft has no "only the calendars this app made" permission: the login's
    // Calendars.ReadWrite reaches every calendar. So the app adds the guard itself:
    // a path names its calendar, and a calendar is only reached once the app knows
    // it is Blockwise's (made on this device, or carrying Blockwise's mark, set by
    // the app when it makes one: GRAPH_MARK). Bodies only carry GRAPH_EVENT_FIELDS
    // (no attendees: nothing is ever sent to anyone).

    /** The mark on the calendars Blockwise makes (a named extended property) */
    public static final String GRAPH_MARK = "String {5d0c2a3e-8b1f-4f6a-9c47-2e7b3a91d6f4} Name BlockwiseCalendar";
    public static final String GRAPH_MARK_VALUE = "blockwise";
    public static final String[] GRAPH_EVENT_FIELDS = {"subject", "start", "end", "recurrence"};
    public static final String[] GRAPH_CALENDAR_FIELDS = {"name", "color"};

    private static final String GID = "[A-Za-z0-9%._=-]{1,300}";
    private static final String TIME = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z";
    private static final String SELECT = "\\$select=[A-Za-z,]{1,200}";
    private static final String RANGE = "startDateTime=" + TIME + "&endDateTime=" + TIME + "&\\$top=[0-9]{1,4}&" + SELECT;
    private static final Pattern GRAPH_GET = Pattern.compile(
            "^me/calendars/" + GID + "/calendarView\\?" + RANGE + "(&\\$skip=[0-9]{1,6})?$"
            + "|^me/calendars/" + GID + "/events/" + GID + "\\?" + SELECT + "$"
            + "|^me/calendars/" + GID + "/events/" + GID + "/instances\\?" + RANGE + "$");
    private static final Pattern GRAPH_POST = Pattern.compile("^me/calendars$|^me/calendars/" + GID + "/events$");
    private static final Pattern GRAPH_PATCH = Pattern.compile("^me/calendars/" + GID + "/events/" + GID + "$");
    private static final Pattern GRAPH_DELETE = Pattern.compile("^me/calendars/" + GID + "$|^me/calendars/" + GID + "/events/" + GID + "$");

    public static boolean microsoft(String method, String path) {
        if (odd(method, path)) {
            return false;
        }
        switch (method) {
            case "GET":
                return GRAPH_GET.matcher(path).matches();
            case "POST":
                return GRAPH_POST.matcher(path).matches();
            case "PATCH":
                return GRAPH_PATCH.matcher(path).matches();
            case "DELETE":
                return GRAPH_DELETE.matcher(path).matches();
            default:
                return false;
        }
    }

    /** The calendar a (checked) Graph path is about, decoded; null for making one (me/calendars) */
    public static String graphCalendar(String path) {
        if (path == null || !path.startsWith("me/calendars/")) {
            return null;
        }
        String rest = path.substring("me/calendars/".length());
        int end = rest.length();
        for (char ch : new char[] {'/', '?'}) {
            int i = rest.indexOf(ch);
            if (i >= 0 && i < end) {
                end = i;
            }
        }
        return decode(rest.substring(0, end));
    }

    /** %XX decoded (a "+" stays a "+"); null if malformed or not plain ASCII */
    public static String decode(String s) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == '%') {
                if (i + 2 >= s.length()) {
                    return null;
                }
                int v;
                try {
                    v = Integer.parseInt(s.substring(i + 1, i + 3), 16);
                } catch (NumberFormatException e) {
                    return null;
                }
                if (v < 0x20 || v > 0x7e) {
                    return null;
                }
                out.append((char) v);
                i += 2;
            } else {
                out.append(ch);
            }
        }
        return out.toString();
    }

    /** The calendar's own path segment for an id (as the page encodes it) */
    public static String encode(String id) {
        StringBuilder out = new StringBuilder();
        for (char ch : id.toCharArray()) {
            if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.') {
                out.append(ch);
            } else if (ch < 0x80) {
                out.append(String.format(java.util.Locale.ROOT, "%%%02X", (int) ch));
            } else {
                return null;
            }
        }
        return out.toString();
    }
}
