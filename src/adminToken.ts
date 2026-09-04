/**
 * Admin session token generation.
 *
 * WHY THIS IS NOT `Math.random()`
 * The previous implementation was:
 *
 *     Math.random().toString(36).substring(2) + Date.now().toString(36)
 *
 * `Math.random()` is a non-cryptographic PRNG (V8 uses xorshift128+). It is seeded per
 * realm and its internal state is recoverable from a modest number of observed outputs,
 * so consecutive tokens are correlated rather than independent. The appended
 * `Date.now()` makes matters slightly worse, not better: it is *predictable*, so it adds
 * length without adding entropy. Total unpredictable material was roughly 52 bits at
 * best, and realistically far less against an attacker who has seen one token.
 *
 * An admin session token is a bearer credential for the FULL admin role — placing,
 * closing and deleting trades, and switching broker. It therefore needs a CSPRNG.
 *
 * 32 bytes = 256 bits from `randomBytes`, rendered `base64url` so the value is safe
 * unmodified in a URL, a header, JSON, and a Mongo `_id` — no escaping anywhere in the
 * existing call paths.
 *
 * DELIBERATELY NOT CHANGED
 * Only generation moved. Validation is an exact string lookup against the session table
 * (memory + Mongo), so tokens minted by the old code keep working until their normal
 * TTL expires — no forced logout, no persistence change, no header or endpoint change,
 * no change to the full/trade role split.
 *
 * Extracted into its own module purely so it can be unit-tested; `src/index.ts` boots a
 * server and cannot be imported from a test.
 */

import { randomBytes } from "node:crypto";

/**
 * A fresh, unguessable admin session token.
 *
 * Contract preserved from the previous implementation: returns a non-empty `string`
 * suitable for use as an opaque key. Callers must not parse it — there is no longer a
 * timestamp embedded in it, and there never should have been.
 */
export function generateAdminToken(): string {
  return randomBytes(32).toString("base64url");
}
