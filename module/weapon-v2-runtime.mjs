import { inferWeaponAttackType } from "./attack-types.mjs";
import { resolveWeaponAttackTerm } from "./attack-term.mjs";
import { weaponDamageComponents } from "./weapon-rules.mjs";

/**
 * 0.5.78 thin Weapon -> ActionState v2 structured adapter.
 * It contains no chat-card or resolution orchestration.
 */
export function weaponV2Runtime(actor, weapon) {
  const attackType = inferWeaponAttackType(weapon);
  const attackTerm = resolveWeaponAttackTerm(actor, weapon);
  const term = String(attackTerm?.formula ?? "").trim();
  const formula = term ? `1d20 + ${term}` : "1d20";
  const profile = degree => ({
    enabled: degree !== "failure",
    text: "",
    damage: {
      enabled: degree !== "failure",
      components: degree === "failure" ? [] : weaponDamageComponents(actor, weapon, degree),
      removeHighest: 0,
      removeLowest: 0,
      removeAll: degree === "failure"
    },
    healing: { enabled: false, components: [] },
    tempHp: { enabled: false, components: [] },
    effectUuids: []
  });

  return {
    uuid: weapon?.uuid ?? null,
    id: weapon?.id ?? null,
    type: "weapon",
    name: weapon?.name ?? "Оружие",
    parent: actor ?? weapon?.parent ?? null,
    implementationId: "weapon-attack",
    implementationName: "Атака оружием",
    v2SourceKind: "weapon",
    weaponAttackTerm: {
      kind: attackTerm?.kind ?? "unproficient",
      formula: term,
      label: attackTerm?.label ?? "Только d20",
      reason: attackTerm?.reason ?? "",
      proficient: Boolean(attackTerm?.proficient),
      mastery: Boolean(attackTerm?.mastery),
      unarmed: Boolean(attackTerm?.unarmed),
      typeId: String(weapon?.system?.typeId ?? ""),
      categoryId: String(weapon?.system?.categoryId ?? "")
    },
    system: {
      description: weapon?.system?.description ?? "",
      category: "weapon",
      level: weapon?.system?.level ?? 1,
      traitIds: ["attack", attackType, ...Array.from(weapon?.system?.propertyIds ?? [])].filter(Boolean),
      costs: { action: 1, movement: 0, intervention: 0, freeAction: false, classResource: 0, classResourceMin: 0, classResourceMax: 0, additionalText: "" },
      targeting: {
        mode: "single",
        relation: "enemy",
        countMin: 1,
        countMax: 1,
        rangeMode: "weapon",
        rangeCells: 0,
        requiresVisibility: false,
        text: String(weapon?.system?.range ?? "")
      },
      check: { enabled: true, formula, targetCharacteristic: "armor" },
      defenseProcedure: { directedDefense: true },
      profiles: {
        failure: profile("failure"),
        partial: profile("partial"),
        success: profile("success"),
        great: profile("great")
      },
      outcomes: {},
      outcome: {},
      actionParts: [],
      effectUuids: [],
      repeat: { count: 1, label: "Атака" },
      propertyIds: Array.from(weapon?.system?.propertyIds ?? []),
      attackType,
      range: String(weapon?.system?.range ?? "")
    }
  };
}
