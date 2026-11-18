import { useMemo, useState, type FormEvent } from "react";
import ScreenHeading from "../components/ScreenHeading";
import Icon from "../components/Icon";
import { NumberField, SaveBar, SelectField, SettingsSection, Switch } from "../components/SettingsControls";
import { useWorkspace } from "../hooks/useWorkspace";
import { useSaveStatus } from "../hooks/useSaveStatus";
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
import { WEEKDAYS, clock12, dateInZone, parseClock } from "../utils/calendar";
import { normalizeTimeZone, timeZoneChoices, timeZoneLabel } from "../utils/timeZones";
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

/** "09:00" → "9 AM", "24:00" → "Midnight". The stored value stays 24-hour. */
function clockLabel(value: string) {
  return value === "24:00" ? "Midnight" : clock12(parseClock(value));
}

function TimeSelect({ label, value, options, onChange, disabled }: {
  label: string; value: string; options: string[]; onChange: (value: string) => void; disabled?: boolean;
}) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      {options.map(option => <option key={option} value={option}>{clockLabel(option)}</option>)}
    </select>
  );
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
        return `${WEEKDAYS[day.day]}: each period must end after it starts.`;
      }
    }
    const ordered = [...day.periods].sort((a, b) => a.start - b.start);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index].start < ordered[index - 1].end) {
        return `${WEEKDAYS[day.day]}: periods can’t overlap.`;
      }
    }
  }
  return null;
}

function TimeZoneSelect({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const { common, all } = timeZoneChoices();
  const known = common.some(z => z.value === value) || all.some(z => z.value === value);
  return (
    <SelectField label="Time zone" value={value} onChange={zone => onChange(normalizeTimeZone(zone))}>
      {!known && <option value={value}>{timeZoneLabel(value)}</option>}
      <optgroup label="Common">
        {common.map(zone => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
      </optgroup>
      <optgroup label="All time zones">
        {all.map(zone => <option key={zone.value} value={zone.value}>{zone.label}</option>)}
      </optgroup>
    </SelectField>
  );
}

/** Weekly hours are wall-clock times in the account timezone, which is chosen here and nowhere else. */
function AvailabilityForm({ initial }: { initial: Availability }) {
  const seed = useMemo(() => normalizeAvailability(initial), [initial]);
  const [saved, setSaved] = useState(seed);
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
  const today = dateInZone(timeZone);
  const [addWeekDate, setAddWeekDate] = useState(today);
  const [notice, setNotice] = useState("");
  const save = useSaveStatus();

  const current = useMemo(() => {
    const days = fromDraftDays(draftDays);
    return normalizeAvailability({
      days: activeWeek === "default" ? days : defaultDays,
      weekOverrides: activeWeek === "default" ? overrides : upsertWeekOverride(overrides, activeWeek, days),
      timeZone: normalizeTimeZone(timeZone),
      reminders,
    });
  }, [draftDays, activeWeek, defaultDays, overrides, timeZone, reminders]);
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const zoneChanged = normalizeTimeZone(timeZone) !== saved.timeZone;

  function edited() {
    save.edited();
    setNotice("");
  }

  function persistDraft():
    | { defaultDays: AvailableDay[]; overrides: typeof overrides }
    | null {
    const days = fromDraftDays(draftDays);
    const issue = validateDays(days);
    if (issue) {
      save.fail(issue);
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
    setNotice("");
  }

  function changeDay(day: number, patch: Partial<DraftDay>) {
    setDraftDays((rows) =>
      rows.map((row) => (row.day === day ? { ...row, ...patch } : row)),
    );
    edited();
  }

  function changePeriod(
    day: number,
    index: number,
    patch: Partial<{ start: string; end: string }>,
  ) {
    setDraftDays((rows) =>
      rows.map((row) => {
        if (row.day !== day) return row;
        return {
          ...row,
          periods: row.periods.map((period, periodIndex) =>
            periodIndex === index ? { ...period, ...patch } : period,
          ),
        };
      }),
    );
    edited();
  }

  function addPeriod(day: number) {
    setDraftDays((rows) =>
      rows.map((row) =>
        row.day === day
          ? {
              ...row,
              enabled: true,
              periods: [...row.periods, { start: "18:00", end: "21:00" }],
            }
          : row,
      ),
    );
    edited();
  }

  function removePeriod(day: number, index: number) {
    setDraftDays((rows) =>
      rows.map((row) => {
        if (row.day !== day) return row;
        const periods = row.periods.filter((_, periodIndex) => periodIndex !== index);
        return {
          ...row,
          periods: periods.length ? periods : [{ start: "09:00", end: "17:00" }],
          enabled: periods.length ? row.enabled : false,
        };
      }),
    );
    edited();
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
    edited();
    setNotice(`Editing ${weekLabel(monday)} only.`);
  }

  function removeActiveWeek() {
    if (activeWeek === "default") return;
    setOverrides((weeks) =>
      weeks.filter((week) => week.weekStart !== activeWeek),
    );
    setDraftDays(toDraftDays(defaultDays));
    setActiveWeek("default");
    edited();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const issue = validateDays(fromDraftDays(draftDays));
    if (issue) return save.fail(issue);
    await save.run(async () => {
      const result = normalizeAvailability(await workspaceService.saveAvailability(current));
      setSaved(result);
      setDefaultDays(cloneDays(result.days));
      setOverrides(result.weekOverrides.map((week) => ({ weekStart: week.weekStart, days: cloneDays(week.days) })));
      const shown = activeWeek === "default" ? result.days : result.weekOverrides.find((week) => week.weekStart === activeWeek)?.days;
      setDraftDays(toDraftDays(shown ?? emptyWeekDays()));
      setTimeZone(normalizeTimeZone(result.timeZone));
      setReminders(result.reminders);
      setNotice("");
    });
  }

  return (
    <SettingsSection title="Availability" description="When the scheduler may plan work." onSubmit={submit}>
      <div className="settings-grid two">
        <TimeZoneSelect value={normalizeTimeZone(timeZone)} onChange={zone => { setTimeZone(zone); edited(); }} />
      </div>
      {zoneChanged && <p className="field-hint zone-hint">Events keep their actual times and show in the new time zone.</p>}

      <div className="week-tools">
        <div className="week-chips" role="group" aria-label="Week to edit">
          <button
            type="button"
            className={activeWeek === "default" ? "is-active" : ""}
            aria-pressed={activeWeek === "default"}
            onClick={() => loadWeek("default")}
          >
            Every week
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
        <div className="week-add">
          <label className="sr-only" htmlFor="add-week-date">Week to customize</label>
          <input
            id="add-week-date"
            type="date"
            value={addWeekDate}
            onChange={(event) => setAddWeekDate(event.target.value || today)}
          />
          <button type="button" className="button secondary small" onClick={addWeek}>
            Customize week
          </button>
          {activeWeek !== "default" && (
            <button type="button" className="button ghost small" onClick={removeActiveWeek}>
              Use usual hours
            </button>
          )}
        </div>
      </div>
      {notice && <p className="field-hint">{notice}</p>}

      <fieldset className="day-list">
        <legend className="sr-only">Weekly hours</legend>
        {draftDays.map((row) => (
          <div className={`day-row ${row.enabled ? "" : "is-off"}`} key={row.day}>
            <label className="day-toggle">
              <input
                type="checkbox"
                role="switch"
                className="switch"
                checked={row.enabled}
                onChange={(event) =>
                  changeDay(row.day, { enabled: event.target.checked })
                }
              />
              <span>{WEEKDAYS[row.day]}</span>
            </label>
            {row.enabled ? (
              <div className="day-periods">
                {row.periods.map((period, index) => (
                  <div className="period" key={`${row.day}-${index}`}>
                    <TimeSelect
                      label={`${WEEKDAYS[row.day]} period ${index + 1} start`}
                      value={period.start}
                      options={START_OPTIONS}
                      onChange={(start) => changePeriod(row.day, index, { start })}
                    />
                    <span className="period-dash" aria-hidden="true">–</span>
                    <TimeSelect
                      label={`${WEEKDAYS[row.day]} period ${index + 1} end`}
                      value={period.end}
                      options={END_OPTIONS}
                      onChange={(end) => changePeriod(row.day, index, { end })}
                    />
                    <button
                      type="button"
                      className="icon-button ghost small"
                      disabled={row.periods.length === 1}
                      aria-label={`Remove period ${index + 1} on ${WEEKDAYS[row.day]}`}
                      title="Remove period"
                      onClick={() => removePeriod(row.day, index)}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="add-period"
                  aria-label={`Add a period on ${WEEKDAYS[row.day]}`}
                  onClick={() => addPeriod(row.day)}
                >
                  <Icon name="plus" size={14} /> Add period
                </button>
              </div>
            ) : (
              <span className="day-off">Unavailable</span>
            )}
          </div>
        ))}
      </fieldset>

      <Switch
        label="Reminders"
        checked={reminders}
        onChange={(on) => { setReminders(on); edited(); }}
      />
      <SaveBar status={save.status} error={save.error} dirty={dirty} label="Save availability" />
    </SettingsSection>
  );
}

const asNumber = (value: string) => (value.trim() === "" ? NaN : Number(value));

/** Focus length, break length, daily cap and an optional protected lunch. The scheduler and validator both use these. */
function PreferencesForm({ initial }: { initial: SchedulePreferences }) {
  const [saved, setSaved] = useState(initial);
  const [focus, setFocus] = useState(String(initial.focusMinutes));
  const [rest, setRest] = useState(String(initial.breakMinutes));
  const [daily, setDaily] = useState(String(initial.maxDailyWorkMinutes / 60));
  const [lunchOn, setLunchOn] = useState(initial.lunch !== null);
  const [lunchStart, setLunchStart] = useState(clock(initial.lunch?.start ?? 720));
  const [lunchEnd, setLunchEnd] = useState(clock(initial.lunch?.end ?? 780));
  const save = useSaveStatus();

  const current: SchedulePreferences = {
    focusMinutes: asNumber(focus),
    breakMinutes: asNumber(rest),
    maxDailyWorkMinutes: Math.round(asNumber(daily) * 60),
    lunch: lunchOn ? { start: parseClock(lunchStart), end: parseClock(lunchEnd) } : null,
  };
  const dirty = JSON.stringify(current) !== JSON.stringify({ ...saved, lunch: saved.lunch ? { start: saved.lunch.start, end: saved.lunch.end } : null });
  const set = (setter: (value: string) => void) => (value: string) => { setter(value); save.edited(); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { focusMinutes, breakMinutes, maxDailyWorkMinutes, lunch } = current;
    if (!Number.isInteger(focusMinutes) || focusMinutes < 10 || focusMinutes > 240) return save.fail("Focus length must be 10 to 240 minutes.");
    if (!Number.isInteger(breakMinutes) || breakMinutes < 5 || breakMinutes > 120) return save.fail("Break length must be 5 to 120 minutes.");
    if (!Number.isFinite(maxDailyWorkMinutes) || maxDailyWorkMinutes < 15 || maxDailyWorkMinutes > 1440) return save.fail("Daily task limit must be 0.25 to 24 hours.");
    if (lunch && !(lunch.end > lunch.start)) return save.fail("Lunch must end after it starts.");
    await save.run(async () => {
      await workspaceService.savePreferences(current);
      setSaved(current);
    });
  }

  return (
    <SettingsSection title="Focus & breaks" description="How the scheduler paces your work." onSubmit={submit}>
      <div className="settings-grid three">
        <NumberField label="Focus length" unit="minutes" min={10} max={240} value={focus} onChange={set(setFocus)} />
        <NumberField label="Break length" unit="minutes" min={5} max={120} value={rest} onChange={set(setRest)} />
        <NumberField label="Daily task limit" unit="hours" min={0.25} max={24} step={0.25} value={daily} onChange={set(setDaily)} />
      </div>
      <Switch label="Protect a lunch break" checked={lunchOn} onChange={(on) => { setLunchOn(on); save.edited(); }} />
      {lunchOn && (
        <div className="settings-grid two lunch-times">
          <SelectField label="Lunch starts" value={lunchStart} onChange={set(setLunchStart)}>
            {START_OPTIONS.map(o => <option key={o} value={o}>{clockLabel(o)}</option>)}
          </SelectField>
          <SelectField label="Lunch ends" value={lunchEnd} onChange={set(setLunchEnd)}>
            {END_OPTIONS.map(o => <option key={o} value={o}>{clockLabel(o)}</option>)}
          </SelectField>
        </div>
      )}
      <SaveBar status={save.status} error={save.error} dirty={dirty} label="Save focus & breaks" />
    </SettingsSection>
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
  const [saved, setSaved] = useState(initial);
  const [replyStyle, setReplyStyle] = useState<ReplyStyle>(initial.replyStyle);
  const [tone, setTone] = useState<AssistantTone>(initial.tone);
  const [aboutMe, setAboutMe] = useState(initial.aboutMe);
  const save = useSaveStatus();
  const dirty = replyStyle !== saved.replyStyle || tone !== saved.tone || aboutMe.trim() !== saved.aboutMe;
  const nearLimit = aboutMe.length > ABOUT_ME_MAX * 0.9;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (aboutMe.length > ABOUT_ME_MAX) return save.fail(`Keep “About me” under ${ABOUT_ME_MAX} characters.`);
    const next = { replyStyle, tone, aboutMe: aboutMe.trim() };
    await save.run(async () => {
      await workspaceService.saveAIProfile(next);
      setSaved(next);
      setAboutMe(next.aboutMe);
    });
  }

  return (
    <SettingsSection title="Assistant" description="How the assistant talks to you." onSubmit={submit}>
      <div className="settings-grid two">
        <SelectField label="Reply style" value={replyStyle} hint={REPLY_STYLES.find(o => o.value === replyStyle)?.hint}
          onChange={value => { setReplyStyle(value as ReplyStyle); save.edited(); }}>
          {REPLY_STYLES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </SelectField>
        <SelectField label="Tone" value={tone} onChange={value => { setTone(value as AssistantTone); save.edited(); }}>
          {TONES.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </SelectField>
      </div>
      <div className="field">
        <label htmlFor="about-me">About me</label>
        <div className="textarea-wrap">
          <textarea id="about-me" rows={4} maxLength={ABOUT_ME_MAX} value={aboutMe} aria-describedby="about-me-count"
            placeholder="e.g. Grad student. I focus best at night. Classes Tue/Thu afternoons."
            onChange={e => { setAboutMe(e.target.value); save.edited(); }} />
          <span id="about-me-count" className={`char-count ${nearLimit ? "is-near" : ""}`}>
            {aboutMe.length}/{ABOUT_ME_MAX}<span className="sr-only"> characters</span>
          </span>
        </div>
      </div>
      <SaveBar status={save.status} error={save.error} dirty={dirty} label="Save assistant" />
    </SettingsSection>
  );
}

export default function Settings() {
  const { availability, preferences, aiProfile } = useWorkspace();
  return (
    <div className="settings-page">
      <ScreenHeading eyebrow="SETTINGS" title="Planning, on your terms." />
      {availability && <AvailabilityForm initial={normalizeAvailability(availability)} />}
      <PreferencesForm initial={preferences} />
      <AIProfileForm initial={aiProfile} />
    </div>
  );
}
