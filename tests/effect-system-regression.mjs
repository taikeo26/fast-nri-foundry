import assert from "node:assert/strict";
import {
  addStackState,
  buildEffectTimer,
  effectStackCount,
  removeOneStackState,
  timerExpiresAtEvent
} from "../module/effect-system.mjs";

const combat = {
  combatId: "combat-1",
  combatantId: "combatant-a",
  round: 3,
  turn: 2
};

// Manual: never auto expires.
const manual = buildEffectTimer({ mode: "manual" }, combat, "manual");
assert.equal(manual.phase, "manual");
assert.equal(
  timerExpiresAtEvent(manual, {
    combatId: "combat-1",
    combatantId: "combatant-a",
    round: 99,
    phase: "turnEnd"
  }),
  false
);

// End current turn.
const turnEnd = buildEffectTimer({ mode: "turnEnd" }, combat, "turn-end");
assert.equal(turnEnd.expiresRound, 3);
assert.equal(turnEnd.phase, "turnEnd");
assert.equal(
  timerExpiresAtEvent(turnEnd, {
    combatId: "combat-1",
    combatantId: "combatant-a",
    round: 3,
    phase: "turnEnd"
  }),
  true
);

// Beginning of next turn.
const nextStart = buildEffectTimer(
  { mode: "nextTurnStart" },
  combat,
  "next-start"
);
assert.equal(nextStart.expiresRound, 4);
assert.equal(nextStart.phase, "turnStart");
assert.equal(
  timerExpiresAtEvent(nextStart, {
    combatId: "combat-1",
    combatantId: "combatant-a",
    round: 3,
    phase: "turnStart"
  }),
  false
);
assert.equal(
  timerExpiresAtEvent(nextStart, {
    combatId: "combat-1",
    combatantId: "combatant-a",
    round: 4,
    phase: "turnStart"
  }),
  true
);

// N rounds, end of turn.
const rounds = buildEffectTimer(
  { mode: "rounds", rounds: 3, expiry: "turnEnd" },
  combat,
  "rounds"
);
assert.equal(rounds.expiresRound, 6);
assert.equal(rounds.phase, "turnEnd");

// No active combat => safe manual fallback, but visibly marked untracked.
const noCombat = buildEffectTimer(
  { mode: "rounds", rounds: 2, expiry: "turnStart" },
  null,
  "no-combat"
);
assert.equal(noCombat.phase, "manual");
assert.equal(noCombat.untracked, true);

// Non-stacking: refreshes to one stack/timer.
const nonStack = {
  stacking: { mode: "none" },
  runtime: { stackCount: 1, timers: [manual] }
};
const nonStackAdded = addStackState(nonStack, rounds);
assert.equal(nonStackAdded.stackCount, 1);
assert.deepEqual(nonStackAdded.timers.map(t => t.id), ["rounds"]);

// Shared stacks: increments number, one refreshed common timer.
const shared = {
  stacking: { mode: "shared" },
  runtime: { stackCount: 2, timers: [manual] }
};
const sharedAdded = addStackState(shared, rounds);
assert.equal(sharedAdded.stackCount, 3);
assert.deepEqual(sharedAdded.timers.map(t => t.id), ["rounds"]);

const sharedRemoved = removeOneStackState({
  stacking: { mode: "shared" },
  runtime: { stackCount: 3, timers: [rounds] }
});
assert.equal(sharedRemoved.deleteEffect, false);
assert.equal(sharedRemoved.stackCount, 2);
assert.equal(sharedRemoved.timers.length, 1);

// Independent stacks: every stack preserves its own timer.
const independent = {
  stacking: { mode: "independent" },
  runtime: { stackCount: 2, timers: [manual, turnEnd] }
};
const independentAdded = addStackState(independent, rounds);
assert.equal(independentAdded.stackCount, 3);
assert.deepEqual(
  independentAdded.timers.map(t => t.id),
  ["manual", "turn-end", "rounds"]
);

const independentRemoved = removeOneStackState({
  stacking: { mode: "independent" },
  runtime: {
    stackCount: 3,
    timers: [manual, turnEnd, rounds]
  }
});
assert.equal(independentRemoved.deleteEffect, false);
assert.equal(independentRemoved.stackCount, 2);
assert.deepEqual(
  independentRemoved.timers.map(t => t.id),
  ["manual", "turn-end"]
);

// Count helper.
assert.equal(effectStackCount(nonStack), 1);
assert.equal(effectStackCount(shared), 2);
assert.equal(effectStackCount(independent), 2);

console.log("effect-system-regression: OK");
