import { useMemo, useState, type FormEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { ABOUT_ME_MAX, type AIProfile, type AssistantTone, type Availability, type AvailableDay, type ReplyStyle, type SchedulePreferences } from "../types/models";
import {
  cloneDays,
  emptyWeekDays,
  mondayOf,
  normalizeAvailability,
  timeOptions,
  upsertWeekOverride,
  weekLabel,
} from "../utils/availability";
import { WEEKDAYS, dateInZone, parseClock } from "../utils/calendar";
import { normalizeTimeZone, timeZoneChoices } from "../utils/timeZones";
import "./Planning.css";

type DraftDay = {
  day: number;
  enabled: boolean;
  periods: { start: string; end: string }[];
};

const START_OPTIONS = timeOptions(false);
const END_OPTIONS = timeOptions(true);

function clock(minutes: number) {
  if (minutes >= 1440) return "24:00";
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function toDraftDays(days: AvailableDay[]): DraftDay[] {
  return days.map((row) => ({
    day: row.day,
    enabled: row.enabled,
    periods: (row.periods.length ? row.periods : [{ start: 540, end: 1020 }]).map(
      (period) => ({
        start: clock(period.start),
        end: clock(period.end),
      }),
    ),
  }));
}

function fromDraftDays(days: DraftDay[]): AvailableDay[] {
  return days.map((row) => ({
    day: row.day,
    enabled: row.enabled,
    periods: row.periods.map((period) => ({
      start: parseClock(period.start),
      end: parseClock(period.end),
    })),
  }));
}

function validateDays(days: AvailableDay[]): string | null {
  for (const day of days) {
    if (!day.enabled) continue;
    if (!day.periods.length) return "Enabled days need at least one period.";
    for (const period of day.periods) {
      if (
        !Number.isFinite(period.start) ||
        !Number.isFinite(period.end) ||
        period.end <= period.start
      ) {
        return "Use 24-hour times (00:00–23:59). Each end must be later than its start.";
      }
    }
    const ordered = [...day.periods].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].start < ordered[index - 1].end) {
        return "Periods on the same day cannot overlap.";
      }
    }
  }
  return null;
}

function AvailabilityForm({ initial }: { initial: Availability }) {
  const seed = useMemo(() => normalizeAvailability(initial), [initial]);
  const today = dateInZone(seed.timeZone);
  const [activeWeek, setActiveWeek] = useState<"default" | string>("default");
  const [defaultDays, setDefaultDays] = useState(() => cloneDays(seed.days));
  const [overrides, setOverrides] = useState(() =>
    seed.weekOverrides.map((week) => ({
      weekStart: week.weekStart,
      days: cloneDays(week.days),
    })),
  );
  const [draftDays, setDraftDays] = useState<DraftDay[]>(() =>
    toDraftDays(seed.days),
  );
  const [timeZone, setTimeZone] = useState(normalizeTimeZone(seed.timeZone));
  const [reminders, setReminders] = useState(seed.reminders);
  const [addWeekDate, setAddWeekDate] = useState(today);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const { saving } = useWorkspace();

  function persistDraft():
    | { defaultDays: AvailableDay[]; overrides: typeof overrides }
    | null {
    const days = fromDraftDays(draftDays);
    const issue = validateDays(days);
    if (issue) {
      setError(issue);
      return null;
    }
    const nextDefault = activeWeek === "default" ? days : defaultDays;
    const nextOverrides =
      activeWeek === "default"
        ? overrides
        : upsertWeekOverride(overrides, activeWeek, days);
    setDefaultDays(nextDefault);
    setOverrides(nextOverrides);
    return { defaultDays: nextDefault, overrides: nextOverrides };
  }

  function loadWeek(next: "default" | string) {
    const persisted = persistDraft();
    if (!persisted) return;
    if (next === "default") {
      setDraftDays(toDraftDays(persisted.defaultDays));
    } else {
      const source = persisted.overrides.find((week) => week.weekStart === next)?.days;
      setDraftDays(toDraftDays(source ?? emptyWeekDays()));
    }
    setActiveWeek(next);
    setMessage("");
    setError("");
  }

  function changeDay(day: number, patch: Partial<DraftDay>) {
    setDraftDays((current) =>
      current.map((row) => (row.day === day ? { ...row, ...patch } : row)),
    );
    setMessage("");
  }

  function changePeriod(
    day: number,
    index: number,
    patch: Partial<{ start: string; end: string }>,
  ) {
    setDraftDays((current) =>
      current.map((row) => {
        if (row.day !== day) return row;
        return {
          ...row,
          periods: row.periods.map((period, periodIndex) =>
            periodIndex === index ? { ...period, ...patch } : period,
          ),
        };
      }),
    );
    setMessage("");
  }

  function addPeriod(day: number) {
    setDraftDays((current) =>
      current.map((row) =>
        row.day === day
          ? {
              ...row,
              enabled: true,
              periods: [...row.periods, { start: "18:00", end: "21:00" }],
            }
          : row,
      ),
    );
    setMessage("");
  }

  function removePeriod(day: number, index: number) {
    setDraftDays((current) =>
      current.map((row) => {
        if (row.day !== day) return row;
        const periods = row.periods.filter((_, periodIndex) => periodIndex !== index);
        return {
          ...row,
          periods: periods.length ? periods : [{ start: "09:00", end: "17:00" }],
          enabled: periods.length ? row.enabled : false,
        };
      }),
    );
    setMessage("");
  }

  function addWeek() {
    const persisted = persistDraft();
    if (!persisted) return;
    const monday = mondayOf(addWeekDate);
    const nextOverrides = persisted.overrides.some(
      (week) => week.weekStart === monday,
    )
      ? persisted.overrides
      : upsertWeekOverride(
          persisted.overrides,
          monday,
          cloneDays(persisted.defaultDays),
        );
    setOverrides(nextOverrides);
    setDraftDays(
      toDraftDays(
        nextOverrides.find((week) => week.weekStart === monday)?.days ??
          persisted.defaultDays,
      ),
    );
    setActiveWeek(monday);
    setMessage(`Editing ${weekLabel(monday)}. Save to keep this week’s hours.`);
    setError("");
  }

  function removeActiveWeek() {
    if (activeWeek === "default") return;
    setOverrides((current) =>
      current.filter((week) => week.weekStart !== activeWeek),
    );
    setDraftDays(toDraftDays(defaultDays));
    setActiveWeek("default");
    setMessage("Removed this week override. Save to apply.");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    const days = fromDraftDays(draftDays);
    const issue = validateDays(days);
    if (issue) {
      setError(issue);
      return;
    }

    const nextDefault = activeWeek === "default" ? days : defaultDays;
    const nextOverrides =
      activeWeek === "default"
        ? overrides
        : upsertWeekOverride(overrides, activeWeek, days);

    const input = normalizeAvailability({
      days: nextDefault,
      weekOverrides: nextOverrides,
      timeZone: normalizeTimeZone(timeZone),
      reminders,
    });

    try {
      const saved = normalizeAvailability(
        await workspaceService.saveAvailability(input),
      );
      setDefaultDays(cloneDays(saved.days));
      setOverrides(
        saved.weekOverrides.map((week) => ({
          weekStart: week.weekStart,
          days: cloneDays(week.days),
        })),
      );
      if (activeWeek === "default") setDraftDays(toDraftDays(saved.days));
      else {
        const found = saved.weekOverrides.find(
          (week) => week.weekStart === activeWeek,
        );
        setDraftDays(toDraftDays(found?.days ?? emptyWeekDays()));
      }
      setTimeZone(normalizeTimeZone(saved.timeZone));
      setReminders(saved.reminders);
      setMessage("Availability saved to your account.");
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card availability-form" onSubmit={save}>
      <h2>Available hours</h2>

      <div className="availability-week-bar" role="group" aria-label="Week schedule">
        <button
          type="button"
          className={activeWeek === "default" ? "is-active" : ""}
          aria-pressed={activeWeek === "default"}
          onClick={() => loadWeek("default")}
        >
          Default week
        </button>
        {overrides.map((week) => (
          <button
            key={week.weekStart}
            type="button"
            className={activeWeek === week.weekStart ? "is-active" : ""}
            aria-pressed={activeWeek === week.weekStart}
            onClick={() => loadWeek(week.weekStart)}
          >
            {weekLabel(week.weekStart)}
          </button>
        ))}
      </div>

      <div className="availability-week-add">
        <label>
          Add week
          <input
            type="date"
            value={addWeekDate}
            onChange={(event) => setAddWeekDate(event.target.value || today)}
          />
        </label>
        <button type="button" className="button secondary" onClick={addWeek}>
          Edit week of {mondayOf(addWeekDate)}
        </button>
        {activeWeek !== "default" && (
          <button
            type="button"
            className="button secondary"
            onClick={removeActiveWeek}
          >
            Remove this week override
          </button>
        )}
      </div>

      <fieldset disabled={saving}>
        <legend className="sr-only">Weekly availability</legend>
        {draftDays.map((row) => (
          <div className="availability-day" key={row.day}>
            <label className="day-toggle">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(event) =>
                  changeDay(row.day, { enabled: event.target.checked })
                }
              />
              {WEEKDAYS[row.day]}
            </label>
            <div className="availability-periods">
              {row.periods.map((period, index) => (
                <div className="availability-period" key={`${row.day}-${index}`}>
                  <label>
                    From
                    <select
                      aria-label={`${WEEKDAYS[row.day]} period ${index + 1} start`}
                      disabled={!row.enabled}
                      value={period.start}
                      onChange={(event) =>
                        changePeriod(row.day, index, {
                          start: event.target.value,
                        })
                      }
                    >
                      {START_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Until
                    <select
                      aria-label={`${WEEKDAYS[row.day]} period ${index + 1} end`}
                      disabled={!row.enabled}
                      value={period.end}
                      onChange={(event) =>
                        changePeriod(row.day, index, { end: event.target.value })
                      }
                    >
                      {END_OPTIONS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={!row.enabled || row.periods.length === 1}
                    aria-label={`Remove period ${index + 1} on ${WEEKDAYS[row.day]}`}
                    onClick={() => removePeriod(row.day, index)}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="button secondary"
                onClick={() => addPeriod(row.day)}
              >
                + Add period
              </button>
            </div>
          </div>
        ))}

        <div className="settings-row">
          <label className="timezone-field">
            Time zone
            <select
              required
              aria-label="Time zone"
              value={normalizeTimeZone(timeZone)}
              onChange={(event) => {
                setTimeZone(normalizeTimeZone(event.target.value));
                setMessage("");
              }}
            >
              {timeZoneChoices().map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="settings-row">
          <label>
            <input
              type="checkbox"
              checked={reminders}
              onChange={(event) => {
                setReminders(event.target.checked);
                setMessage("");
              }}
            />{" "}
            Reminders
          </label>
        </div>
        <button className="button" type="submit">
          {saving ? "Saving…" : "Save availability"}
        </button>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="task-status" role="status">
        {message}
      </p>
    </form>
  );
}

/** Focus length, break length, daily cap and an optional protected lunch. The scheduler and validator both use these. */
function PreferencesForm({ initial }: { initial: SchedulePreferences }) {
  const { saving } = useWorkspace();
  const [focus, setFocus] = useState(String(initial.focusMinutes));
  const [rest, setRest] = useState(String(initial.breakMinutes));
  const [daily, setDaily] = useState(String(initial.maxDailyWorkMinutes / 60));
  const [lunchOn, setLunchOn] = useState(initial.lunch !== null);
  const [lunchStart, setLunchStart] = useState(clock(initial.lunch?.start ?? 720));
  const [lunchEnd, setLunchEnd] = useState(clock(initial.lunch?.end ?? 780));
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    const focusMinutes = Number(focus);
    const breakMinutes = Number(rest);
    const maxDailyWorkMinutes = Math.round(Number(daily) * 60);
    const lunch = lunchOn ? { start: parseClock(lunchStart), end: parseClock(lunchEnd) } : null;
    if (!Number.isInteger(focusMinutes) || focusMinutes < 10 || focusMinutes > 240) return setError("Focus length must be 10 to 240 minutes.");
    if (!Number.isInteger(breakMinutes) || breakMinutes < 5 || breakMinutes > 120) return setError("Break length must be 5 to 120 minutes.");
    if (!Number.isFinite(maxDailyWorkMinutes) || maxDailyWorkMinutes < 15 || maxDailyWorkMinutes > 1440) return setError("Daily task work must be between 0.25 and 24 hours.");
    if (lunch && !(lunch.end > lunch.start)) return setError("Lunch must end after it starts.");
    setError("");
    try {
      await workspaceService.savePreferences({ focusMinutes, breakMinutes, maxDailyWorkMinutes, lunch });
      setMessage("Saved. Generate or repair your schedule to apply the new pacing.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form className="card availability-form" onSubmit={save} aria-label="Focus and breaks">
      <fieldset disabled={saving}>
        <legend>Focus &amp; breaks</legend>
        <p className="muted small">Defaults: 50 minutes of focus, then a 10-minute break, up to 4 hours of task work a day. Adjust them to suit you.</p>
        <div className="availability-meta">
          <label>Focus length (min)
            <input type="number" min={10} max={240} value={focus} onChange={e => { setFocus(e.target.value); setMessage(""); }} />
          </label>
          <label>Break length (min)
            <input type="number" min={5} max={120} value={rest} onChange={e => { setRest(e.target.value); setMessage(""); }} />
          </label>
          <label>Task work per day (hours)
            <input type="number" min={0.25} max={24} step={0.25} value={daily} onChange={e => { setDaily(e.target.value); setMessage(""); }} />
          </label>
        </div>
        <div className="availability-meta">
          <label>
            <input type="checkbox" checked={lunchOn} onChange={e => { setLunchOn(e.target.checked); setMessage(""); }} /> Protect a lunch break
          </label>
          {lunchOn && <>
            <label>From
              <select value={lunchStart} onChange={e => setLunchStart(e.target.value)}>{START_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>
            </label>
            <label>To
              <select value={lunchEnd} onChange={e => setLunchEnd(e.target.value)}>{END_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}</select>
            </label>
          </>}
        </div>
        <button className="button" type="submit">{saving ? "Saving…" : "Save focus & breaks"}</button>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="task-status" role="status">{message}</p>
    </form>
  );
}

const REPLY_STYLES: { value: ReplyStyle; label: string; hint: string }[] = [
  { value: "concise", label: "Concise", hint: "1–3 short sentences" },
  { value: "balanced", label: "Balanced", hint: "Short, with a list when it helps" },
  { value: "detailed", label: "Detailed", hint: "Fuller explanations with reasons" },
];
const TONES: { value: AssistantTone; label: string }[] = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "motivating", label: "Motivating" },
];

/** How the AI assistant talks to you. Changes wording only; the scheduler never reads these. */
function AIProfileForm({ initial }: { initial: AIProfile }) {
  const { saving } = useWorkspace();
  const [replyStyle, setReplyStyle] = useState<ReplyStyle>(initial.replyStyle);
  const [tone, setTone] = useState<AssistantTone>(initial.tone);
  const [aboutMe, setAboutMe] = useState(initial.aboutMe);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (aboutMe.length > ABOUT_ME_MAX) return setError(`Keep “About me” under ${ABOUT_ME_MAX} characters.`);
    setError("");
    try {
      await workspaceService.saveAIProfile({ replyStyle, tone, aboutMe: aboutMe.trim() });
      setMessage("Saved. The assistant uses this from your next message.");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <form className="card availability-form" onSubmit={save} aria-label="AI personalization">
      <fieldset disabled={saving}>
        <legend>AI personalization</legend>
        <p className="muted small">How the assistant talks to you. You can also tell it in chat, e.g. “keep answers short” or “remember I have class on Tuesdays”; it asks before saving anything.</p>
        <div className="availability-meta">
          <label>Reply style
            <select value={replyStyle} onChange={e => { setReplyStyle(e.target.value as ReplyStyle); setMessage(""); }}>
              {REPLY_STYLES.map(o => <option key={o.value} value={o.value}>{o.label} — {o.hint}</option>)}
            </select>
          </label>
          <label>Tone
            <select value={tone} onChange={e => { setTone(e.target.value as AssistantTone); setMessage(""); }}>
              {TONES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        </div>
        <label className="ai-about">About me <span className="muted small">({aboutMe.length}/{ABOUT_ME_MAX})</span>
          <textarea rows={3} maxLength={ABOUT_ME_MAX} value={aboutMe} placeholder="e.g. Grad student. I focus best at night. Classes Tue/Thu afternoons."
            onChange={e => { setAboutMe(e.target.value); setMessage(""); }} />
        </label>
        <button className="button" type="submit">{saving ? "Saving…" : "Save AI personalization"}</button>
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="task-status" role="status">{message}</p>
    </form>
  );
}

export default function Settings() {
  const { availability, preferences, aiProfile } = useWorkspace();
  return (
    <>
      <ScreenHeading
        eyebrow="SETTINGS"
        title="Planning, on your terms."
        description="Set the hours you’re available. They show on your calendar, and the scheduler plans inside them."
      />
      {availability && (
        <AvailabilityForm
          key={`${availability.timeZone}-${availability.days.length}-${availability.weekOverrides?.length ?? 0}`}
          initial={normalizeAvailability(availability)}
        />
      )}
      <PreferencesForm key={JSON.stringify(preferences)} initial={preferences} />
      <AIProfileForm key={JSON.stringify(aiProfile)} initial={aiProfile} />
    </>
  );
}
