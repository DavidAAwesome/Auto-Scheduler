import type { DemoWorkspace, Task } from "../types/models.ts";
import { addDays, localDate } from "../utils/dates.ts";
// Sample labels/values reproduced from the visible prototype. Dates are relative
// to first use so a fresh demo remains useful; persisted data is never reseeded.
export function createSampleData(today = localDate()): DemoWorkspace {
  const tasks: Task[] = [
    {
      id: "sample-lecture",
      title: "Review security lecture",
      deadline: addDays(today, 1),
      minutes: 120,
      priority: "High",
      category: "Study",
      done: false,
    },
    {
      id: "sample-sprint",
      title: "Outline AutoPlan sprint",
      deadline: addDays(today, 2),
      minutes: 90,
      priority: "High",
      category: "Project",
      done: false,
    },
    {
      id: "sample-python",
      title: "Practice Python exercises",
      deadline: addDays(today, 4),
      minutes: 90,
      priority: "Medium",
      category: "Study",
      done: false,
    },
    {
      id: "sample-review",
      title: "Weekly planning review",
      deadline: addDays(today, 6),
      minutes: 30,
      priority: "Low",
      category: "Personal",
      done: false,
    },
  ];
  return {
    version: 2,
    tasks,
    availability: { start: 540, end: 1080, weekends: false },
    calendarEvents: [
      {
        id: "sample-calendar",
        title: "Sample Google Calendar event",
        date: today,
        start: 600,
        end: 660,
      },
    ],
    scheduledBlocks: [],
  };
}
