import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { CALENDAR_MIN_WIDTH, type WidthLimits } from "../services/uiState";

/**
 * A draggable edge between a side panel and the calendar. `side` is where the panel is: dragging right widens a
 * left panel and narrows a right one. Arrow keys resize by 16px (Shift: 64px); double-click or Home restores the
 * default. The width never leaves the calendar narrower than CALENDAR_MIN_WIDTH.
 */
export default function ResizeHandle({ label, side, width, limits, otherPanelWidth, onChange }: {
  label: string;
  side: "left" | "right";
  width: number;
  limits: WidthLimits;
  /** Width the other side panel takes, so this one leaves room for the calendar. */
  otherPanelWidth: () => number;
  onChange: (width: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const max = () => Math.max(limits.min, Math.min(limits.max, window.innerWidth - otherPanelWidth() - CALENDAR_MIN_WIDTH));
  const clamp = (value: number) => Math.round(Math.min(max(), Math.max(limits.min, value)));

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
    document.body.classList.add("resizing");
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    const moved = event.clientX - drag.current.x;
    onChange(clamp(drag.current.width + (side === "left" ? moved : -moved)));
  }
  function stop() {
    drag.current = null;
    document.body.classList.remove("resizing");
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (event.key === grow) onChange(clamp(width + step));
    else if (event.key === shrink) onChange(clamp(width - step));
    else if (event.key === "Home") onChange(clamp(limits.initial));
    else return;
    event.preventDefault();
  }

  return (
    <div
      className={`resize-handle ${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label} (double-click to reset)`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onDoubleClick={() => onChange(clamp(limits.initial))}
      onKeyDown={onKeyDown}
    />
  );
}
