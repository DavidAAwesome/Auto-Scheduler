import { useDismiss } from "../hooks/useDismiss";
import { useAnchoredCard } from "../hooks/useAnchoredCard";
import { clock12, longDate } from "../utils/calendar";
import Icon from "./Icon";

/** Shown when an empty calendar slot is clicked: plan work there, or add an event there. */
export default function SlotMenu({ date, start, anchor, onClose, onPlan, onAddEvent }: {
  date: string;
  start: number;
  anchor: DOMRect;
  onClose: () => void;
  onPlan: () => void;
  onAddEvent: () => void;
}) {
  const { ref: card, attach, style: position } = useAnchoredCard(anchor);
  useDismiss(card, true, onClose);
  return (
    <div ref={attach} className="popover slot-menu" role="menu" aria-label={`${longDate(date)}, ${clock12(start)}`} tabIndex={-1} style={{ position: "fixed", right: "auto", ...position }}>
      <p className="slot-menu-head">{longDate(date)} · {clock12(start)}</p>
      <button role="menuitem" className="menu-item" onClick={onPlan}><Icon name="clock" size={18} /> Plan work session</button>
      <button role="menuitem" className="menu-item" onClick={onAddEvent}><Icon name="calendar" size={18} /> Add event <span className="menu-hint">class, meeting…</span></button>
    </div>
  );
}
