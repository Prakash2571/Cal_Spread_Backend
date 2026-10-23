/**
 * The boot-time secret configuration diagnostic.
 *
 * The property that matters: this classifier must agree EXACTLY with
 * `checkTokenPasscode`, which is what actually gates the login. A diagnostic that
 * disagreed with the guard it explains would be worse than none — it would say
 * "configured" while the login kept failing closed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  classifySecret,
  isSecretUsable,
  describeSecret,
} from "../../dist/secretConfigStatus.js";
import { checkTokenPasscode } from "../../dist/tokenRouteAuth.js";

test("an absent, empty or whitespace-only secret is MISSING", () => {
  for (const raw of [undefined, "", "   ", "\t", "\n"]) {
    assert.equal(classifySecret(raw), "missing", `${JSON.stringify(raw)} must be missing`);
    assert.equal(isSecretUsable(raw), false);
  }
});

test("a real secret is CONFIGURED", () => {
  for (const raw of ["hunter2", "  padded-but-real  ", "a"]) {
    assert.equal(classifySecret(raw), "configured");
    assert.equal(isSecretUsable(raw), true);
  }
});

test("the .env.example placeholders are recognised, but still usable as secrets", () => {
  assert.equal(classifySecret("your_secret_key_here"), "placeholder");
  assert.equal(classifySecret("YOUR_SECRET_KEY_HERE"), "placeholder");
  // Recognised, NOT rejected: a deployment may use any string it likes, and changing
  // authentication behaviour is not this module's job.
  assert.equal(isSecretUsable("your_secret_key_here"), true);
});

test("classification agrees with checkTokenPasscode — the guard that actually decides", () => {
  // This is the invariant. `not_configured` from the guard must correspond exactly to
  // `missing` here, for every shape of input, or the diagnostic lies.
  for (const raw of [undefined, "", "   ", "\t\n", "real-secret", "  padded  ", "your_secret_key_here"]) {
    const guard = checkTokenPasscode(raw, "anything");
    const usable = isSecretUsable(raw);
    assert.equal(
      guard === "not_configured",
      !usable,
      `disagreement for ${JSON.stringify(raw)}: guard=${guard} usable=${usable}`,
    );
  }
});

test("the report names the variable, the fix, and the restart — and never the value", () => {
  const secret = "super-sensitive-value";
  const ok = describeSecret("ADMIN_SECRET", secret, "full admin access");
  assert.equal(ok.state, "configured");
  assert.equal(ok.level, "info");
  assert.doesNotMatch(ok.message, /super-sensitive-value/, "the value must never be logged");

  const missing = describeSecret("ADMIN_SECRET", undefined, "full admin access");
  assert.equal(missing.state, "missing");
  assert.equal(missing.level, "warn");
  // The three causes an operator cannot see from the browser.
  assert.match(missing.message, /ADMIN_SECRET_KEY/, "warns about the natural typo");
  assert.match(missing.message, /\.env\.example/, "distinguishes .env from .env.example");
  assert.match(missing.message, /restart/i, "says a restart is required");
  assert.match(missing.message, /update-env/, "covers the process-manager env case");

  const placeholder = describeSecret("ADMIN_SECRET", "your_secret_key_here", "full admin access");
  assert.equal(placeholder.state, "placeholder");
  assert.equal(placeholder.level, "warn");
  // A placeholder produces "Invalid admin secret", not "not configured" — saying so is
  // the whole point, because those two errors send you looking in different places.
  assert.match(placeholder.message, /Invalid admin secret/);
});

test("no report ever leaks the secret or its length", () => {
  for (const raw of ["abc", "a-much-longer-secret-value-here", "your_secret_key_here"]) {
    for (const name of ["ADMIN_SECRET", "ACCESS_SECRET"]) {
      const report = describeSecret(name, raw, "test");
      assert.doesNotMatch(report.message, new RegExp(raw.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")));
      assert.doesNotMatch(report.message, new RegExp(`\\b${raw.length}\\b`), "no length either");
    }
  }
});
