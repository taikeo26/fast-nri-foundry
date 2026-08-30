import assert from "node:assert/strict";
import { effectPanelData } from "../module/effect-panel.mjs";

const effect = {
  id: "effect-1",
  name: "Испуган",
  img: "icons/magic/control/fear-fright-white.webp",
  system: {
    effectKind: "debuff",
    duration: {
      mode: "rounds",
      rounds: 3,
      expiry: "turnStart"
    },
    stacking: {
      mode: "shared"
    },
    runtime: {
      stackCount: 2,
      timers: [
        {
          id: "timer",
          durationMode: "rounds",
          combatId: "combat-1",
          combatantId: "combatant-1",
          appliedRound: 2,
          appliedTurn: 0,
          expiresRound: 5,
          phase: "turnStart",
          untracked: false
        }
      ]
    }
  }
};

const data = effectPanelData(effect, {
  combatId: "combat-1",
  round: 3
});

assert.equal(data.id, "effect-1");
assert.equal(data.name, "Испуган");
assert.equal(data.kind, "Дебафф");
assert.equal(data.stackCount, 2);
assert.match(data.stacking, /общий таймер/i);
assert.match(data.durationDefinition, /3/);
assert.match(data.durationRemaining, /2/);

console.log("effect-panel-regression: OK");
