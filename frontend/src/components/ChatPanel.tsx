import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../services/authSession";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { ApiError } from "../services/api";
import { confirmPreferenceChange, parseRequest, requestFromIntent, runAssistantCommand, type AssistantCommand, type ParsedRequest } from "../services/assistantCommands";
import type { PreferenceChange } from "../types/models";
import { buildWelcome, replyToPrompt, type AssistantMessage } from "../services/plannerAssistant";
import { chatPanelStore, useChatPanelOpen } from "../services/uiState";
import Icon from "./Icon";

const PROMPTS = ["Show my plan", "Plan my week", "Busy time", "Today’s tasks"];
const ACTION_LABEL: Record<AssistantCommand, string> = {
  generate_schedule: "Generate Schedule",
  apply_schedule: "Apply",
  cancel_schedule: "Cancel",
  show_plan: "Show my plan",
  show_today: "Today’s plan",
  busy_time: "Busy time",
  explain_unscheduled: "What didn’t fit?",
  replan: "Repair schedule",
};

/**
 * AI chatbox. Scheduling questions run the same workspace actions as the calendar buttons, and the reply
 * reports only what those actions returned. Other questions go to OpenAI when configured, else to local rules.
 */
export default function ChatPanel() {
  const open = useChatPanelOpen();
  const { user } = useAuth();
  const { tasks, sessions, events, connections, availability, schedulePreview, saving } = useWorkspace();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [thinking, setThinking] = useState(false);
  /** The command currently awaiting a real response from the workspace, if any. */
  const [working, setWorking] = useState<ParsedRequest["command"] | null>(null);
  const [usingOpenAI, setUsingOpenAI] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const context = { tasks, sessions, events, availability, connections, schedulePreview };
  const welcome = buildWelcome(context);
  const busy = thinking || working !== null || saving;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, thinking, working]);

  function append(message: AssistantMessage) {
    setMessages(previous => [...previous.slice(-18), message]);
  }

  /** Runs a command and posts its real outcome. The loading line is shown only while this await is pending. */
  async function run(request: ParsedRequest | AssistantCommand) {
    setError("");
    setWorking(typeof request === "string" ? request : request.command);
    try {
      append(await runAssistantCommand(request, workspaceService));
    } finally {
      setWorking(null);
    }
  }

  async function ask(prompt: string) {
    const text = prompt.trim();
    if (!text || busy) return;
    const id = String(++nextId.current);
    append({ id: `${id}-q`, role: "user", text });
    setInput("");
    setError("");

    const parsed = parseRequest(text, workspaceService.getSnapshot());
    if (parsed) {
      await run(parsed);
      return;
    }

    let reply: Awaited<ReturnType<typeof workspaceService.chatAssistant>>;
    setThinking(true);
    try {
      const history = [...messages, { id: `${id}-q`, role: "user" as const, text }]
        .slice(-8)
        .map(m => ({ role: m.role, text: m.text }));
      reply = await workspaceService.chatAssistant(text, history);
      setUsingOpenAI(true);
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      // No key / unavailable: keep the local helper so chat still works offline.
      if (status === 503 || status === 0) {
        setUsingOpenAI(false);
        append(replyToPrompt(text, context, `${id}-a`));
      } else {
        setError((e as Error).message);
        append({ id: `${id}-a`, role: "assistant", text: "I couldn’t reach the assistant just now. Try again, or use the buttons above the calendar." });
      }
      return;
    } finally {
      setThinking(false);
    }

    // The model only picks an intent. Every scheduling answer comes from the service, so chat never claims an
    // action that did not happen.
    const request = requestFromIntent(reply, workspaceService.getSnapshot());
    if (request) await run(request);
    else append({ id: `${id}-a`, role: "assistant", text: reply.reply });
  }

  /** Save / Not now on a proposed preference change. The buttons disappear once either is pressed. */
  async function resolveChange(messageId: string, change: PreferenceChange, save: boolean) {
    setMessages(previous => previous.map(m => (m.id === messageId ? { ...m, pendingChange: undefined } : m)));
    if (!save) {
      append({ id: `${messageId}-skip`, role: "assistant", text: "Okay, nothing was changed." });
      return;
    }
    setError("");
    setWorking("update_preferences");
    try {
      append(await confirmPreferenceChange(change, workspaceService));
    } finally {
      setWorking(null);
    }
  }

  function submit(event: FormEvent) { event.preventDefault(); void ask(input); }

  if (!open)
    return (
      <button className="chat-tab" onClick={() => chatPanelStore.set(true)} aria-label="Open AI chatbox">
        <Icon name="assistant" size={18} /> <span>AI</span>
      </button>
    );

  // Only the newest message with buttons offers them, so an old Apply cannot be pressed after a newer result.
  const actionMessageId = [...messages].reverse().find(m => m.actions?.length)?.id;
  return (
    <aside className="chat-panel" aria-label="AI chatbox">
      <div className="chat-head">
        <h2><Icon name="assistant" size={18} /> AI Chatbox</h2>
        <button className="icon-button ghost small" aria-label="Hide AI chatbox" onClick={() => chatPanelStore.set(false)}><Icon name="panel" size={17} /></button>
      </div>
      <div className="chat-messages" ref={log} role="log" aria-live="polite" aria-label="Planning conversation">
        <p className="bubble assistant">Hi{user?.name ? ` ${user.name.split(" ")[0]}` : ""}! {welcome.text}</p>
        {messages.map(m => (
          <div key={m.id} className={`bubble-group ${m.role}`}>
            <p className={`bubble ${m.role}`}>{m.text}</p>
            {m.pendingChange && m.id === messages[messages.length - 1]?.id && (
              <div className="chat-actions" role="group" aria-label="Confirm preference change">
                <button className="button small" disabled={busy} onClick={() => void resolveChange(m.id, m.pendingChange!, true)}>Save preference</button>
                <button className="button small secondary" disabled={busy} onClick={() => void resolveChange(m.id, m.pendingChange!, false)}>Not now</button>
              </div>
            )}
            {m.id === actionMessageId && m.actions && (
              <div className="chat-actions" role="group" aria-label="Schedule actions">
                {m.actions
                  .filter(action => (action === "apply_schedule" || action === "cancel_schedule") ? schedulePreview !== null : true)
                  .map(action => (
                    <button
                      key={action}
                      className={`button small ${action === "cancel_schedule" ? "secondary" : ""}`}
                      disabled={busy}
                      onClick={() => void run(action)}
                    >
                      {ACTION_LABEL[action]}
                    </button>
                  ))}
              </div>
            )}
          </div>
        ))}
        {thinking && <p className="bubble assistant muted">Thinking…</p>}
        {(working === "generate_schedule" || working === "replan" || working === "move_task") && <p className="bubble assistant muted">Building a schedule preview from your tasks, events and availability…</p>}
        {working === "request_break" && <p className="bubble assistant muted">Finding room for a protected break…</p>}
        {working === "apply_schedule" && <p className="bubble assistant muted">Saving the proposed sessions…</p>}
        {working === "update_preferences" && <p className="bubble assistant muted">Saving your preference…</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <div className="chat-prompts">
        {PROMPTS.map(p => <button key={p} className="chip" disabled={busy} onClick={() => void ask(p)}>{p}</button>)}
      </div>
      <form className="chat-input" onSubmit={submit}>
        <input value={input} maxLength={500} onChange={e => setInput(e.target.value)} placeholder="Ask, plan my week, or tell me how you like to work…" aria-label="Message the assistant" disabled={busy} />
        <button className="icon-button" disabled={!input.trim() || busy} aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
      <p className="chat-foot">
        {usingOpenAI
          ? "OpenAI answers from your account data. Schedules come from AutoPlan’s engine and stay previews until you Apply them."
          : "Local helper until OPENAI_API_KEY is set. Schedules stay previews until you Apply them."}
      </p>
    </aside>
  );
}
