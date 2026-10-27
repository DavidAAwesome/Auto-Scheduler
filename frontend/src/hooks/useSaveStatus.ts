import { useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/** Save button state shared by every settings section. */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState("");
  return {
    status,
    error,
    /** Call on every edit so a "Saved" confirmation never outlives the values it confirmed. */
    edited() {
      if (status !== "saving") { setStatus("idle"); setError(""); }
    },
    fail(message: string) { setStatus("error"); setError(message); },
    async run(save: () => Promise<unknown>) {
      setStatus("saving");
      setError("");
      try {
        await save();
        setStatus("saved");
      } catch (e) {
        setStatus("error");
        setError((e as Error).message || "Couldn’t save. Try again.");
      }
    },
  };
}
