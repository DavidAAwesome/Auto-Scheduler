import { useMemo, useState, type FormEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import type { Availability, AvailableDay } from "../types/models";
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

export default function Settings() {
  const { availability } = useWorkspace();
  return (
    <>
      <ScreenHeading title="Settings" />
      {availability && (
        <AvailabilityForm
          key={`${availability.timeZone}-${availability.days.length}-${availability.weekOverrides?.length ?? 0}`}
          initial={normalizeAvailability(availability)}
        />
      )}
    </>
  );
}
