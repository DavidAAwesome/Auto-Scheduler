import { useAuth } from "../services/authSession";
import { chatPanelStore, useChatPanelOpen } from "../services/uiState";
import Icon from "./Icon";

const examples = [
  "I have a computer vision assignment due Friday, about 6 hours.",
  "What do I need to do today?",
  "I have an appointment at 2 PM, replan my day.",
];

/** Layout placeholder for the AI assistant (natural-language entry is Sprint 3). */
export default function ChatPanel() {
  const open = useChatPanelOpen();
  const { user } = useAuth();
  if (!open)
    return (
      <button className="chat-tab" onClick={() => chatPanelStore.set(true)} aria-label="Open AI chatbox">
        <Icon name="assistant" size={18} /> <span>AI</span>
      </button>
    );
  return (
    <aside className="chat-panel" aria-label="AI chatbox">
      <div className="chat-head">
        <h2><Icon name="assistant" size={18} /> AI Chatbox</h2>
        <button className="icon-button ghost small" aria-label="Hide AI chatbox" onClick={() => chatPanelStore.set(false)}><Icon name="panel" size={17} /></button>
      </div>
      <div className="chat-messages">
        <p className="bubble assistant">Hi{user?.name ? ` ${user.name.split(" ")[0]}` : ""}! I’m your AutoPlan assistant. Soon you’ll be able to describe tasks in plain English and I’ll fill in the details for you to confirm.</p>
        <p className="bubble assistant">You’ll be able to say things like:</p>
        {examples.map(text => <p key={text} className="bubble example">“{text}”</p>)}
      </div>
      <form className="chat-input" onSubmit={e => e.preventDefault()}>
        <input disabled placeholder="Coming in Sprint 3" aria-label="Message the assistant" />
        <button className="icon-button" disabled aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
    </aside>
  );
}
