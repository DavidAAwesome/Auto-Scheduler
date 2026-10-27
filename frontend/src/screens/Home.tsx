import { useState } from "react";
import type { CalendarEvent, Task, WorkSession } from "../types/models";
import TaskSidebar from "../components/TaskSidebar";
import CalendarPane from "../components/CalendarPane";
import ChatPanel from "../components/ChatPanel";
import TaskForm from "../components/TaskForm";
import SessionForm from "../components/SessionForm";
import EventForm from "../components/EventForm";
import TaskPopover from "../components/TaskPopover";
import EventPopover from "../components/EventPopover";
import SlotMenu from "../components/SlotMenu";
import { useWorkspace } from "../hooks/useWorkspace";
import { dateInZone } from "../utils/calendar";

type TaskFormState = { task?: Task; deadline?: string } | null;
type SessionFormState = { session?: WorkSession; taskId?: string; date?: string; start?: number } | null;
type EventFormState = { event?: CalendarEvent; date?: string; start?: number } | null;

/** Main screen from the sketch: today's tasks | calendar | AI chatbox. */
export default function Home() {
  const { tasks, events, availability } = useWorkspace();
  const [taskForm, setTaskForm] = useState<TaskFormState>(null);
  const [sessionForm, setSessionForm] = useState<SessionFormState>(null);
  const [eventForm, setEventForm] = useState<EventFormState>(null);
  const [selected, setSelected] = useState<{ id: string; rect: DOMRect; sessionId?: string } | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<{ id: string; date: string; rect: DOMRect } | null>(null);
  const [slot, setSlot] = useState<{ date: string; start: number; rect: DOMRect } | null>(null);
  const [status, setStatus] = useState("");
  const today = dateInZone(availability?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const selectedTask = selected && tasks.find(t => t.id === selected.id);
  const openEvent = selectedEvent && events.find(e => e.id === selectedEvent.id);
  const toast = (message: string) => { setStatus(message); setTimeout(() => setStatus(""), 2500); };
  const closeFloating = () => { setSelected(null); setSelectedEvent(null); setSlot(null); };
  const editTask = (task: Task) => { closeFloating(); setTaskForm({ task }); };
  const plan = (state: NonNullable<SessionFormState>) => { closeFloating(); setSessionForm(state); };
  const addEvent = (state: NonNullable<EventFormState>) => { closeFloating(); setEventForm(state); };
  const showTask = (task: Task, rect: DOMRect, sessionId?: string) => { closeFloating(); setSelected({ id: task.id, rect, sessionId }); };
  const showEvent = (event: CalendarEvent, date: string, rect: DOMRect) => { closeFloating(); setSelectedEvent({ id: event.id, date, rect }); };
  return (
    <div className="home-layout">
      <TaskSidebar
        today={today}
        onAdd={() => setTaskForm({})}
        onAddEvent={() => addEvent({ date: today })}
        onOpen={showTask}
        onOpenSession={showTask}
        onOpenEvent={showEvent}
      />
      <CalendarPane
        today={today}
        onOpen={showTask}
        onOpenEvent={showEvent}
        onAdd={deadline => setTaskForm({ deadline })}
        onSlot={(date, start, rect) => { closeFloating(); setSlot({ date, start, rect }); }}
        onPlan={date => plan({ date })}
      />
      <ChatPanel />
      {selectedTask && (
        <TaskPopover
          task={selectedTask}
          anchor={selected.rect}
          focusSessionId={selected.sessionId}
          onClose={() => setSelected(null)}
          onEdit={editTask}
          onPlan={task => plan({ taskId: task.id })}
          onEditSession={session => plan({ session })}
        />
      )}
      {openEvent && (
        <EventPopover event={openEvent} date={selectedEvent.date} anchor={selectedEvent.rect} onClose={() => setSelectedEvent(null)} onEdit={event => addEvent({ event })} />
      )}
      {slot && (
        <SlotMenu
          date={slot.date}
          start={slot.start}
          anchor={slot.rect}
          onClose={() => setSlot(null)}
          onPlan={() => plan({ date: slot.date, start: slot.start })}
          onAddEvent={() => addEvent({ date: slot.date, start: slot.start })}
        />
      )}
      {taskForm && (
        <TaskForm
          task={taskForm.task}
          defaultDeadline={taskForm.deadline}
          onClose={() => setTaskForm(null)}
          onSave={(message, saved, planNext) => { toast(message); if (planNext) setSessionForm({ taskId: saved.id }); }}
        />
      )}
      {sessionForm && <SessionForm {...sessionForm} onClose={() => setSessionForm(null)} onSave={toast} />}
      {eventForm && <EventForm {...eventForm} onClose={() => setEventForm(null)} onSave={toast} />}
      <p className="toast" role="status" aria-live="polite">{status}</p>
    </div>
  );
}
