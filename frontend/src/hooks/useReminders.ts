import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "./useWorkspace";
import { buildReminders, DEFAULT_REMINDER_MINUTES, dueReminders, nextFireAt, pruneShown, startsIn, type Reminder } from "../utils/reminders";
import { accountTimeZone } from "../utils/timeZones";

const STORAGE_KEY = "autoplan.reminders.shown";
/** Check at least this often, in case the clock or the schedule changed while the timer slept. */
const MAX_WAIT_MS = 60_000;
const MAX_TOASTS = 3;

export type NotificationState = "unsupported" | NotificationPermission;

export function notificationState(): NotificationState {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

/** Asks the browser for permission. Call it from a click, or browsers ignore it. */
export async function requestNotifications(): Promise<NotificationState> {
  if (notificationState() !== "default") return notificationState();
  try { return await Notification.requestPermission(); } catch { return notificationState(); }
}

function loadShown(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") ?? {}; } catch { return {}; }
}
function saveShown(shown: Record<string, number>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(shown)); } catch { /* private mode: reminders may repeat after a reload */ }
}

function systemNotification(reminder: Reminder, now: number) {
  if (notificationState() !== "granted") return;
  try {
    const note = new Notification(reminder.title, { body: `${reminder.body} (${startsIn(reminder.startsAt, now)})`, tag: reminder.key });
    note.onclick = () => { window.focus(); note.close(); };
  } catch { /* some mobile browsers only allow notifications from a service worker; the in-app toast still shows */ }
}

/**
 * Shows each reminder once: as an in-app toast, and as a system notification when the browser allows it.
 * Does nothing while Reminders is off in Settings. Shown reminders are remembered in this browser across reloads.
 */
export function useReminders() {
  const { status, tasks, sessions, events, availability } = useWorkspace();
  const [toasts, setToasts] = useState<(Reminder & { shownAt: number })[]>([]);
  const enabled = status === "ready" && !!availability?.reminders;
  const lead = availability?.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;
  const zone = accountTimeZone(availability);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const now = Date.now();
      const shown = pruneShown(loadShown(), now);
      const keys = new Set(Object.keys(shown));
      const reminders = buildReminders({ tasks, sessions, events, zone, leadMinutes: lead, now });
      const due = dueReminders(reminders, now, keys);
      if (due.length) {
        for (const reminder of due) {
          shown[reminder.key] = reminder.startsAt;
          keys.add(reminder.key);
          systemNotification(reminder, now);
        }
        setToasts(current => [...due.map(r => ({ ...r, shownAt: now })), ...current].slice(0, MAX_TOASTS));
      }
      saveShown(shown);
      const next = nextFireAt(reminders, now, keys);
      timer = setTimeout(check, next === null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(1000, next - now)));
    };
    check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [enabled, tasks, sessions, events, zone, lead]);

  const dismiss = useCallback((key: string) => setToasts(current => current.filter(t => t.key !== key)), []);
  // Turning reminders off hides any cards still showing.
  return { toasts: enabled ? toasts : [], dismiss };
}
