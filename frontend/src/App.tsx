import { useEffect, useSyncExternalStore } from "react";
import WorkspaceGate from "./components/WorkspaceGate";
import AppLayout from "./components/AppLayout";
import LoginPage from "./screens/LoginPage";
import { authSession, useAuth } from "./services/authSession";
import SignupPage from "./screens/SignupPage";
import Home from "./screens/Home";
import Planner from "./screens/Planner";
import Tasks from "./screens/Tasks";
import Assistant from "./screens/Assistant";
import Analytics from "./screens/Analytics";
import Calendar from "./screens/Calendar";
import Profile from "./screens/Profile";
import Settings from "./screens/Settings";
import "./App.css";
const screens = {
  login: LoginPage,
  signup: SignupPage,
  home: Home,
  planner: Planner,
  tasks: Tasks,
  assistant: Assistant,
  analytics: Analytics,
  calendar: Calendar,
  profile: Profile,
  settings: Settings,
};
function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}
function getRoute() {
  return (
    window.location.hash.replace(/^#\/?/, "").replace(/\/$/, "") || "login"
  );
}
export default function App() {
  const route = useSyncExternalStore(subscribe, getRoute);
  const session = useAuth();
  useEffect(() => { void authSession.initialize(); }, []);
  const authRoute = route === "signup" ? "signup" : "login";
  const showLogin = session.status !== "authenticated" || route === "login" || route === "signup";
  const isKnown = Object.prototype.hasOwnProperty.call(screens, route);
  useEffect(() => {
    document.title = `${showLogin ? (authRoute === "signup" ? "Sign up" : "Login") : isKnown ? route.charAt(0).toUpperCase() + route.slice(1) : "Page not found"} · AutoPlan`;
    window.scrollTo(0, 0);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [route, isKnown, showLogin, authRoute]);
  if (session.status === "loading") return <main className="login-page"><p role="status">Checking your session…</p></main>;
  if (session.status === "error") return <main className="login-page"><section className="card"><h1>Couldn’t restore your session</h1><p role="alert">{session.error}</p><button className="button" onClick={() => void authSession.retry()}>Try again</button></section></main>;
  if (showLogin) return authRoute === "signup" ? <SignupPage /> : <LoginPage />;
  if (!isKnown)
    return (
      <main className="login-page">
        <section className="card not-found">
          <h1>That page wandered off.</h1>
          <p className="muted">Let’s get you back to your workspace.</p>
          <a className="button" href="#/home">
            Back to Home
          </a>
        </section>
      </main>
    );
  const Screen = screens[route as keyof typeof screens];
  return (
    <AppLayout key={route} route={route}>
      <WorkspaceGate><Screen /></WorkspaceGate>
    </AppLayout>
  );
}
