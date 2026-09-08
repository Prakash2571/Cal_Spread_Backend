/**
 * Is a shared secret ACTUALLY configured, from the running process's point of view?
 *
 * WHY THIS EXISTS
 * `ADMIN_SECRET` gates the full admin role — placing, closing and deleting trades, and
 * switching broker. When it is unset, `/api/admin/verify` correctly fails CLOSED with
 * "Admin secret not configured on server" (see `tokenRouteAuth.ts` for why an unset
 * secret must never read as "no secret required").
 *
 * The trouble is that the operator sees that message in the browser AFTER having edited
 * `.env`, with nothing anywhere telling them whether the server ever saw the value. The
 * process reads `process.env.ADMIN_SECRET` ONCE at module load, and the usual causes are
 * all invisible from the UI:
 *
 *   • the process was never restarted, so it is still running the old environment;
 *   • the variable was written under a different name (`ADMIN_SECRET_KEY` is the
 *     natural typo, because the example value is literally `your_secret_key_here`);
 *   • `.env` is not in the process's working directory — `dotenv` resolves it against
 *     `process.cwd()`, not against the script;
 *   • the name was already present but EMPTY in the process environment. dotenv
 *     documents that it will never modify a variable that is already set, so an empty
 *     `ADMIN_SECRET` exported by a process manager silently beats the `.env` file, and
 *     keeps beating it across every plain restart;
 *   • the value is still the `.env.example` placeholder, which produces a confusing
 *     "Invalid admin secret" rather than "not configured".
 *
 * There was already a boot warning for `KITE_API_KEY` and a status line for Redis. The
 * credential that guards trade execution had neither. This module is the missing half:
 * a pure classifier, so the boot log and the status endpoint agree and both are testable
 * without a server.
 */

/**
 * The placeholder values shipped in `.env.example`.
 *
 * Detected so a half-finished copy is reported as such. They are NOT rejected — that
 * would change authentication behaviour, and a deployment is entitled to use any string
 * it likes as a secret. This only makes the boot log honest about what it is looking at.
 */
const PLACEHOLDERS: readonly string[] = [
  "your_secret_key_here",
  "your_trade_access_password_here",
  "your_api_key_here",
  "your_api_secret_here",
  "changeme",
  "change_me",
  "secret",
];

export type SecretConfigState =
  /** Absent, empty, or whitespace only — the route fails closed. */
  | "missing"
  /** Present, but still an `.env.example` placeholder. */
  | "placeholder"
  | "configured";

/**
 * Classify a raw environment value.
 *
 * Trims before deciding, matching `checkTokenPasscode` exactly — a value of `" "` is
 * "missing" to the guard, so it must be "missing" here too or the diagnostic would
 * contradict the behaviour it is meant to explain.
 */
export function classifySecret(raw: string | undefined): SecretConfigState {
  const value = (raw ?? "").trim();
  if (value === "") return "missing";
  if (PLACEHOLDERS.includes(value.toLowerCase())) return "placeholder";
  return "configured";
}

/** True only when the secret would let a correct passcode through. */
export function isSecretUsable(raw: string | undefined): boolean {
  return classifySecret(raw) !== "missing";
}

export interface SecretConfigReport {
  readonly name: string;
  readonly state: SecretConfigState;
  /** One operator-facing line. NEVER contains the secret itself. */
  readonly message: string;
  readonly level: "info" | "warn";
}

/**
 * Describe one secret for the boot log.
 *
 * The message names the variable, the file, and the fact that a restart is required,
 * because "I edited .env and nothing changed" is the actual failure being diagnosed.
 * It never includes the value, or its length — only whether it is there.
 */
export function describeSecret(
  name: string,
  raw: string | undefined,
  purpose: string,
): SecretConfigReport {
  const state = classifySecret(raw);
  if (state === "configured") {
    return { name, state, level: "info", message: `${name} is configured (${purpose}).` };
  }
  if (state === "placeholder") {
    return {
      name,
      state,
      level: "warn",
      message:
        `${name} is still the .env.example PLACEHOLDER (${purpose}). ` +
        `Logging in will fail with "Invalid ${name === "ADMIN_SECRET" ? "admin secret" : "secret"}" ` +
        `until it is replaced with a real value in .env, followed by a restart.`,
    };
  }
  return {
    name,
    state,
    level: "warn",
    message:
      `${name} is NOT SET, so ${purpose} is DISABLED and the login will report ` +
      `"not configured on server". Checklist: (1) the line reads exactly "${name}=..." ` +
      `— not "${name}_KEY=..."; (2) it is in .env in the directory the process runs from, ` +
      `not .env.example; (3) the process was restarted AFTER the edit — and if a process ` +
      `manager already exports an empty ${name}, dotenv will not override it, so the ` +
      `environment must be refreshed (for PM2: "pm2 restart <app> --update-env").`,
  };
}
