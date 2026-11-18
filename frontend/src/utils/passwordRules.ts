/**
 * Sign-up password rules, checked as the user types. They match the Firebase password policy (Authentication →
 * Settings → Password policy), which enforces the same rules on the server: ASCII letters and digits, and only the
 * special characters Firebase counts.
 */
export interface PasswordRule { id: string; label: string; test: (password: string) => boolean }

export const PASSWORD_MIN_LENGTH = 8;
/** The special characters Firebase's password policy accepts. */
export const SPECIAL_CHARACTERS = "^$*.[]{}()?\"!@#%&/\\,><':;|_~`";
const hasSpecial = (password: string) => [...password].some(char => SPECIAL_CHARACTERS.includes(char));

export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: p => p.length >= PASSWORD_MIN_LENGTH },
  { id: "upper", label: "One uppercase letter (A–Z)", test: p => /[A-Z]/.test(p) },
  { id: "lower", label: "One lowercase letter (a–z)", test: p => /[a-z]/.test(p) },
  { id: "number", label: "One number (0–9)", test: p => /[0-9]/.test(p) },
  { id: "special", label: "One special character (!@#$%…)", test: hasSpecial },
];

/** The rules this password does not meet yet (empty when it is strong enough). */
export function unmetPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter(rule => !rule.test(password));
}

/** One sentence naming what is missing, for the form error. */
export function passwordProblem(password: string): string | null {
  const unmet = unmetPasswordRules(password);
  if (!unmet.length) return null;
  return `Password needs: ${unmet.map(rule => rule.label.replace(/ \(.*\)$/, "").toLowerCase()).join(", ")}.`;
}
