import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from "react";
import { useAuth } from "../services/authSession";
import { useWorkspace } from "../hooks/useWorkspace";
import { workspaceService } from "../services/workspace";
import { ApiError } from "../services/api";
import { confirmPreferenceChange, parseRequest, requestFromIntent, runAssistantCommand, type AssistantCommand, type ParsedRequest } from "../services/assistantCommands";
import type { PendingAction, PreferenceChange } from "../types/models";
import { BUTTONS, CANCEL, CONFIRM, chosen, openActions, parseSelection, resolveConfirm } from "../services/pendingActions";
import { confirmEventAction, confirmLabel, type PendingEventAction } from "../services/eventCommands";
import { buildWelcome, replyToPrompt, type AssistantMessage } from "../services/plannerAssistant";
import { chatPanelStore, useChatPanelOpen } from "../services/uiState";
import { draftsReply, firstOpenQuestion, IMAGE_TYPES, looksLikePlanEntry, readImage } from "../services/planEntry";
import type { ImageAttachment } from "../services/workspaceStore";
import Icon from "./Icon";

const PROMPTS = ["Show my plan", "Plan my week", "Busy time", "Today’s tasks"];
const ACTION_LABEL: Partial<Record<AssistantCommand, string>> = {
  generate_schedule: "Generate Schedule",
  apply_schedule: "Apply schedule",
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
/** The buttons of one pending action, or its outcome once it has run. */
function ActionButtons({ id, actions, busy, onConfirm, onDecline }: { id: string; actions: PendingAction[]; busy: boolean; onConfirm: (a: PendingAction) => void; onDecline: (a: PendingAction) => void }) {
  const action = actions.find(a => a.id === id);
  if (!action) return null;
  if (action.status === "succeeded") return <p className="chat-action-status">Done.</p>;
  if (action.status === "cancelled") return <p className="chat-action-status">{action.error ?? "Cancelled. Nothing was changed."}</p>;
  const labels = BUTTONS[action.type];
  return (
    <div className="chat-actions" role="group" aria-label={action.summary}>
      {action.targets.length > 0 && action.type === "delete_tasks" && (
        <ul className="chat-action-targets">{action.targets.map(t => <li key={t.id}>{t.title}{t.detail ? ` · ${t.detail}` : ""}</li>)}</ul>
      )}
      {action.status === "failed" && action.error && <p role="alert" className="form-error">{action.error}</p>}
      <button className={`button small ${action.type === "delete_tasks" ? "danger" : ""}`} disabled={busy || action.status === "processing"} onClick={() => onConfirm(action)}>
        {action.status === "processing" ? "Working…" : action.status === "failed" ? `Try again: ${labels.confirm(action)}` : labels.confirm(action)}
      </button>
      <button className="button small secondary" disabled={busy || action.status === "processing"} onClick={() => onDecline(action)}>{labels.other}</button>
    </div>
  );
}

export default function ChatPanel() {
  const open = useChatPanelOpen();
  const { user } = useAuth();
  const { tasks, sessions, events, connections, availability, schedulePreview, saving, planDrafts, planBusy, pendingActions } = useWorkspace();
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [input, setInput] = useState("");
  /** An image waiting to be sent with the next message (e.g. a class timetable). */
  const [image, setImage] = useState<(ImageAttachment & { url: string }) | null>(null);
  const [reading, setReading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [thinking, setThinking] = useState(false);
  /** The command currently awaiting a real response from the workspace, if any. */
  const [working, setWorking] = useState<ParsedRequest["command"] | null>(null);
  const [usingOpenAI, setUsingOpenAI] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const context = { tasks, sessions, events, availability, connections, schedulePreview };
  const welcome = buildWelcome(context);
  const busy = thinking || working !== null || saving || reading || planBusy;
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [messages, thinking, working]);

  function append(message: AssistantMessage) {
    setMessages(previous => [...previous.slice(-18), message]);
  }

  /** Runs a command and posts its real outcome. The loading line is shown only while this await is pending. */
  async function run(request: ParsedRequest | AssistantCommand) {
    setError("");
    setWorking("generate_schedule");
    try {
      append(await runAssistantCommand(request, workspaceService));
    } finally {
      setWorking(null);
    }
  }

  /** The confirm button of a pending action (or a typed “confirm” routed here). Reports only the server's result. */
  async function confirm(action: PendingAction) {
    if (action.type === "apply_schedule") return run("apply_schedule");
    setError("");
    const id = `act-${++nextId.current}`;
    try {
      const result = await workspaceService.confirmAction(action.id);
      const names = result.action.targets.map(t => `“${t.title}”`).join(", ");
      append({ id, role: "assistant", text: result.duplicate
        ? "That was already done, so nothing else changed."
        : result.action.type === "delete_tasks"
          ? `Deleted ${names}${result.action.sessionCount ? ` and ${result.action.sessionCount} scheduled session${result.action.sessionCount === 1 ? "" : "s"}` : ""}.`
          : `Saved ${names} as ${result.tasks.length + result.events.length === 1 ? "an item" : "items"} on your list. They are not scheduled yet: say “plan my week” or use Generate Schedule.` });
    } catch (e) {
      setError((e as Error).message);
      append({ id, role: "assistant", text: `Not done: ${(e as Error).message} Nothing was changed. You can try again.` });
    }
  }

  /** The second button: Cancel (deletions, schedule) or Edit (drafts, which stay in the review panel). */
  async function decline(action: PendingAction) {
    if (action.type === "apply_schedule") return run("cancel_schedule");
    setError("");
    try {
      await workspaceService.cancelAction(action.id);
      if (action.type === "create_items") {
        window.dispatchEvent(new CustomEvent("autoplan:review-drafts"));
        append({ id: `act-${++nextId.current}`, role: "assistant", text: "Okay, nothing was saved. Edit the items in the review panel above the calendar." });
      } else append({ id: `act-${++nextId.current}`, role: "assistant", text: "Cancelled. Nothing was changed." });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** Confirmations waiting in the chat itself (event add/delete, preference save), alongside stored actions. */
  function confirmCandidates() {
    const state = workspaceService.getSnapshot();
    const last = messages[messages.length - 1];
    const chat = last?.pendingEvent ? [{ id: `chat:${last.id}`, summary: last.text }] : last?.pendingChange ? [{ id: `chat:${last.id}`, summary: last.text }] : [];
    return [...openActions(state).map(a => ({ id: a.id, summary: a.summary, action: a })), ...chat.map(c => ({ ...c, action: null as PendingAction | null }))];
  }

  async function confirmById(id: string, yes: boolean) {
    if (id.startsWith("chat:")) {
      const message = messages.find(m => m.id === id.slice(5));
      if (message?.pendingEvent) return resolveEvent(message.id, message.pendingEvent, yes);
      if (message?.pendingChange) return resolveChange(message.id, message.pendingChange, yes);
      return;
    }
    const action = openActions(workspaceService.getSnapshot()).find(a => a.id === id);
    if (action) await (yes ? confirm(action) : decline(action));
  }

  /** Typed “confirm”/“cancel” and numbered replies. Returns true when the message was handled here. */
  async function typedReply(text: string, id: string) {
    const state = workspaceService.getSnapshot();
    const choice = state.pendingChoice;
    const picked = choice ? parseSelection(text, choice.options.length) : null;
    if (choice && picked) {
      if ("error" in picked) { append({ id: `${id}-a`, role: "assistant", text: picked.error }); return true; }
      workspaceService.setChoice(null);
      const options = chosen(choice, picked.indexes);
      if (choice.purpose === "delete_tasks") await run({ command: "delete_task", taskIds: options.map(o => o.id) });
      else for (const option of options) await confirmById(option.id, true);
      return true;
    }
    const yes = CONFIRM.test(text);
    if (!yes && !CANCEL.test(text)) return false;
    const decision = resolveConfirm(confirmCandidates());
    if (decision.kind === "none") {
      append({ id: `${id}-a`, role: "assistant", text: yes ? "Nothing is waiting for confirmation." : "There is nothing to cancel." });
    } else if (decision.kind === "one") {
      await confirmById(decision.target.id, yes);
    } else if (yes) {
      workspaceService.setChoice({ id: `confirm-${id}`, purpose: "confirm", prompt: "Which one should I do?", options: decision.options });
      append({ id: `${id}-a`, role: "assistant", text: `Several things are waiting. Which one should I do?\n${decision.options.map((o, i) => `${i + 1}. ${o.title}`).join("\n")}\nReply with its number, or use its button.` });
    } else {
      append({ id: `${id}-a`, role: "assistant", text: "Several things are waiting. Use the Cancel button on the one you mean." });
    }
    return true;
  }

  /**
   * Text and/or an image → editable drafts in the review panel. Nothing is saved here; on failure the message
   * and image go back into the composer so nothing the user typed is lost.
   */
  async function interpret(text: string, id: string, attachment: typeof image) {
    setReading(true);
    try {
      const result = await workspaceService.interpretPlan(text, attachment ? { mediaType: attachment.mediaType, dataBase64: attachment.dataBase64, name: attachment.name } : null);
      if (attachment) URL.revokeObjectURL(attachment.url);
      append({ id: `${id}-a`, role: "assistant", text: draftsReply(result.drafts, result.provider, result.notes) });
    } catch (e) {
      setInput(text);
      setImage(attachment);
      setError((e as Error).message);
      append({ id: `${id}-a`, role: "assistant", text: "I couldn’t read that, so nothing was added. Your message is back in the box; try again or edit it." });
    } finally {
      setReading(false);
    }
  }

  /** A plain reply while a draft has an open question answers that question on the same draft. */
  async function answer(text: string, id: string, open: NonNullable<ReturnType<typeof firstOpenQuestion>>) {
    setReading(true);
    try {
      const updated = await workspaceService.clarifyDraft(open.draftId, open.field, text);
      const next = firstOpenQuestion(workspaceService.getSnapshot().planDrafts?.views ?? []);
      const title = updated.draft.title ?? "that item";
      append({ id: `${id}-a`, role: "assistant", text: next
        ? `Updated “${title}”. Next: ${next.question}`
        : `Updated “${title}”. Every draft has what it needs. Use “Can this fit?” or “Preview on calendar”; nothing is saved until you Apply.` });
    } catch (e) {
      setInput(text);
      setError((e as Error).message);
      append({ id: `${id}-a`, role: "assistant", text: `That didn’t answer “${open.question}”. Try again, or edit the draft in the review panel.` });
    } finally {
      setReading(false);
    }
  }

  async function ask(prompt: string) {
    const text = prompt.trim();
    const attachment = image;
    if ((!text && !attachment) || busy) return;
    const id = String(++nextId.current);
    append({ id: `${id}-q`, role: "user", text: attachment ? `${text}${text ? "\n" : ""}[image: ${attachment.name}]` : text });
    setInput("");
    setImage(null);
    setError("");

    if (!attachment && await typedReply(text, id)) return;
    // Images and multi-item messages always become drafts; a single line is checked for commands first.
    const multiline = text.split(/\n/).filter(l => l.trim()).length > 1;
    if (attachment || (multiline && looksLikePlanEntry(text))) return interpret(text, id, attachment);
    const parsed = parseRequest(text, workspaceService.getSnapshot());
    if (parsed) {
      await run(parsed);
      return;
    }
    if (looksLikePlanEntry(text)) return interpret(text, id, null);
    const open = firstOpenQuestion(workspaceService.getSnapshot().planDrafts?.views ?? []);
    if (open && !/\?\s*$/.test(text)) return answer(text, id, open);

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
    const request = requestFromIntent(reply, workspaceService.getSnapshot(), text);
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

  /** Confirm / Cancel on a proposed event add or delete. The buttons disappear once either is pressed. */
  async function resolveEvent(messageId: string, action: PendingEventAction, confirm: boolean) {
    setMessages(previous => previous.map(m => (m.id === messageId ? { ...m, pendingEvent: undefined } : m)));
    if (!confirm) {
      append({ id: `${messageId}-cancel`, role: "assistant", text: "Okay, nothing was changed." });
      return;
    }
    setError("");
    setWorking("propose_event");
    try {
      append({ id: `${messageId}-done`, role: "assistant", text: await confirmEventAction(action, workspaceService) });
    } finally {
      setWorking(null);
    }
  }

  function submit(event: FormEvent) { event.preventDefault(); void ask(input); }

  /** Enter sends; Shift+Enter starts a new line, so several tasks can go in one message. */
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(input);
    }
  }

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    try {
      const data = await readImage(file);
      if (image) URL.revokeObjectURL(image.url);
      setImage({ ...data, url: URL.createObjectURL(file) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

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
            {m.pendingEvent && m.id === messages[messages.length - 1]?.id && (
              <div className="chat-actions" role="group" aria-label="Confirm event change">
                <button className={`button small ${m.pendingEvent.type === "add_event" ? "" : "danger"}`} disabled={busy} onClick={() => void resolveEvent(m.id, m.pendingEvent!, true)}>{confirmLabel(m.pendingEvent)}</button>
                <button className="button small secondary" disabled={busy} onClick={() => void resolveEvent(m.id, m.pendingEvent!, false)}>Cancel</button>
              </div>
            )}
            {m.pendingChange && m.id === messages[messages.length - 1]?.id && (
              <div className="chat-actions" role="group" aria-label="Confirm preference change">
                <button className="button small" disabled={busy} onClick={() => void resolveChange(m.id, m.pendingChange!, true)}>Save preference</button>
                <button className="button small secondary" disabled={busy} onClick={() => void resolveChange(m.id, m.pendingChange!, false)}>Not now</button>
              </div>
            )}
            {m.actionId && <ActionButtons id={m.actionId} actions={pendingActions} busy={busy} onConfirm={a => void confirm(a)} onDecline={a => void decline(a)} />}
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
        {reading && <p className="bubble assistant muted">Reading your message into drafts…</p>}
        {planBusy && !reading && <p className="bubble assistant muted">Checking your drafts with the scheduler…</p>}
        {(working === "generate_schedule" || working === "replan" || working === "move_task") && <p className="bubble assistant muted">Building a schedule preview from your tasks, events and availability…</p>}
        {working === "request_break" && <p className="bubble assistant muted">Finding room for a protected break…</p>}
        {working === "apply_schedule" && <p className="bubble assistant muted">Saving the proposed sessions…</p>}
        {working === "update_preferences" && <p className="bubble assistant muted">Saving your preference…</p>}
        {working === "propose_event" && <p className="bubble assistant muted">Updating your calendar…</p>}
        {error && <p role="alert" className="form-error">{error}</p>}
      </div>
      <div className="chat-prompts">
        {PROMPTS.map(p => <button key={p} className="chip" disabled={busy} onClick={() => void ask(p)}>{p}</button>)}
      </div>
      {image && (
        <div className="chat-attachment">
          <img src={image.url} alt="" />
          <span>{image.name}</span>
          <button type="button" className="icon-button ghost small" aria-label="Remove image" onClick={() => { URL.revokeObjectURL(image.url); setImage(null); }}><Icon name="close" size={14} /></button>
        </div>
      )}
      <form className="chat-input" onSubmit={submit}>
        <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(",")} hidden onChange={e => void attach(e)} />
        <button type="button" className="icon-button ghost" disabled={busy} aria-label="Attach an image, such as a timetable" title="Attach an image (JPG, PNG or WebP, up to 5 MB)" onClick={() => fileInput.current?.click()}><Icon name="image" size={17} /></button>
        <textarea value={input} maxLength={8000} rows={Math.min(6, Math.max(1, input.split("\n").length))} onChange={e => setInput(e.target.value)} onKeyDown={onKey}
          placeholder={planDrafts ? "Answer the question, or add more…" : "Ask, plan my week, or list tasks (one per line)…"} aria-label="Message the assistant" disabled={busy} />
        <button className="icon-button" disabled={(!input.trim() && !image) || busy} aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
      <p className="chat-foot">
        {usingOpenAI
          ? "OpenAI answers from your account data. Schedules come from AutoPlan’s engine and stay previews until you Apply them."
          : "Local helper until OPENAI_API_KEY is set. Schedules stay previews until you Apply them."}
      </p>
    </aside>
  );
}
