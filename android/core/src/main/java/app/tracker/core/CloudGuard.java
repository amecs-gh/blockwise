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

    public static boolean google(String method, String path) {
        if (method == null || path == null || path.length() > 1500 || path.contains("..") || path.contains("%2e%2e") || path.contains("%2E%2E")
                || path.contains("%2f") || path.contains("%2F") || path.contains("//")) {
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
}
