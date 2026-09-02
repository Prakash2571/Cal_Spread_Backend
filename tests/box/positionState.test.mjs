import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveBoxPositionState,
  isBoxPositionFlat,
} from "../../dist/box/positions.js";

const exact = (value = 0) => ({
  k1_ce: value,
  k2_ce: value,
  k2_pe: value,
  k1_pe: value,
});

test("flat means all four canonical roles are present and exactly zero", () => {
  assert.equal(isBoxPositionFlat(exact(0)), true);
  assert.equal(isBoxPositionFlat({ ...exact(0), k2_pe: 1 }), false);
  assert.equal(isBoxPositionFlat({ ...exact(0), k2_pe: -1 }), false);
  assert.equal(isBoxPositionFlat({ k1_ce: 0, k2_ce: 0, k2_pe: 0 }), false, "a missing role is not flat");
});

test("RECOVERY remains sticky while non-flat and exact zero alone derives FLAT", () => {
  assert.equal(deriveBoxPositionState({ ...exact(0), k1_ce: 1 }, "RECOVERY"), "RECOVERY");
  assert.equal(deriveBoxPositionState({ ...exact(0), k1_ce: -1 }, "RECOVERY"), "RECOVERY");
  assert.equal(deriveBoxPositionState({ k1_ce: 0, k2_ce: 0, k2_pe: 0 }, "RECOVERY"), "RECOVERY");
  assert.equal(deriveBoxPositionState(exact(0), "RECOVERY"), "FLAT");
  assert.equal(deriveBoxPositionState(exact(75)), "BOX");
  assert.equal(deriveBoxPositionState({ ...exact(75), k2_ce: 35 }), "PARTIALLY_EXITED");
});
