import { actorHasWeaponMastery, actorHasWeaponProficiency, weaponTypeLabel } from "./weapon-taxonomy.mjs";
import { UNARMED_PROPERTY_ID } from "./weapon-rules.mjs";

function actorCombatDie(actor) {
  return String(actor?.system?.combatDie ?? "").trim();
}

function creatureAttackModifier(actor) {
  const value = Number(actor?.system?.attackModifier);
  return Number.isFinite(value) ? value : 0;
}

function weaponIsUnarmed(weapon) {
  return Array.from(weapon?.system?.propertyIds ?? []).map(String).includes(UNARMED_PROPERTY_ID);
}

/**
 * Generic replacement for the rules concept "Combat Die" when a rule uses it:
 * Character -> Combat Die; Creature -> Bestiary attackModifier.
 */
export function resolveActorCombatTerm(actor) {
  if (!actor) return null;

  if (actor.type === "creature") {
    const modifier = creatureAttackModifier(actor);
    return {
      kind: "attackModifier",
      formula: String(modifier),
      label: "Модификатор атаки",
      reason: "Существо Бестиария",
      value: modifier
    };
  }

  const combatDie = actorCombatDie(actor);
  if (!combatDie) return null;
  return {
    kind: "combatDie",
    formula: combatDie,
    label: "Куб боя",
    reason: actor?.name ?? "Персонаж",
    value: combatDie
  };
}

/**
 * 0.5.56 weapon attack term:
 * - Creature: 1d20 + attackModifier;
 * - Character + Unarmed: 1d20 + Combat Die;
 * - Character + proficiency in selected weapon type: 1d20 + Combat Die;
 * - Character without proficiency: plain 1d20.
 */
export function resolveWeaponAttackTerm(actor, weapon) {
  if (!actor || !weapon || weapon.type !== "weapon") return null;

  if (actor.type === "creature") {
    return {
      ...resolveActorCombatTerm(actor),
      proficient: true,
      mastery: false,
      unarmed: weaponIsUnarmed(weapon),
      typeId: String(weapon.system?.typeId ?? "")
    };
  }

  const unarmed = weaponIsUnarmed(weapon);
  const proficient = unarmed || actorHasWeaponProficiency(actor, weapon);
  const mastery = !unarmed && actorHasWeaponMastery(actor, weapon);
  const typeId = String(weapon.system?.typeId ?? "");
  const typeLabel = weaponTypeLabel(typeId);

  if (!proficient) {
    return {
      kind: "unproficient",
      formula: "",
      label: "Без Владения",
      reason: typeLabel ? `Нет Владения: ${typeLabel}` : "Тип оружия не указан или Владение отсутствует",
      proficient: false,
      mastery: false,
      unarmed,
      typeId
    };
  }

  const base = resolveActorCombatTerm(actor);
  if (!base) {
    return {
      kind: "unproficient",
      formula: "",
      label: "Куб боя отсутствует",
      reason: unarmed ? "Безоружная атака" : `Владение: ${typeLabel || typeId}`,
      proficient: true,
      mastery,
      unarmed,
      typeId
    };
  }

  return {
    ...base,
    reason: unarmed
      ? "Безоружная атака"
      : `${mastery ? "Мастерство" : "Владение"}: ${typeLabel || typeId}`,
    proficient: true,
    mastery,
    unarmed,
    typeId
  };
}

export function formulaWithActorCombatTerm(actor, rawFormula = "1d20 + {combatDie}") {
  const term = resolveActorCombatTerm(actor);
  const replacement = term?.formula || "0";
  const formula = String(rawFormula ?? "1d20 + {combatDie}")
    .replaceAll("{combatDie}", replacement)
    .replaceAll("@combatDie", replacement)
    .trim();
  return formula || "1d20";
}
