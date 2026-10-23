import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../services/authSession";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { buildWelcome, replyToPrompt, type AssistantMessage } from "../services/plannerAssistant";
import { chatPanelStore, useChatPanelOpen } from "../services/uiState";
import { dateInZone } from "../utils/calendar";
import { busyIntervalsFor } from "../utils/planning";
import { duration } from "../utils/taskDisplay";
import Icon from "./Icon";

const PROMPTS = ["Today’s tasks", "Generate plan", "What didn’t fit?", "Busy time"];
const PLAN_DAYS = 7; // the scheduler plans a seven-day window starting today

/** The sketch's "AI Chatbox": Lan's rules-based planning assistant (no AI service yet) plus plan generation. */
export default function ChatPanel() {
  const open = useChatPanelOpen();
  const { user } = useAuth();
  const { tasks, sessions, events, connections, availability, plan, saving } = useWorkspace();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const context = { tasks, plan, availability, connections };
  const welcome = buildWelcome(context);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages]);

  function ask(prompt: string) {
    if (!prompt.trim()) return;
    const id = String(++nextId.current);
    setMessages(previous => [...previous.slice(-18), { id: `${id}-q`, role: "user", text: prompt }, replyToPrompt(prompt, context, `${id}-a`)]);
    setInput("");
  }
  /** Classes, meetings and your own work sessions are sent as busy time, so auto-planned focus never overlaps them. */
  async function generate() {
    if (!availability) return;
    setError("");
    const busy = busyIntervalsFor(events, sessions, dateInZone(availability.timeZone), PLAN_DAYS, availability.timeZone);
    try {
      const saved = await workspaceService.generatePlan(busy, busy.length ? "provided" : "availability_only");
      const planned = saved.tasks.reduce((sum, t) => sum + t.scheduledMinutes, 0);
      const missing = saved.tasks.filter(t => t.unscheduledMinutes > 0).length;
      setMessages(previous => [...previous, {
        id: `${++nextId.current}-plan`, role: "assistant",
        text: `Plan saved: ${duration(planned)} of focus time over the next 7 days, around ${busy.length} events and work sessions.${missing ? ` ${missing} task(s) didn’t fully fit; ask “What didn’t fit?”.` : " Everything fit."}`,
      }]);
    } catch (e) { setError((e as Error).message); }
  }
  function submit(event: FormEvent) { event.preventDefault(); ask(input); }

  if (!open)
    return (
      <button className="chat-tab" onClick={() => chatPanelStore.set(true)} aria-label="Open AI chatbox">
        <Icon name="assistant" size={18} /> <span>AI</span>
      </button>
    );
  const pending = [...messages].reverse().find(m => m.role === "assistant")?.pendingAction;
  return (
    <aside className="chat-panel" aria-label="AI chatbox">
      <div className="chat-head">
        <h2><Icon name="assistant" size={18} /> AI Chatbox</h2>
        <button className="icon-button ghost small" aria-label="Hide AI chatbox" onClick={() => chatPanelStore.set(false)}><Icon name="panel" size={17} /></button>
      </div>
      <div className="chat-messages" ref={log} role="log" aria-live="polite" aria-label="Planning conversation">
        <p className="bubble assistant">Hi{user?.name ? ` ${user.name.split(" ")[0]}` : ""}! {welcome.text}</p>
        {messages.map(m => <p key={m.id} className={`bubble ${m.role}`}>{m.text}</p>)}
        {pending?.type === "generate_plan" && (
          <div className="chat-confirm" role="group" aria-label="Confirm plan generation">
            <button className="button small" disabled={saving} onClick={() => void generate()}>{saving ? "Planning…" : pending.label}</button>
            <span className="muted small">Replaces the saved plan. Your tasks, events and sessions aren’t changed.</span>
          </div>
        )}
        {plan?.stale && <p className="plan-notice small">Saved plan needs review. {plan.staleReasons.join(" ")}</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <div className="chat-prompts">
        {PROMPTS.map(p => <button key={p} className="chip" onClick={() => ask(p)}>{p}</button>)}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input value={input} maxLength={500} onChange={e => setInput(e.target.value)} placeholder="Ask about your plan…" aria-label="Message the assistant" />
        <button className="icon-button" disabled={!input.trim()} aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
      <p className="chat-foot">Rules-based helper using your account data. Natural-language task entry arrives in Sprint 3.</p>
    </aside>
  );
}
