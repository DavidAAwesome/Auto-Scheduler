import { useEffect, useRef, type ReactNode } from "react";
import Icon from "./Icon";

/** Native <dialog> with focus return, Escape, and backdrop-click handling. `busy` blocks closing mid-save. */
export default function Modal({ eyebrow, title, busy = false, onClose, children }: { eyebrow: string; title: string; busy?: boolean; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    node?.showModal();
    node?.querySelector<HTMLElement>("input, select")?.focus();
    return () => { node?.close(); trigger?.focus(); };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="task-dialog"
      aria-labelledby="modal-title"
      onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
      onClick={e => {
        if (busy || e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      <div className="task-dialog-header">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id="modal-title">{title}</h2>
        </div>
        <button className="icon-button ghost" onClick={onClose} disabled={busy} aria-label="Close"><Icon name="close" size={18} /></button>
      </div>
      {children}
    </dialog>
  );
}
