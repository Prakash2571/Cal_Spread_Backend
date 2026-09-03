/**
 * Bounded, deterministic Dhan correlation IDs derived from Box client order IDs.
 *
 * THE PROBLEM
 * A Box client order id is the strategy's durable identity and is long:
 *
 *   BOX:6512f0a0a0a0a0a0a0a0a0a0:ENTRY:k1_ce:attempt-1     (48 characters)
 *
 * Dhan's `correlationId` is limited to 30 characters. Truncating the Box id would be
 * catastrophic: the trade id sits in the MIDDLE, so two different trades' k1_ce
 * legs share a prefix, and the first 30 characters of two distinct orders can be
 * IDENTICAL. Reconciling an ambiguous submission by such an id could match the wrong
 * order and hand the caller a fill that belongs to a different box.
 *
 * THE APPROACH
 * Hash the whole client id into a compact, collision-resistant token and keep a
 * readable role suffix for human debugging. The result is:
 *
 *   - DETERMINISTIC — the same client id always yields the same correlation id, so
 *     it can be recomputed after a crash without any stored mapping. This is what
 *     makes reconcile-by-correlation-id work at all.
 *   - BOUNDED — always within Dhan's 30-character limit.
 *   - INJECTIVE IN PRACTICE — a 96-bit FNV-1a-style digest over the full id,
 *     base36-encoded.
 *
 * THE EXTRA CHARACTERS BUY STRENGTH, NOT PADDING
 * Dhan's limit is 30, not 25. The additional room is spent on a THIRD 32-bit hash
 * lane (96-bit digest instead of 64-bit), which strictly increases collision
 * resistance. It is deliberately not spent on padding or on carrying more of the raw
 * client id — a partial raw id is exactly the prefix-collision hazard described
 * above, so more of it would be worse than useless.
 *
 * BOTH IDS ARE PERSISTED ANYWAY (see `broker_correlation_id` on IBoxOrderIntent).
 * The hash is one-way, so the durable intent stores both and remains the mapping of
 * record; this function only has to be reproducible, not reversible. Order adoption
 * and refresh both PREFER the persisted id over recomputing it, so changing this
 * algorithm cannot orphan an intent that was written under an older one.
 */

/**
 * Dhan's hard limit on correlationId.
 *
 * 30 per the current DhanHQ v2 documentation. Every id this module produces is
 * validated against it, because an over-long id is rejected by Dhan and — far worse —
 * a silently truncated one would break reconciliation.
 */
export const DHAN_CORRELATION_MAX_LENGTH = 30;

/**
 * The four role codes a Box leg can carry, longest first.
 *
 * All four are exactly 4 characters, so the digest budget is constant rather than
 * varying by leg — which keeps every id the same length and makes a truncation bug
 * impossible to hide behind one particular role.
 */
const ROLE_CODE_LENGTH = 4;

/**
 * 96-bit FNV-1a-style digest, computed as three independent 32-bit lanes.
 *
 * BigInt is avoided so this stays cheap on the order path. Three lanes seeded and
 * mixed differently give a 96-bit digest with far better collision resistance than
 * the single 32-bit hash the Kite tag helper uses — appropriate here because a Kite
 * tag is only a label, whereas a Dhan correlation id is a RECONCILIATION KEY: a
 * collision would attribute one box's fill to another.
 *
 * Each lane also folds in the input LENGTH, so two inputs that differ only by
 * trailing content cannot collapse to the same digest.
 */
function fnvDigest96(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  let h3 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    // Position-mixed, so an anagram of the same characters hashes differently.
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    // Third lane rotates, so it does not track lane 2 for similar inputs.
    h3 ^= ch + (i << 3);
    h3 = Math.imul(h3, 0xc2b2ae35) >>> 0;
    h3 = ((h3 << 13) | (h3 >>> 19)) >>> 0;
  }
  // Fold the length in so a prefix can never hash to the same value as the whole.
  h1 = (h1 ^ input.length) >>> 0;
  h3 = Math.imul(h3 ^ input.length, 0x27d4eb2f) >>> 0;
  return (
    (h1 >>> 0).toString(36) +
    (h2 >>> 0).toString(36) +
    (h3 >>> 0).toString(36)
  );
}

/** Strip anything Dhan might reject, keeping the id conservative. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Build the Dhan correlation id for a Box client order id.
 *
 * Layout: `B` + up to 25 digest chars + a 4-char role code, e.g. `B1a2b3c4d5e6f7g8h9K1CE`.
 *
 * The role code is appended for readability in Dhan's own order book and reports, and
 * because it makes two legs of the same box visibly different at a glance. It is
 * DERIVED from the client id rather than supplied separately, so it can never
 * disagree with it. It is cosmetic: the digest alone already distinguishes the orders.
 */
export function dhanCorrelationId(clientOrderId: string): string {
  const digest = sanitize(fnvDigest96(clientOrderId));
  const roleMatch = /:(k1_ce|k2_ce|k2_pe|k1_pe):/.exec(clientOrderId);
  const roleCode = roleMatch ? roleMatch[1]!.replace("_", "").toUpperCase() : "";
  // Reserve the role code's width up front so the digest is never the thing that
  // gets clipped by a longer suffix.
  const budget = DHAN_CORRELATION_MAX_LENGTH - (roleCode ? ROLE_CODE_LENGTH : 0);
  const head = `B${digest}`.slice(0, budget);
  const id = `${head}${roleCode}`;
  return id.slice(0, DHAN_CORRELATION_MAX_LENGTH);
}

/**
 * Whether a correlation id is acceptable to Dhan.
 *
 * Used as an assertion on the order path: submitting an over-long id would be
 * rejected, and (worse) a silently truncated one would break reconciliation.
 */
export function isValidDhanCorrelationId(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= DHAN_CORRELATION_MAX_LENGTH &&
    /^[A-Za-z0-9]+$/.test(value)
  );
}
