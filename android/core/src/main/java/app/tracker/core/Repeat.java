package app.tracker.core;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * The planner's repeats (daily, weekdays, weekly, biweekly, monthly) as the
 * RRULE of an event in the phone's calendars, and back. Anything else a
 * calendar app made stays as it is and is called "custom".
 */
public final class Repeat {
    private Repeat() {
    }

    private static SimpleDateFormat utc() {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd'T'HHmmss'Z'", Locale.ROOT);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f;
    }

    /** @param until last possible start (unix seconds) or null; @return null for no repeat */
    public static String toRrule(String repeat, Long until) {
        String r;
        switch (repeat == null ? "" : repeat) {
            case "daily":
                r = "FREQ=DAILY";
                break;
            case "weekdays":
                r = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
                break;
            case "weekly":
                r = "FREQ=WEEKLY";
                break;
            case "biweekly":
                r = "FREQ=WEEKLY;INTERVAL=2";
                break;
            case "monthly":
                r = "FREQ=MONTHLY";
                break;
            default:
                return null;
        }
        return until == null ? r : r + ";UNTIL=" + utc().format(new Date(until * 1000));
    }

    private static String part(String rrule, String key) {
        for (String p : rrule.toUpperCase(Locale.ROOT).split(";")) {
            int eq = p.indexOf('=');
            if (eq > 0 && p.substring(0, eq).trim().equals(key)) {
                return p.substring(eq + 1).trim();
            }
        }
        return null;
    }

    /** "" (none), one of the planner's names, or "custom" */
    public static String fromRrule(String rrule) {
        if (rrule == null || rrule.trim().isEmpty()) {
            return "";
        }
        String freq = part(rrule, "FREQ");
        String interval = part(rrule, "INTERVAL");
        String byday = part(rrule, "BYDAY");
        boolean once = interval == null || interval.equals("1");
        if (part(rrule, "COUNT") != null) {
            return "custom";
        }
        if ("DAILY".equals(freq) && once && byday == null) {
            return "daily";
        }
        if ("WEEKLY".equals(freq) && once && "MO,TU,WE,TH,FR".equals(byday)) {
            return "weekdays";
        }
        if ("WEEKLY".equals(freq) && byday == null) {
            return once ? "weekly" : "2".equals(interval) ? "biweekly" : "custom";
        }
        if ("MONTHLY".equals(freq) && once && byday == null && part(rrule, "BYMONTHDAY") == null) {
            return "monthly";
        }
        return "custom";
    }

    /** UNTIL as unix seconds, or null */
    public static Long until(String rrule) {
        String u = rrule == null ? null : part(rrule, "UNTIL");
        if (u == null) {
            return null;
        }
        try {
            if (u.length() == 8) {
                SimpleDateFormat d = new SimpleDateFormat("yyyyMMdd", Locale.ROOT);
                d.setTimeZone(TimeZone.getTimeZone("UTC"));
                return d.parse(u).getTime() / 1000 + 86399;
            }
            return utc().parse(u.endsWith("Z") ? u : u + "Z").getTime() / 1000;
        } catch (ParseException e) {
            return null;
        }
    }

    /** The same rule ending at `until` (COUNT and an earlier UNTIL replaced) */
    public static String withUntil(String rrule, long until) {
        StringBuilder out = new StringBuilder();
        for (String p : rrule.split(";")) {
            String k = p.contains("=") ? p.substring(0, p.indexOf('=')).trim().toUpperCase(Locale.ROOT) : "";
            if (k.equals("UNTIL") || k.equals("COUNT") || p.trim().isEmpty()) {
                continue;
            }
            out.append(out.length() == 0 ? "" : ";").append(p.trim());
        }
        return out + ";UNTIL=" + utc().format(new Date(until * 1000));
    }

    /** The same rule without an end */
    public static String endless(String rrule) {
        StringBuilder out = new StringBuilder();
        for (String p : rrule.split(";")) {
            String k = p.contains("=") ? p.substring(0, p.indexOf('=')).trim().toUpperCase(Locale.ROOT) : "";
            if (k.equals("UNTIL") || k.equals("COUNT") || p.trim().isEmpty()) {
                continue;
            }
            out.append(out.length() == 0 ? "" : ";").append(p.trim());
        }
        return out.toString();
    }
}
