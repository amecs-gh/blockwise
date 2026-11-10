package app.tracker.core;

import java.util.ArrayList;
import java.util.List;

/** What the reminders need: timer, settings, each commitment's current and next block (filled by the app). */
public final class Dash {
    public static final class Settings {
        public int focusMinutes = 25;
        public int shortBreakMinutes = 5;
        public int longBreakMinutes = 15;
        public int sessionsBeforeLongBreak = 4;
        public int reminderMinutes = 15;
    }

    public static final class Running {
        public long id;
        /** the session's uuid (to stop it from the notification) */
        public String uuid;
        /** null = unplanned time */
        public Long commitmentId;
        public long start;
        public boolean pomodoro;
    }

    public static final class Block {
        public String uid;
        public String title = "";
        public long start;
        public long end;
    }

    public static final class Entry {
        public long commitmentId;
        public String name = "";
        public String color = "#0082c9";
        public Block currentBlock;
        public Block nextBlock;
    }

    public Settings settings = new Settings();
    public Running running;
    /** unix seconds, or null */
    public Long longBreakUntil;
    public final List<Entry> commitments = new ArrayList<>();

    public Entry entry(Long commitmentId) {
        if (commitmentId == null) {
            return null;
        }
        for (Entry e : commitments) {
            if (e.commitmentId == commitmentId) {
                return e;
            }
        }
        return null;
    }
}
