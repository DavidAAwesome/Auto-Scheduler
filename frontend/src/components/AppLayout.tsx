import { useEffect, useRef, useState, type ReactNode } from "react";
import { demoSession } from "../services/demoSession";
import Icon, { type IconName } from "./Icon";
const mainLinks: IconName[] = [
  "home",
  "tasks",
  "assistant",
  "analytics",
  "calendar",
];
const accountLinks: IconName[] = ["profile", "settings"];
const labelFor = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);
export default function AppLayout({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    const trigger = menuButton.current;
    document.body.style.overflow = "hidden";
    const links = sidebar.current?.querySelectorAll<HTMLAnchorElement>("a");
    links?.[0]?.focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        menuButton.current?.focus();
      }
      if (event.key === "Tab" && links?.length) {
        const first = links[0],
          last = links[links.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    const breakpoint = window.matchMedia("(min-width: 641px)");
    const closeOnDesktop = () => {
      if (breakpoint.matches) setOpen(false);
    };
    breakpoint.addEventListener("change", closeOnDesktop);
    document.addEventListener("keydown", handleKey);
    return () => {
      requestAnimationFrame(() => {
        if (trigger?.isConnected) trigger.focus();
      });
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      breakpoint.removeEventListener("change", closeOnDesktop);
    };
  }, [open]);
  const navLink = (name: IconName) => (
    <a
      key={name}
      href={`#/${name}`}
      className={`nav-link ${route === name ? "active" : ""}`}
      aria-current={route === name ? "page" : undefined}
      aria-label={labelFor(name)}
      title={labelFor(name)}
      onClick={() => {
        setOpen(false);
        if (open) menuButton.current?.focus();
      }}
    >
      <Icon name={name} />
      <span>{labelFor(name)}</span>
    </a>
  );
  return (
    <div className="app-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
      >
        Skip to content
      </a>
      {open && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => {
            setOpen(false);
            menuButton.current?.focus();
          }}
        />
      )}
      <aside
        ref={sidebar}
        id="app-sidebar"
        className={`sidebar ${open ? "is-open" : ""}`}
        aria-label="Workspace navigation"
      >
        <a
          className="brand"
          href="#/home"
          aria-label="AutoPlan home"
          onClick={() => setOpen(false)}
        >
          <span className="brand-mark">✦</span>
          <span className="brand-name">autoplan</span>
        </a>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Main navigation">{mainLinks.map(navLink)}</nav>
        <div className="sidebar-bottom">
          <nav aria-label="Account navigation">
            {accountLinks.map(navLink)}
            <a
              className="nav-link"
              href="#/login"
              onClick={(event) => {
                event.preventDefault();
                demoSession.logout();
              }}
              title="Sign out"
              aria-label="Sign out"
            >
              <Icon name="logout" />
              <span>Sign out</span>
            </a>
          </nav>
          <a className="sidebar-user" href="#/profile">
            <span className="avatar">M</span>
            <span className="user-details">
              <strong>Mia's workspace</strong>
              <small>Personal account</small>
            </span>
          </a>
        </div>
      </aside>
      <div className="workspace" inert={open ? true : undefined}>
        <header className="header">
          <div className="header-left">
            <button
              ref={menuButton}
              className="icon-button menu-toggle"
              aria-label="Open navigation"
              aria-expanded={open}
              aria-controls="app-sidebar"
              onClick={() => setOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span className="breadcrumb">
              Workspace <span>/</span> <strong>{labelFor(route)}</strong>
            </span>
          </div>
          <div className="header-right">
            <span className="demo-badge">
              <span /> Demo workspace
            </span>
            <a className="avatar" href="#/profile" aria-label="Open profile">
              M
            </a>
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
        <footer>AutoPlan · A little more space for what matters.</footer>
      </div>
    </div>
  );
}
