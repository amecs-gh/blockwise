package app.tracker.core;

import java.util.HashMap;
import java.util.Map;

/** Placeholder values for I18n: Vars.of("name", "Thesis"). (Map.of needs Android 11.) */
public final class Vars {
    private Vars() {
    }

    public static Map<String, String> of(String... keysAndValues) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i + 1 < keysAndValues.length; i += 2) {
            m.put(keysAndValues[i], keysAndValues[i + 1]);
        }
        return m;
    }
}
