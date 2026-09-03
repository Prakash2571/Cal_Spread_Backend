/**
 * Bounded, deterministic Dhan correlation IDs derived from Box client order IDs.
 *
 * THE PROBLEM
 * A Box client order id is the strategy's durable identity and is long:
 *
 *   BOX:6512f0a0a0a0a0a0a0a0a0a0:ENTRY:k1_ce:attempt-1     (48 characters)
 *
 * Dhan's `correlationId` is limited to 25 characters. Truncating the Box id would be
 * catastrophic: the trade id sits in the MIDDLE, so two different trades' k1_ce
 * legs share a prefix, and the first 25 characters of two distinct orders can be
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
 *   - BOUNDED — always within Dhan's limit.
 *   - INJECTIVE IN PRACTICE — a 64-bit FNV-1a over the full id, base36-encoded.
 *
 * BOTH IDS ARE PERSISTED ANYWAY (see `broker_correlation_id` on IBoxOrderIntent).
 * The hash is one-way, so the durable intent stores both and remains the mapping of
 * record; this function only has to be reproducible, not reversible.
 */

/** Dhan's hard limit on correlationId. */
export const DHAN_CORRELATION_MAX_LENGTH = 25;

/**
 * 64-bit FNV-1a, computed as two 32-bit halves.
 *
 * BigInt is avoided so this stays cheap on the order path. Two 32-bit lanes seeded
 * differently give a 64-bit digest with far better collision resistance than the
 * single 32-bit hash the Kite tag helper uses — appropriate here because a Kite tag
 * is only a label, whereas a Dhan correlation id is a RECONCILIATION KEY.
 */
function fnv1a64(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 ^= ch;
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= ch + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

/** Strip anything Dhan might reject, keeping the id conservative. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Build the Dhan correlation id for a Box client order id.
 *
 * Layout: `B` + 13-char hash + role code, e.g. `B1a2b3c4d5e6f7K1CE`.
 *
 * The role code is appended for readability in Dhan's own UI/reports, and because it
 * makes two legs of the same box visibly different even at a glance. It is derived
 * from the client id, never supplied separately, so it can never disagree with it.
 */
export function dhanCorrelationId(clientOrderId: string): string {
  const digest = sanitize(fnv1a64(clientOrderId));
  // A role suffix helps a human read Dhan's order book; it is cosmetic, and the hash
  // alone already distinguishes the orders.
  const roleMatch = /:(k1_ce|k2_ce|k2_pe|k1_pe):/.exec(clientOrderId);
  const roleCode = roleMatch ? roleMatch[1]!.replace("_", "").toUpperCase() : "";
  const head = `B${digest}`.slice(0, DHAN_CORRELATION_MAX_LENGTH - roleCode.length);
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
