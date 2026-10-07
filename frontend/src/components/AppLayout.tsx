import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { authSession, useAuth } from "../services/authSession";
import Icon, { type IconName } from "./Icon";

const mainLinks: IconName[] = ["home", "planner"];
const accountLinks: IconName[] = ["profile", "settings"];
const labelFor = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export default function AppLayout({
  route,
  children,
}: {
  route: string;
  children: ReactNode;
}) {
  const { user } = useAuth();
  const [logoutError, setLogoutError] = useState("");
  const initial = user?.name.charAt(0).toUpperCase() || "?";
  const avatar = (className: string, label?: string) =>
    user?.photoURL ? (
      <img className={`avatar avatar-image ${className}`} src={user.photoURL} alt={label || ""} />
    ) : (
      <span className={`avatar ${className}`} aria-hidden={label ? undefined : true}>
        {initial}
      </span>
    );
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  const accountMenu = useRef<HTMLDivElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const accountMenuId = useId();

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

  useEffect(() => {
    if (!accountOpen) return;
    function onPointer(event: MouseEvent) {
      const target = event.target as Node;
      if (
        accountMenu.current?.contains(target) ||
        accountButton.current?.contains(target)
      ) {
        return;
      }
      setAccountOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAccountOpen(false);
        accountButton.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen]);

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

  async function signOut() {
    try {
      await authSession.logout();
    } catch (error) {
      setLogoutError((error as Error).message);
    }
  }

  return (
    <div className={`app-shell ${route === "planner" ? "planner-shell" : ""}`}>
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
                void signOut();
              }}
              title="Sign out"
              aria-label="Sign out"
            >
              <Icon name="logout" />
              <span>Sign out</span>
            </a>
          </nav>
          <a className="sidebar-user" href="#/profile">
            {avatar("", `${user?.name || "User"} avatar`)}
            <span className="user-details">
              <strong>{user?.name}’s workspace</strong>
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
            <a className="header-brand" href="#/planner" aria-label="AutoPlan planner">
              AutoPlan
            </a>
            <span className="breadcrumb">
              Workspace <span>/</span> <strong>{labelFor(route)}</strong>
            </span>
          </div>
          <div className="header-right">
            <span className="demo-badge" title="Google Calendar connection status">
              <span /> Google Calendar · Not connected
            </span>
            <div className="account-menu">
              <button
                ref={accountButton}
                type="button"
                className="account-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={accountOpen}
                aria-controls={accountMenuId}
                onClick={() => setAccountOpen((value) => !value)}
              >
                {avatar("", undefined)}
                <span>{user?.name || "User"}</span>
                <Icon name="chevron" size={16} />
              </button>
              {accountOpen && (
                <div
                  ref={accountMenu}
                  id={accountMenuId}
                  className="account-menu-panel"
                  role="menu"
                  aria-label="Account menu"
                >
                  <div className="account-menu-heading">
                    {avatar("", `${user?.name || "User"} avatar`)}
                    <div>
                      <strong>{user?.name || "User"}</strong>
                      <small>{user?.email}</small>
                    </div>
                  </div>
                  <a role="menuitem" href="#/profile" onClick={() => setAccountOpen(false)}>
                    Account details
                  </a>
                  <a role="menuitem" href="#/home" onClick={() => setAccountOpen(false)}>
                    Analytics
                  </a>
                  <a role="menuitem" href="#/settings" onClick={() => setAccountOpen(false)}>
                    Settings
                  </a>
                  <button
                    type="button"
                    role="menuitem"
                    className="account-menu-button"
                    onClick={() => {
                      setAccountOpen(false);
                      void signOut();
                    }}
                  >
                    Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={route === "planner" ? "planner-main" : undefined}
        >
          {logoutError && (
            <p role="alert" className="form-error">
              {logoutError}
            </p>
          )}
          {children}
        </main>
        <footer>AutoPlan · A little more space for what matters.</footer>
      </div>
    </div>
  );
}
