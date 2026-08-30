import assert from "node:assert/strict";
import {
  hudEffectIdForItem,
  itemIdFromHudEffectId,
  isFastNriHudEffectId
} from "../module/token-hud.mjs";

assert.equal(
  hudEffectIdForItem("abc123"),
  "fast-nri-effect:abc123"
);

assert.equal(
  hudEffectIdForItem({ id: "item42" }),
  "fast-nri-effect:item42"
);

assert.equal(
  itemIdFromHudEffectId("fast-nri-effect:item42"),
  "item42"
);

assert.equal(
  itemIdFromHudEffectId("prone"),
  null
);

assert.equal(
  isFastNriHudEffectId("fast-nri-effect:item42"),
  true
);

assert.equal(
  isFastNriHudEffectId("core-status"),
  false
);

console.log("token-hud-effects-regression: OK");
