import { useSyncExternalStore } from "react";

/** Whether a media query matches now, updating when it changes. */
export function useMediaQuery(query: string) {
  return useSyncExternalStore(listener => {
    const list = window.matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  }, () => window.matchMedia(query).matches);
}
