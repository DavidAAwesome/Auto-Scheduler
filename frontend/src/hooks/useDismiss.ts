import { useEffect, type RefObject } from 'react';
/** Closes a popover/menu on Escape or a click outside `ref`, returning focus to its trigger on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, trigger?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !trigger?.current?.contains(target)) onClose();
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { onClose(); trigger?.current?.focus(); }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [ref, open, onClose, trigger]);
}
