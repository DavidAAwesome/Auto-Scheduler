import type { IconName } from "../components/Icon";
import type { Category } from "../types/models";
export const categoryIcon: Record<Category, IconName> = {
  Project: "project",
  Study: "study",
  Personal: "personal",
  Work: "work",
};
/** 90 → "1h 30m", 45 → "45m". */
export function duration(minutes: number) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}
