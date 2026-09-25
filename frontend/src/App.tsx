import { useEffect, useSyncExternalStore } from "react";
import AppLayout from "./components/AppLayout";
import LoginPage from "./screens/LoginPage";
import { demoSession } from "./services/demoSession";
import Home from "./screens/Home";
import Tasks from "./screens/Tasks";
import Assistant from "./screens/Assistant";
import Analytics from "./screens/Analytics";
import Calendar from "./screens/Calendar";
import Profile from "./screens/Profile";
import Settings from "./screens/Settings";
import "./App.css";
const screens = {
  login: LoginPage,
  home: Home,
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
  const signedIn = useSyncExternalStore(
    demoSession.subscribe,
    demoSession.getSnapshot,
  );
  const showLogin = !signedIn || route === "login";
  const isKnown = Object.prototype.hasOwnProperty.call(screens, route);
  useEffect(() => {
    document.title = `${showLogin ? "Login" : isKnown ? route.charAt(0).toUpperCase() + route.slice(1) : "Page not found"} · AutoPlan`;
    window.scrollTo(0, 0);
    document.getElementById("main-content")?.focus({ preventScroll: true });
  }, [route, isKnown, showLogin]);
  if (showLogin) return <LoginPage />;
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
      <Screen />
    </AppLayout>
  );
}
