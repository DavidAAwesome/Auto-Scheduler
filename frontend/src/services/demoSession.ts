/** UI-only demo access. This is not real authentication and makes no API calls. */
const SESSION_KEY = "autoplan.demo-session";
const listeners = new Set<() => void>();
let signedIn = false;
try {
  signedIn = sessionStorage.getItem(SESSION_KEY) === "active";
} catch {
  // A memory-only demo remains usable when browser storage is unavailable.
}
export const DEMO_LOGIN_ERROR = "Use the demo email and password shown above.";
export const demoSession = {
  getSnapshot: () => signedIn,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  login(email: string, password: string) {
    if (
      email.trim().toLowerCase() !== "demo@autoplan.app" ||
      password !== "autoplan"
    )
      return false;
    try {
      sessionStorage.setItem(SESSION_KEY, "active");
    } catch {
      /* Memory fallback. */
    }
    signedIn = true;
    listeners.forEach((listener) => listener());
    return true;
  },
  logout() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* Always clear memory. */
    }
    signedIn = false;
    listeners.forEach((listener) => listener());
    window.location.hash = "/login";
  },
};
