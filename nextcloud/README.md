# Blockwise for Nextcloud

Plan your commitments (Thesis, Work, …) in the Nextcloud calendar, work through
tasks block by block, and see where your time goes. Items are called commitments (Italian: impegni).

Started from [TimeManager](https://github.com/te-online/timemanager) by Thomas
Ebert (AGPL-3.0); clients and projects are replaced by commitments linked to
calendars.

## How it works

- **Commitment = calendar.** Creating a commitment creates a calendar; you can
  also turn an existing calendar into one. Name and color sync both ways.
- **Block = event** in that calendar (timed events; all-day events are ignored).
  Recurring events work.
- **Tasks** form an ordered queue per commitment. Only **subtasks** are checked
  off, in priority order; a task is done when all its subtasks are. A task
  created without subtasks gets one with its own title.
- **Estimates** are per subtask; a task's estimate is their sum. Type them with
  the title, e.g. `Draft 45m`, `Proofread 1h`, `Results 1h30`.
- **Weekly goals** per commitment (hours/week) with progress on the Now page and
  a goal line on the Time page. A block takes tasks from the top until their
  estimates fill it. Unfinished tasks stay on top, so they show up in the next
  block and get a "carried over" badge.
- **Now page**: a small month calendar colored by blocks (overlaps marked), the
  current block's subtasks, and "+ Add subtask" right there. While tracking, the other
  commitments shrink to one line each (focus view).
- **Done page**: a week timeline of planned blocks, tracked time and checked-off
  subtasks; hovering a block shows what you did in it.
- Reorder subtasks by dragging their handle (or Alt+↑/↓ on the checkbox).
- **Play** starts tracking for a commitment (inside or outside a block) or
  unplanned time. Tracked time feeds the **Time** page; checked subtasks feed
  the **Done** page.
- **Reminder** before the running block ends (default 15 min).
- **Pomodoro mode**: focus / short break / long break / sessions before a long
  break. Short breaks count as tracked time; tracking stops at the long break.
- **Overlap warning** when blocks of two different commitments overlap. Other
  calendars can overlap freely.

## Requirements

- Nextcloud 32–35
- The **Notifications** app (shipped with Nextcloud) for reminders on the phone
  and with the page closed
- **System cron every 5 minutes** (Settings → Basic settings → Background jobs →
  Cron). With AJAX cron, reminders only arrive while someone uses Nextcloud.

## Updating

Copy the new folder over the old one and run `occ upgrade` (see below for AIO).
Your data is kept.

## Install

```bash
# on the Nextcloud server, in its apps (or custom_apps) folder
tar xzf tracker-0.1.0.tar.gz
sudo chown -R www-data:www-data tracker
sudo -u www-data php occ app:enable tracker
```

With Nextcloud All-in-One:

```bash
docker cp tracker nextcloud-aio-nextcloud:/var/www/html/custom_apps/
docker exec nextcloud-aio-nextcloud chown -R www-data:www-data /var/www/html/custom_apps/tracker
docker exec --user www-data nextcloud-aio-nextcloud php occ app:enable tracker   # first install
docker exec --user www-data nextcloud-aio-nextcloud php occ upgrade              # updates
```

## Reminder timing

While the page is open, reminders and Pomodoro switches happen to the second,
with a sound and a browser notification. With the page closed, the background
job sends Nextcloud notifications (also pushed to the Nextcloud Android app);
those arrive with the next cron run, so up to 5 minutes late.
Short-break and back-to-focus alerts are only shown while the page is open.

## Limits

- The Calendar app itself can't refuse an overlapping event; the app warns
  (notification + banner on the Now page) instead.
- Only calendars you own can be commitments (not calendars shared with you).
- Deleting a commitment keeps its calendar and events; its tracked time stays
  in the statistics as unplanned time.
