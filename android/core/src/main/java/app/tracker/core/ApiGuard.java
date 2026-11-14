package app.tracker.core;

import java.util.regex.Pattern;

/**
 * What the app's page may ask the server for with the app password. Tracker
 * works on the phone (local-first), so the page only needs the sync endpoints
 * and, for calendars the phone doesn't have, Tracker's calendar list and its
 * blocks (planned, moved or deleted on the phone while offline are sent when
 * Nextcloud answers again). Nothing else: the app password could otherwise
 * reach your files.
 */
public final class ApiGuard {
    private ApiGuard() {
    }

    private static final Pattern GET = Pattern.compile(
            "^(sync\\?since=\\d{1,18}&limit=\\d{1,5}|state|blocks\\?from=\\d{1,12}&to=\\d{1,12})$");

    /** One block (Tracker's id of the event, and when this occurrence starts) */
    private static final Pattern BLOCK = Pattern.compile("^blocks/\\d{1,12}/\\d{1,12}$");
    /** Deleting one (no body: which ones in the address) */
    private static final Pattern BLOCK_DELETE = Pattern.compile("^blocks/\\d{1,12}/\\d{1,12}(\\?scope=(this|future|all))?$");

    public static boolean allowed(String method, String path) {
        if (method == null || path == null || path.length() > 100) {
            return false;
        }
        if ("GET".equals(method)) {
            return GET.matcher(path).matches();
        }
        if ("PUT".equals(method)) {
            return BLOCK.matcher(path).matches();
        }
        if ("DELETE".equals(method)) {
            return BLOCK_DELETE.matcher(path).matches();
        }
        return "POST".equals(method) && ("sync".equals(path) || "blocks".equals(path));
    }
}
