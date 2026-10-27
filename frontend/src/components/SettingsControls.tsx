import { useId, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { SaveStatus } from "../hooks/useSaveStatus";
import Icon from "./Icon";

/** A native checkbox with role="switch": Space toggles it, and its <label> names it for screen readers. */
export function Switch({ label, description, checked, onChange, disabled }: {
  label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <label htmlFor={id}>{label}</label>
        {description && <p id={`${id}-hint`} className="field-hint">{description}</p>}
      </div>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled}
        aria-describedby={description ? `${id}-hint` : undefined}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.checked)} />
    </div>
  );
}

/** Label above, number input with its unit inside the field. */
export function NumberField({ label, unit, value, onChange, min, max, step = 1, hint }: {
  label: string; unit: string; value: string; onChange: (value: string) => void; min: number; max: number; step?: number; hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}<span className="sr-only"> ({unit})</span></label>
      <div className="input-unit">
        <input id={id} type="number" inputMode="decimal" min={min} max={max} step={step} value={value}
          aria-describedby={hint ? `${id}-hint` : undefined} onChange={event => onChange(event.target.value)} />
        <span aria-hidden="true">{unit}</span>
      </div>
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>
  );
}

export function SelectField({ label, value, onChange, children, hint, disabled }: {
  label: string; value: string; onChange: (value: string) => void; children: ReactNode; hint?: ReactNode; disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} disabled={disabled} aria-describedby={hint ? `${id}-hint` : undefined} onChange={event => onChange(event.target.value)}>
        {children}
      </select>
      {hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}
    </div>
  );
}

export function SaveBar({ status, error, dirty, label = "Save changes", savedLabel = "Saved", note }: {
  status: SaveStatus; error: string; dirty: boolean; label?: string; savedLabel?: string; note?: ReactNode;
}) {
  const saving = status === "saving";
  const saved = status === "saved" && !dirty;
  return (
    <div className="save-bar">
      <div className="save-bar-message">
        {status === "error" && error && <p className="form-error" role="alert">{error}</p>}
        <p className="sr-only" role="status">{saving ? "Saving…" : saved ? savedLabel : ""}</p>
        {status !== "error" && note}
      </div>
      <button className={`button ${saved ? "is-saved" : ""}`} type="submit" disabled={saving || !dirty} aria-busy={saving || undefined}>
        {saving ? <><span className="spinner" aria-hidden="true" /> Saving…</> : saved ? <><Icon name="check" size={15} /> {savedLabel}</> : label}
      </button>
    </div>
  );
}

export function SettingsSection({ title, description, children, onSubmit, labelledBy }: {
  title: string; description?: string; children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void; labelledBy?: string;
}) {
  const id = useId();
  return (
    <form className="settings-card" onSubmit={onSubmit} aria-labelledby={labelledBy ?? id} noValidate>
      <header className="settings-card-head">
        <h2 id={id}>{title}</h2>
        {description && <p className="muted small">{description}</p>}
      </header>
      {children}
    </form>
  );
}
