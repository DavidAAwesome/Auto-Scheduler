import { useEffect, useSyncExternalStore } from "react";
import WorkspaceGate from "./components/WorkspaceGate";
import AppLayout from "./components/AppLayout";
import LoginPage from "./screens/LoginPage";
import { authSession, useAuth } from "./services/authSession";
import SignupPage from "./screens/SignupPage";
import Home from "./screens/Home";
import Analytics from "./screens/Analytics";
import Profile from "./screens/Profile";
import Settings from "./screens/Settings";
import "./App.css";
const screens = {
  home: Home,
  analytics: Analytics,
  profile: Profile,
  settings: Settings,
};
const titles: Record<string, string> = { home: "Calendar", analytics: "Analytics", profile: "Account", settings: "Settings" };
function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
function getRoute() {
  return window.location.hash.replace(/^#\/?/, "").replace(/\/$/, "") || "home";
}
export default function App() {
  const route = useSyncExternalStore(subscribe, getRoute);
  const session = useAuth();
  useEffect(() => { authSession.initialize(); }, []);
  const signedIn = session.status === "authenticated";
  const authRoute = route === "signup" ? "signup" : "login";
  const screen = Object.prototype.hasOwnProperty.call(screens, route) ? (route as keyof typeof screens) : "home";
  // Keep the URL meaningful: signed-in users leave auth pages, and unknown or retired routes
  // (#/planner, #/tasks, #/calendar, #/assistant: their features now live on Home) go home.
  useEffect(() => {
    if (signedIn && route !== screen) window.location.replace("#/home");
  }, [signedIn, route, screen]);
  useEffect(() => {
    document.title = `${signedIn ? titles[screen] : authRoute === "signup" ? "Sign up" : "Log in"} · AutoPlan`;
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [signedIn, screen, authRoute]);
  if (session.status === "loading") return <main className="login-page"><p role="status">Checking your session…</p></main>;
  if (session.status === "error") return (
    <main className="login-page">
      <section className="card session-error">
        <h1>Couldn’t open AutoPlan</h1>
        <p role="alert">{session.error}</p>
        <div className="task-dialog-footer">
          <button className="button secondary" onClick={() => void authSession.logout().catch(() => undefined)}>Sign out</button>
          <button className="button" onClick={() => void authSession.retry()}>Try again</button>
        </div>
      </section>
    </main>
  );
  if (!signedIn) return authRoute === "signup" ? <SignupPage /> : <LoginPage />;
  const Screen = screens[screen];
  return (
    <AppLayout key={screen} route={screen}>
      <WorkspaceGate><Screen /></WorkspaceGate>
    </AppLayout>
  );
}
