import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { authSession, useAuth } from "../services/authSession";
import { themeStore, useCalendarView, useTheme } from "../services/uiState";
import { useWorkspace } from "../hooks/useWorkspace";
import { useDismiss } from "../hooks/useDismiss";
import { clock12, rangeTitle } from "../utils/calendar";
import { addDays, formatDate } from "../utils/dates";
import Icon, { type IconName } from "./Icon";
import DeleteAccountDialog from "./DeleteAccountDialog";
import { categoryIcon } from "../utils/taskDisplay";
import { eventIcon, occurrencesOn } from "../utils/events";
import { initials } from "../services/avatarUpload";
import { accountToday } from "../utils/timeZones";

const pageTitles: Record<string, string> = {
  calendars: "Connected calendars",
  settings: "Availability & settings",
  profile: "Account details",
  analytics: "Analytics",
};

/** Shared by the header and the profile, so a saved avatar shows everywhere at once. */
export function Avatar({ size = 32 }: { size?: number }) {
  const { user } = useAuth();
  // Remember which URL failed, so uploading a new avatar shows it again.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  if (user?.photoURL && user.photoURL !== brokenUrl)
    return <img className="avatar" src={user.photoURL} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBrokenUrl(user.photoURL)} />;
  return <span className="avatar" style={{ width: size, height: size }} aria-hidden="true">{initials(user?.name)}</span>;
}

function MenuDrawer({ open, onClose, route }: { open: boolean; onClose: () => void; route: string }) {
  const panel = useRef<HTMLElement>(null);
  const { connections } = useWorkspace();
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("a, button")?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  const connected = new Set(connections.map(c => c.provider));
  const link = (href: string, icon: IconName, label: string, active: boolean) => (
    <a className={`drawer-link ${active ? "active" : ""}`} href={href} aria-current={active ? "page" : undefined} onClick={onClose}>
      <Icon name={icon} size={19} /> {label}
    </a>
  );
  return (
    <>
      <button className="drawer-backdrop" aria-label="Close menu" onClick={onClose} />
      <nav ref={panel} className="drawer" aria-label="Main menu">
        <div className="drawer-head">
          <span className="brand"><span className="brand-mark">✦</span> AutoPlan</span>
          <button className="icon-button ghost" aria-label="Close menu" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
        {link("#/home", "home", "Home", route === "home")}
        <p className="drawer-caption">CONNECTED CALENDARS</p>
        {([["google", "Google Calendar"], ["outlook", "Outlook Calendar"]] as const).map(([provider, name]) => (
          <a key={provider} className={`drawer-link ${route === "calendars" ? "active" : ""}`} href="#/calendars" onClick={onClose}>
            <span className={`calendar-dot ${provider}`} /> {name}
            <span className={`soon-badge ${connected.has(provider) ? "on" : ""}`}>{connected.has(provider) ? "Connected" : "Connect"}</span>
          </a>
        ))}
        <p className="drawer-caption">PLANNING</p>
        {link("#/settings", "clock", "Availability", route === "settings")}
        {link("#/analytics", "analytics", "Analytics", route === "analytics")}
      </nav>
    </>
  );
}

function Reminders() {
  const { tasks, events, availability } = useWorkspace();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(panel, open, close, button);
  const today = accountToday(availability);
  const tomorrow = addDays(today, 1);
  const overdue = tasks.filter(t => !t.done && t.deadline < today);
  const dueToday = tasks.filter(t => !t.done && t.deadline === today);
  const dueTomorrow = tasks.filter(t => !t.done && t.deadline === tomorrow);
  const eventsToday = occurrencesOn(events, today).map(o => o.event);
  const count = overdue.length + dueToday.length + eventsToday.length;
  const group = (label: string, list: typeof tasks, tone = "") => list.length > 0 && (
    <section>
      <h3 className={tone}>{label}</h3>
      <ul>{list.map(t => <li key={t.id}><Icon name={categoryIcon[t.category]} size={16} /><span>{t.title}</span><small>{t.minutes} min</small></li>)}</ul>
    </section>
  );
  return (
    <div className="popover-anchor">
      <button ref={button} className="icon-button ghost" aria-label={`Reminders${count ? `, ${count} due` : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="bell" size={20} />
        {count > 0 && <span className="badge">{count}</span>}
      </button>
      {open && (
        <div ref={panel} className="popover reminders" role="dialog" aria-label="Reminders">
          <h2>Reminders</h2>
          {eventsToday.length > 0 && (
            <section>
              <h3>Events today</h3>
              <ul>{eventsToday.map(e => <li key={e.id}><Icon name={eventIcon[e.kind]} size={16} /><span>{e.title}</span><small>{clock12(e.start)}</small></li>)}</ul>
            </section>
          )}
          {group("Overdue", overdue, "danger")}
          {group("Due today", dueToday)}
          {group(`Due tomorrow · ${formatDate(tomorrow)}`, dueTomorrow)}
          {!eventsToday.length && !overdue.length && !dueToday.length && !dueTomorrow.length && <p className="muted">Nothing today or due tomorrow. 🎉</p>}
          <p className="popover-foot">Push reminders arrive in Sprint 3.</p>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user } = useAuth();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(panel, open, close, button);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus(); }, [open]);
  const item = (icon: IconName, label: string, action: () => void, extra = "") => (
    <button role="menuitem" className={`menu-item ${extra}`} onClick={() => { action(); if (icon !== "sun" && icon !== "moon") setOpen(false); }}>
      <Icon name={icon} size={18} /> {label}
    </button>
  );
  const go = (hash: string) => () => { window.location.hash = hash; };
  return (
    <div className="popover-anchor">
      <button ref={button} className="user-button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar />
        <span className="user-name">{user?.name}</span>
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div ref={panel} className="popover user-menu" role="menu" aria-label="Account">
          <div className="user-menu-head">
            <Avatar size={40} />
            <div><strong>{user?.name}</strong><small>{user?.email}</small></div>
          </div>
          {item("profile", "Account details", go("/profile"))}
          {item("analytics", "Analytics", go("/analytics"))}
          {item(theme === "dark" ? "sun" : "moon", theme === "dark" ? "Light theme" : "Dark theme", () => themeStore.set(theme === "dark" ? "light" : "dark"))}
          {item("settings", "Settings", go("/settings"))}
          <hr />
          {item("logout", "Log out", () => void authSession.logout())}
          {item("trash", "Delete account", () => setConfirmDelete(true), "danger")}
        </div>
      )}
      {confirmDelete && <DeleteAccountDialog onClose={() => setConfirmDelete(false)} />}
    </div>
  );
}

export default function AppLayout({ route, children }: { route: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const view = useCalendarView();
  const closeMenu = useCallback(() => { setMenuOpen(false); menuButton.current?.focus(); }, []);
  const title = route === "home" ? rangeTitle(view.mode, view.anchor) : pageTitles[route] ?? "";
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={e => { e.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</a>
      <header className="topbar">
        <div className="topbar-left">
          <button ref={menuButton} className="icon-button ghost" aria-label="Open menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <Icon name="menu" />
          </button>
          <a className="brand" href="#/home"><span className="brand-mark">✦</span> AutoPlan</a>
        </div>
        <h1 className="topbar-title">{title}</h1>
        <div className="topbar-right">
          <Reminders />
          <UserMenu />
        </div>
      </header>
      <MenuDrawer open={menuOpen} onClose={closeMenu} route={route} />
      <main id="main-content" tabIndex={-1} className={route === "home" ? "main-home" : "main-page"} inert={menuOpen ? true : undefined}>
        {route === "home" ? children : (
          <div className="page">
            <a className="back-link" href="#/home"><Icon name="chevronLeft" size={16} /> Back to calendar</a>
            {children}
          </div>
        )}
      </main>
    </div>
  );
}
