import { useEffect } from "react";

/** Analytics lives on Home; keep this route as a friendly redirect. */
export default function Analytics() {
  useEffect(() => {
    window.location.hash = "#/home";
  }, []);
  return (
    <main className="login-page">
      <p role="status">Taking you to Home analytics…</p>
    </main>
  );
}
