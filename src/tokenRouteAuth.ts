/**
 * Passcode guard for the curl-friendly broker token routes.
 *
 * These routes hand out a LIVE BROKER ACCESS TOKEN — a bearer credential that can place
 * and cancel orders — to any caller holding a shared secret. That makes the guard itself
 * security-critical, so it lives here as one small pure function with tests rather than
 * being retyped per route.
 *
 * THE PROPERTY THAT MATTERS MOST
 * An unset secret DISABLES the route. It must never be read as "no passcode required":
 * a forgotten environment variable would otherwise publish a trading credential to the
 * entire internet, and it would look like a working deployment. Failing closed is the
 * whole point of returning a distinct `not_configured` rather than a boolean.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export type PasscodeCheck = "not_configured" | "forbidden" | "ok";

/**
 * @param configured the secret from the environment (may be empty/unset)
 * @param provided   the passcode the caller supplied (header or query)
 */
export function checkTokenPasscode(
  configured: string | undefined,
  provided: string | undefined,
): PasscodeCheck {
  const secret = (configured ?? "").trim();
  // Fail CLOSED, never open. See the note above.
  if (secret === "") return "not_configured";
  if (typeof provided !== "string" || provided === "") return "forbidden";

  // Hashed to a fixed width before comparing: `timingSafeEqual` throws on a length
  // mismatch, and a secret's length is not something worth leaking either. The routes
  // are also rate limited, so this is defence in depth rather than the only barrier.
  const expected = createHash("sha256").update(secret, "utf8").digest();
  const actual = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expected, actual) ? "ok" : "forbidden";
}

/** The passcode a request carries, from either the header or the query string. */
export function readPasscode(
  headerValue: string | string[] | undefined,
  queryValue: unknown,
): string | undefined {
  if (typeof headerValue === "string") return headerValue;
  // A repeated header yields an array; take the first rather than stringifying the lot.
  if (Array.isArray(headerValue)) return headerValue[0];
  if (typeof queryValue === "string") return queryValue;
  return undefined;
}
