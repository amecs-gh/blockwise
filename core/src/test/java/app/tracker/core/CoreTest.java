package app.tracker.core;

import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Plain tests (no test library to download). Run: ./gradlew :core:coreTest */
public final class CoreTest {
    private static int passed = 0;

    private static void check(boolean ok, String what) {
        if (!ok) {
            throw new AssertionError("FAILED: " + what);
        }
        passed++;
    }

    private static void eq(Object actual, Object expected, String what) {
        check(expected == null ? actual == null : expected.equals(actual), what + " (expected " + expected + ", got " + actual + ")");
    }

    private static String normalized(String input) {
        try {
            return ServerUrl.normalize(input);
        } catch (ServerUrl.InvalidServer e) {
            return "ERR " + e.getMessage();
        }
    }

    static final long T0 = 1_800_000_000L;

    static Dash dash(boolean pomodoro, Long commitmentId, boolean withBlock) {
        Dash d = new Dash();
        Dash.Entry e = new Dash.Entry();
        e.commitmentId = 1;
        e.name = "Thesis";
        if (withBlock) {
            Dash.Block b = new Dash.Block();
            b.uid = "b1";
            b.start = T0 - 3600;
            b.end = T0 + 3600;
            e.currentBlock = b;
        }
        d.commitments.add(e);
        Dash.Running r = new Dash.Running();
        r.id = pomodoro ? 9 : 7;
        r.commitmentId = commitmentId;
        r.start = T0;
        r.pomodoro = pomodoro;
        d.running = r;
        return d;
    }

    public static void main(String[] args) {
        I18n en = I18n.forLocale(Locale.ENGLISH);

        // --- server address rules (same as the Mac app) ---
        eq(normalized("cloud.example.com/"), "https://cloud.example.com", "adds https");
        eq(normalized("Cloud.Example.com/index.php/apps/files"), "https://cloud.example.com", "drops page path");
        eq(normalized("https://u:p@cloud.example.com/nc/"), "https://cloud.example.com/nc", "drops credentials, keeps subpath");
        eq(normalized("cloud.example.com:8443"), "https://cloud.example.com:8443", "keeps port");
        eq(normalized("localhost:8080"), "http://localhost:8080", "http for localhost");
        eq(normalized("10.0.2.2:8080"), "http://10.0.2.2:8080", "http for the emulator host");
        eq(normalized("http://nas.tail1234.ts.net"), "http://nas.tail1234.ts.net", "http over Tailscale name");
        check(normalized("http://cloud.example.com").startsWith("ERR Use an https:// address:"), "plain http refused");
        check(normalized("http://100.101.2.3").startsWith("ERR"), "http to a raw IP refused (Android can't allow it per range)");
        check(normalized("file:///etc/passwd").startsWith("ERR"), "file: refused");
        check(normalized("javascript:alert(1)").startsWith("ERR"), "javascript: refused");
        check(normalized("").startsWith("ERR Enter"), "empty refused");

        // --- login flow URLs pinned to the server you entered ---
        try {
            eq(ServerUrl.onServer("https://cloud.example.com/nc", "http://internal:80/nc/login/v2/flow/abc"), "https://cloud.example.com/nc/login/v2/flow/abc", "rebased login URL");
            eq(ServerUrl.onServer("https://cloud.example.com", "https://evil.com/login/v2/poll"), "https://cloud.example.com/login/v2/poll", "poll URL can't leave the server");
        } catch (ServerUrl.InvalidServer e) {
            throw new AssertionError(e);
        }
        check(ServerUrl.sameOrigin("https://cloud.example.com/nc", "https://cloud.example.com/login"), "same origin");
        check(!ServerUrl.sameOrigin("https://cloud.example.com", "https://cloud.example.com.evil.com/"), "look-alike host is not the server");
        check(!ServerUrl.sameOrigin("https://cloud.example.com", "http://cloud.example.com/"), "http is not https");

        // --- only Tracker's API ---
        for (String p : new String[] {"state", "tasks-order", "tasks/12/subtasks-order", "sessions/start", "sessions/1", "blocks?from=1&to=2", "tasks?commitmentId=1&status=open"}) {
            check(ApiGuard.allowed("GET", p), "allowed " + p);
        }
        for (String p : new String[] {"../../remote.php/dav", "tasks/1/../../x", "tasks//1", "ocs/v2.php", "x?y=a%2F", "/state", ""}) {
            check(!ApiGuard.allowed("GET", p), "refused " + p);
        }
        check(!ApiGuard.allowed("PROPFIND", "tasks"), "odd method refused");
        check(!ApiGuard.allowed(null, "tasks"), "no method refused");

        // --- Pomodoro phases: 25 focus, 5 break, ... 4 rounds, long break at 115 min ---
        Dash.Settings s = new Dash.Settings();
        eq(Alerts.pomodoroPhase(T0, s, T0 + 60).kind, Alerts.Kind.FOCUS, "focus at start");
        eq(Alerts.pomodoroPhase(T0, s, T0 + 26 * 60).kind, Alerts.Kind.SHORT, "short break");
        eq(Alerts.pomodoroPhase(T0, s, T0 + 31 * 60).round, 2, "round 2");
        eq(Alerts.pomodoroPhase(T0, s, T0 + 115 * 60).kind, Alerts.Kind.LONG, "long break");
        eq(Alerts.pomodoroPhase(T0, s, T0).longAt, T0 + 115 * 60, "long break time");

        // --- block-end reminder: once at 15 min left ---
        Set<String> seen = new HashSet<>();
        eq(Alerts.check(dash(false, 1L, true), T0 + 3600 - 20 * 60, seen, en).notifications.size(), 0, "no reminder at 20 min");
        Alerts.Result a = Alerts.check(dash(false, 1L, true), T0 + 3600 - 15 * 60, seen, en);
        eq(a.notifications.size(), 1, "reminder at 15 min");
        eq(a.notifications.get(0).title, "Thesis: block ends soon", "reminder title");
        eq(a.notifications.get(0).body, "15 min left. Unchecked subtasks move to the next block.", "reminder body");
        eq(Alerts.check(dash(false, 1L, true), T0 + 3600 - 10 * 60, seen, en).notifications.size(), 0, "not twice");
        Dash noReminder = dash(false, 1L, true);
        noReminder.settings.reminderMinutes = 0;
        eq(Alerts.check(noReminder, T0 + 3500, new HashSet<>(), en).notifications.size(), 0, "setting 0 = no reminder");
        eq(Alerts.check(dash(false, null, true), T0 + 3500, new HashSet<>(), en).notifications.size(), 0, "no reminder for unplanned time");

        // --- Pomodoro notifications and the long-break stop ---
        Dash pd = dash(true, 1L, false);
        seen = new HashSet<>();
        eq(Alerts.check(pd, T0 + 26 * 60, seen, en).notifications.get(0).title, "Short break", "short break notice");
        eq(Alerts.check(pd, T0 + 27 * 60, seen, en).notifications.size(), 0, "short break once");
        eq(Alerts.check(pd, T0 + 31 * 60, seen, en).notifications.get(0).title, "Back to focus", "back to focus");
        a = Alerts.check(pd, T0 + 116 * 60, seen, en);
        eq(a.stopAt, T0 + 115 * 60, "stop at the long break");
        eq(a.notifications.get(0).title, "Time for a long break", "long break notice");
        eq(Alerts.check(pd, T0 + 117 * 60, seen, en).stopAt, null, "stop only once");

        // --- long break over ---
        Dash lb = dash(false, 1L, false);
        lb.running = null;
        lb.longBreakUntil = T0;
        a = Alerts.check(lb, T0 + 5, new HashSet<>(), en);
        eq(a.notifications.get(0).title, "Break is over", "break over");
        check(a.clearLongBreak, "clears the long break");

        // --- when to wake up next ---
        eq(Alerts.nextCheckAt(dash(false, 1L, true), T0), T0 + 15 * 60, "check again within 15 min (changes made elsewhere)");
        eq(Alerts.nextCheckAt(dash(false, 1L, true), T0 + 2000), T0 + 3600 - 15 * 60, "wake exactly for the reminder");
        eq(Alerts.nextCheckAt(dash(false, 1L, true), T0 + 3600 - 10 * 60), T0 + 3600, "then for the block end");
        eq(Alerts.nextCheckAt(pd, T0 + 15 * 60), T0 + 25 * 60, "wake at the end of the focus phase");
        eq(Alerts.nextCheckAt(dash(false, null, false), T0), T0 + 15 * 60, "unplanned: check every 15 min");
        Dash idle = dash(false, 1L, false);
        idle.running = null;
        eq(Alerts.nextCheckAt(idle, T0), null, "nothing running: no wake-ups");
        lb.longBreakUntil = T0 + 600;
        eq(Alerts.nextCheckAt(lb, T0), T0 + 600, "wake when the long break ends");

        // --- ongoing notification text ---
        Alerts.Status st = Alerts.status(dash(false, 1L, true), T0 + 600, en);
        eq(st.title, "Thesis", "status title");
        eq(st.text, "50m left in this block", "status text");
        eq(st.when, T0, "counts up from the start");
        check(!st.countDown, "counts up");
        st = Alerts.status(pd, T0 + 60, en);
        eq(st.text, "Focus · Round 1 of 4", "pomodoro status");
        eq(st.when, T0 + 25 * 60, "counts down to the phase end");
        check(st.countDown, "counts down");
        eq(Alerts.status(idle, T0, en), null, "no status when idle");
        eq(Alerts.minutesText(3900), "1h 05m", "duration text");

        // --- Italian ---
        I18n it = I18n.forLocale(Locale.ITALIAN);
        eq(it.t("{name}: block ends soon", Vars.of("name", "Tesi")), "Tesi: il blocco sta per finire", "Italian text");
        eq(it.t("Unknown text"), "Unknown text", "falls back to English");
        eq(en.t("Value $1 {x}", Vars.of("x", "a$b\\c")), "Value $1 a$b\\c", "no regex surprises in values");

        System.out.println("core: all " + passed + " checks passed");
    }
}
