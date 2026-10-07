import type { Availability, GeneratedPlan, Task } from '../types/models.ts';
import { addDays } from './dates.ts';
import { dateInZone, weekStart } from './calendar.ts';

export type CalendarView = 'day' | 'week' | 'month';
export function calendarDates(date: string, view: CalendarView) {
  const start = view === 'month' ? weekStart(date.slice(0, 7) + '-01') : view === 'week' ? weekStart(date) : date;
  return Array.from({ length: view === 'month' ? 42 : view === 'week' ? 7 : 1 }, (_, i) => addDays(start, i));
}
export function moveDate(date: string, view: CalendarView, direction: number) {
  if (view !== 'month') return addDays(date, direction * (view === 'week' ? 7 : 1));
  const next = new Date(date.slice(0, 7) + '-01T12:00:00Z');
  next.setUTCMonth(next.getUTCMonth() + direction);
  return next.toISOString().slice(0, 10);
}

/** Read-only explanations, not an AI service or a second scheduling engine. */
export function explainPlan(question: string, tasks: Task[], availability: Availability, plan: GeneratedPlan | null, now = new Date()) {
  const text = question.toLowerCase();
  const stale = plan?.stale ? ' This saved plan needs review because tasks, hours, or dates changed.' : '';
  if (/conflict|unscheduled|fit|why/.test(text)) {
    if (!plan) return 'No plan has been generated yet. Generate a plan to see which tasks fit your available hours.';
    const unfilled = plan.tasks.filter(task => task.unscheduledMinutes > 0);
    return (unfilled.length ? unfilled.map(task => `${task.title}: ${task.unscheduledMinutes} min unplanned. ${task.message}`).join('\n') : 'The saved plan reports no unplanned work.') +
      ` It considered ${plan.busyIntervals.length} supplied busy intervals. Live Google Calendar events have not been checked.` + stale;
  }
  if (/hour|availab|zone/.test(text)) {
    const minutes = availability.days.filter(day => day.enabled).reduce((sum, day) => sum + day.end - day.start, 0);
    return `You have ${minutes / 60} hours of weekly availability in ${availability.timeZone}. Change these hours in Settings; saved blocks only move when you confirm a new plan.`;
  }
  if (/today|task|deadline/.test(text)) {
    const today = dateInZone(availability.timeZone, now);
    const due = tasks.filter(task => !task.done && task.deadline === today);
    const overdue = tasks.filter(task => !task.done && task.deadline < today);
    return `${tasks.filter(task => !task.done).length} open tasks. ${due.length} due today in ${availability.timeZone}${due.length ? ': ' + due.map(task => `${task.title} (${task.minutes} min)`).join(', ') : ''}. ${overdue.length} overdue. Deadlines do not reserve calendar time.`;
  }
  if (/plan|schedule|week/.test(text)) {
    return plan ? `Saved plan: ${plan.startDate} through ${plan.endDate}, ${plan.timeZone}. ${plan.blocks.filter(block => block.type === 'focus').length} focus blocks and ${plan.tasks.reduce((sum, task) => sum + task.scheduledMinutes, 0)} planned minutes. Earlier deadlines come first, then priority; focus blocks last 15–60 minutes with 15-minute breaks between blocks on the same day.${stale}` : 'No saved plan yet. Add tasks and available hours, then confirm Generate plan. The scheduler plans seven days and reports work that cannot fit.';
  }
  return 'I can summarize today’s tasks, your saved plan, unplanned work, and available hours. This is a rules-based helper using your account data, not AI chat. I do not change tasks from messages; use the task actions or confirm Generate plan.';
}
