import assert from "node:assert/strict";
import {
  defenseActionConfig,
  defenseCostLabel,
  defenseRoleMatches,
  evaluateDefenseAbility,
  footprintGapCells,
  isDefenseAbilityForRole,
  resolveDefenseCombatSource,
  tokensAdjacent
} from "../module/defense-actions.mjs";

assert.equal(defenseRoleMatches("ally", "ally"), true);
assert.equal(defenseRoleMatches("ally", "self"), false);
assert.equal(defenseRoleMatches("either", "self"), true);
assert.equal(defenseRoleMatches("either", "ally"), true);

const allyDefense = {
  id: "ally-defense",
  uuid: "Actor.a.Item.ally-defense",
  type: "ability",
  name: "Тестовая защита",
  sort: 10,
  system: {
    classResourceCost: 2,
    defenseAction: {
      enabled: true,
      targetScope: "ally",
      interventionCost: 1,
      rangeMode: "adjacent",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: false
    }
  }
};

assert.equal(isDefenseAbilityForRole(allyDefense, "ally"), true);
assert.equal(isDefenseAbilityForRole(allyDefense, "self"), false);
assert.equal(defenseActionConfig(allyDefense).removeDamageParts, 1);
assert.equal(defenseActionConfig(allyDefense).damageSelectionMode, "standard");

const modifier = {
  id: "modifier",
  uuid: "Actor.a.Item.modifier",
  type: "ability",
  name: "Защитная подготовка",
  sort: 1,
  system: {
    defenseModifier: {
      enabled: true,
      scope: "all",
      combatDiceFormula: "2d6"
    }
  }
};

const actor = {
  name: "Защитник",
  type: "character",
  system: {
    combatDie: "1d6",
    speed: 5,
    resources: { intervention: 0 },
    classResource: { label: "Волшебная сила", value: 1, max: 4 }
  },
  items: [modifier, allyDefense]
};

const source = resolveDefenseCombatSource(actor, allyDefense, "ally");
assert.equal(source.formula, "2d6");
assert.equal(source.label, "Защитная подготовка");

const overridden = structuredClone(allyDefense);
overridden.system.defenseAction.combatDiceFormula = "1d10";
const actionSource = resolveDefenseCombatSource(actor, overridden, "ally");
assert.equal(actionSource.formula, "1d10");
assert.equal(actionSource.label, "Тестовая защита");

assert.equal(
  defenseCostLabel(allyDefense, actor),
  "1 Вмешательство + 2 Волшебная сила"
);

assert.equal(
  footprintGapCells(
    { left: 0, top: 0, right: 1, bottom: 1 },
    { left: 1, top: 1, right: 2, bottom: 2 }
  ),
  0
);

const defenderToken = {
  id: "defender",
  visible: true,
  document: { x: 0, y: 0, width: 1, height: 1 }
};
const adjacentTarget = {
  id: "target",
  actor: { id: "target-actor" },
  visible: true,
  document: { x: 1, y: 0, width: 1, height: 1 }
};
const farTarget = {
  id: "far",
  actor: { id: "far-actor" },
  visible: true,
  document: { x: 4, y: 0, width: 1, height: 1 }
};

assert.equal(tokensAdjacent(defenderToken, adjacentTarget), true);
assert.equal(tokensAdjacent(defenderToken, farTarget), false);

const adjacentAvailability = evaluateDefenseAbility({
  actor,
  defenderToken,
  protectedToken: adjacentTarget,
  item: allyDefense,
  role: "ally"
});
assert.equal(adjacentAvailability.disabled, false);
assert.match(adjacentAvailability.warnings.join(" "), /Вмешательств/);
assert.match(adjacentAvailability.warnings.join(" "), /классового ресурса/);

const farAvailability = evaluateDefenseAbility({
  actor,
  defenderToken,
  protectedToken: farTarget,
  item: allyDefense,
  role: "ally"
});
assert.equal(farAvailability.disabled, true);
assert.match(farAvailability.reasons.join(" "), /не соседствует/);

console.log("defense-actions-regression: OK");
