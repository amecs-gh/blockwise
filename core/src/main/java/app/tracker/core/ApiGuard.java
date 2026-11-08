package app.tracker.core;

import java.util.regex.Pattern;

/**
 * What the app's page may ask the server for with the app password. Tracker
 * works on the phone (local-first), so the page only needs the sync endpoints
 * and, as a fallback for calendars the phone doesn't have, Tracker's calendar
 * list and blocks (read only). Nothing else: the app password could otherwise
 * reach your files.
 */
public final class ApiGuard {
    private ApiGuard() {
    }

    private static final Pattern GET = Pattern.compile(
            "^(sync\\?since=\\d{1,18}&limit=\\d{1,5}|state|blocks\\?from=\\d{1,12}&to=\\d{1,12})$");

    public static boolean allowed(String method, String path) {
        if (method == null || path == null || path.length() > 100) {
            return false;
        }
        if ("GET".equals(method)) {
            return GET.matcher(path).matches();
        }
        return "POST".equals(method) && "sync".equals(path);
    }
}
