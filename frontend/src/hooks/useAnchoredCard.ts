import { useCallback, useRef } from 'react';
/** Floating card placed below `anchor` (or above it when there's no room), kept inside the viewport, and focused.
 * Use `attach` as the element's ref; `ref` is for outside-click checks; `style` is the initial position. */
export function useAnchoredCard(anchor: DOMRect) {
  const ref = useRef<HTMLDivElement | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const below = anchor.bottom + 6;
    node.style.left = `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`;
    node.style.top = `${below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 6) : below}px`;
    node.focus();
  }, [anchor]);
  return { ref, attach, style: { left: anchor.left, top: anchor.bottom + 6 } };
}
