package app.tracker.core;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * What the app's page may ask for with the app password: Tracker's own API
 * only (e.g. "tasks/12" or "blocks?from=1&to=2"). No "..", no other Nextcloud
 * endpoints: the app password could otherwise reach your files.
 */
public final class ApiGuard {
    private ApiGuard() {
    }

    public static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "POST", "PUT", "DELETE"));

    private static final Pattern PATH = Pattern.compile(
            "^[a-z][a-z-]*(/\\d+(/[a-z][a-z-]*)?|/(start|stop))?(\\?[a-zA-Z]+=[a-zA-Z0-9_-]*(&[a-zA-Z]+=[a-zA-Z0-9_-]*)*)?$");

    public static boolean allowed(String method, String path) {
        return method != null && path != null && METHODS.contains(method) && path.length() <= 200 && PATH.matcher(path).matches();
    }
}
