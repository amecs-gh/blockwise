package app.tracker.core;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Which notifications to show, when to stop tracking for a Pomodoro long break,
 * and when to check next. A port of the Mac app's alerts.js (same rules).
 */
public final class Alerts {
    private Alerts() {
    }

    public enum Kind { FOCUS, SHORT, LONG }

    public static final class Phase {
        public final Kind kind;
        public final int round;
        public final int of;
        public final long endsAt;
        public final long longAt;

        Phase(Kind kind, int round, int of, long endsAt, long longAt) {
            this.kind = kind;
            this.round = round;
            this.of = of;
            this.endsAt = endsAt;
            this.longAt = longAt;
        }
    }

    /** Same phases as the web page: n focus periods with short breaks, then the long break. */
    public static Phase pomodoroPhase(long start, Dash.Settings s, long now) {
        long f = s.focusMinutes * 60L;
        long sb = s.shortBreakMinutes * 60L;
        int n = Math.max(1, s.sessionsBeforeLongBreak);
        long longAt = start + n * f + (n - 1) * sb;
        if (now >= longAt) {
            return new Phase(Kind.LONG, n, n, longAt, longAt);
        }
        long e = Math.max(0, now - start);
        int i = (int) (e / (f + sb));
        long inRound = e - i * (f + sb);
        if (inRound < f) {
            return new Phase(Kind.FOCUS, i + 1, n, start + i * (f + sb) + f, longAt);
        }
        return new Phase(Kind.SHORT, i + 1, n, start + (i + 1) * (f + sb), longAt);
    }

    /** The block of the running commitment that contains `now`, if any. */
    public static Dash.Block runningBlock(Dash d, long now) {
        if (d == null || d.running == null || d.running.commitmentId == null) {
            return null;
        }
        Dash.Entry e = d.entry(d.running.commitmentId);
        Dash.Block b = e == null ? null : e.currentBlock;
        return b != null && b.start <= now && now < b.end ? b : null;
    }

    public static final class Notice {
        public final String key;
        public final String title;
        public final String body;

        Notice(String key, String title, String body) {
            this.key = key;
            this.title = title;
            this.body = body;
        }
    }

    public static final class Result {
        public final List<Notice> notifications = new ArrayList<>();
        /** Stop tracking at this time (Pomodoro long break), or null */
        public Long stopAt;
        public boolean clearLongBreak;
    }

    public static String nameOf(Dash d, I18n t) {
        if (d.running == null) {
            return "";
        }
        if (d.running.commitmentId == null) {
            return t.t("Unplanned");
        }
        Dash.Entry e = d.entry(d.running.commitmentId);
        return e == null ? "" : e.name;
    }

    /**
     * @param seen keys of notifications already shown (changed by this call)
     */
    public static Result check(Dash d, long now, Set<String> seen, I18n t) {
        Result out = new Result();
        if (d == null) {
            return out;
        }
        Dash.Settings s = d.settings;
        Dash.Running r = d.running;
        if (r != null) {
            String name = nameOf(d, t);
            Dash.Block block = runningBlock(d, now);
            long reminder = s.reminderMinutes * 60L;
            if (block != null && reminder > 0 && block.end - now <= reminder) {
                once(out, seen, "end-" + block.uid,
                        t.t("{name}: block ends soon", Vars.of("name", name)),
                        t.t("{minutes} min left. Unchecked subtasks move to the next block.", Vars.of("minutes", String.valueOf(ceilDiv(block.end - now, 60)))));
            }
            if (r.pomodoro) {
                Phase p = pomodoroPhase(r.start, s, now);
                // The session's uuid: the same whether the app shows the phone's data or the server's
                String key = "pomo-" + (r.uuid != null ? r.uuid : String.valueOf(r.id)) + "-" + p.kind.name().toLowerCase(java.util.Locale.ROOT) + "-" + p.round;
                if (p.kind == Kind.SHORT) {
                    once(out, seen, key, t.t("Short break"),
                            t.t("Step away for {minutes} min. The timer keeps running.", Vars.of("minutes", String.valueOf(s.shortBreakMinutes))));
                } else if (p.kind == Kind.FOCUS && p.round > 1) {
                    once(out, seen, key, t.t("Back to focus"),
                            t.t("Round {round} of {of}", Vars.of("round", String.valueOf(p.round), "of", String.valueOf(p.of))));
                } else if (p.kind == Kind.LONG && !seen.contains(key)) {
                    once(out, seen, key, t.t("Time for a long break"),
                            t.t("Tracking stopped. Back to work in {minutes} min.", Vars.of("minutes", String.valueOf(s.longBreakMinutes))));
                    out.stopAt = p.longAt;
                }
            }
        } else if (d.longBreakUntil != null && now >= d.longBreakUntil) {
            once(out, seen, "lb-" + d.longBreakUntil, t.t("Break is over"), t.t("Press play to start the next focus session."));
            out.clearLongBreak = true;
        }
        return out;
    }

    /**
     * When something can next happen (a reminder, a Pomodoro phase, the end of a
     * long break, a block starting or ending), so the app only wakes up then.
     * Null when nothing is running and nothing is planned.
     */
    public static Long nextCheckAt(Dash d, long now) {
        if (d == null) {
            return null;
        }
        long best = Long.MAX_VALUE;
        Dash.Running r = d.running;
        if (r != null) {
            long reminder = d.settings.reminderMinutes * 60L;
            Dash.Block block = runningBlock(d, now);
            if (block != null) {
                if (reminder > 0 && block.end - reminder > now) {
                    best = Math.min(best, block.end - reminder);
                }
                best = Math.min(best, block.end);
            }
            Dash.Entry e = d.entry(r.commitmentId);
            if (e != null && e.nextBlock != null && e.nextBlock.start > now) {
                best = Math.min(best, e.nextBlock.start);
            }
            if (r.pomodoro) {
                Phase p = pomodoroPhase(r.start, d.settings, now);
                if (p.kind != Kind.LONG) {
                    best = Math.min(best, p.endsAt);
                } else {
                    best = Math.min(best, now + 60); // stop right away
                }
            }
            // Pick up changes made elsewhere (browser, Mac) now and then
            best = Math.min(best, now + 15 * 60);
        } else if (d.longBreakUntil != null) {
            best = Math.min(best, Math.max(now + 5, d.longBreakUntil));
        }
        return best == Long.MAX_VALUE ? null : best;
    }

    /** Text for the ongoing notification while tracking. */
    public static final class Status {
        public final String title;
        public final String text;
        /** chronometer base (unix seconds) */
        public final long when;
        /** counting down to `when` (Pomodoro phase end) rather than up from it */
        public final boolean countDown;

        Status(String title, String text, long when, boolean countDown) {
            this.title = title;
            this.text = text;
            this.when = when;
            this.countDown = countDown;
        }
    }

    public static Status status(Dash d, long now, I18n t) {
        if (d == null) {
            return null;
        }
        Dash.Running r = d.running;
        if (r != null) {
            String name = nameOf(d, t);
            if (r.pomodoro) {
                Phase p = pomodoroPhase(r.start, d.settings, now);
                String phase = p.kind == Kind.FOCUS ? t.t("Focus") : p.kind == Kind.SHORT ? t.t("Short break") : t.t("Long break");
                return new Status(name, phase + " · " + t.t("Round {round} of {of}", Vars.of("round", String.valueOf(p.round), "of", String.valueOf(p.of))), p.endsAt, true);
            }
            Dash.Block block = runningBlock(d, now);
            String text = block != null
                    ? t.t("{time} left in this block", Vars.of("time", minutesText(block.end - now)))
                    : t.t("Tracking");
            return new Status(name, text, r.start, false);
        }
        if (d.longBreakUntil != null && d.longBreakUntil > now) {
            return new Status(t.t("Long break"), t.t("Back to work in {time}", Vars.of("time", minutesText(d.longBreakUntil - now))), d.longBreakUntil, true);
        }
        return null;
    }

    /** "1h 05m", "25m", "< 1m" */
    public static String minutesText(long seconds) {
        long sec = Math.max(0, seconds);
        long h = sec / 3600;
        long m = (sec % 3600) / 60;
        if (h == 0 && m == 0) {
            return "< 1m";
        }
        return h > 0 ? (m > 0 ? h + "h " + String.format("%02d", m) + "m" : h + "h") : m + "m";
    }

    private static void once(Result out, Set<String> seen, String key, String title, String body) {
        if (seen.contains(key)) {
            return;
        }
        seen.add(key);
        out.notifications.add(new Notice(key, title, body));
    }

    private static long ceilDiv(long a, long b) {
        return (a + b - 1) / b;
    }
}
