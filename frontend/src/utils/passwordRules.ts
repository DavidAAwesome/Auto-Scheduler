/** Sign-up password rules, checked as the user types. "Special" means anything that is not a letter, digit or space. */
export interface PasswordRule { id: string; label: string; test: (password: string) => boolean }

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters`, test: p => [...p].length >= PASSWORD_MIN_LENGTH },
  { id: "upper", label: "One uppercase letter (A–Z)", test: p => /\p{Lu}/u.test(p) },
  { id: "lower", label: "One lowercase letter (a–z)", test: p => /\p{Ll}/u.test(p) },
  { id: "number", label: "One number (0–9)", test: p => /\p{Nd}/u.test(p) },
  { id: "special", label: "One special character (!@#$%…)", test: p => /[^\p{L}\p{Nd}\s]/u.test(p) },
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
