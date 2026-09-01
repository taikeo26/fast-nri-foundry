import { normalizeAttackType } from "./attack-types.mjs";

export const CHECK_TARGET_CHARACTERISTICS = Object.freeze({
  armor: "КЗ",
  awareness: "Внимательность",
  reflex: "Рефлекс",
  fortitude: "Стойкость",
  will: "Воля"
});

export const ACTION_TRAITS = Object.freeze({
  melee: "Ближняя атака",
  ranged: "Дистанционная атака",
  area: "Область действия",
  intervention: "Вмешательство"
});

const DEFENSIVE_CHARACTERISTICS = new Set([
  "awareness",
  "reflex",
  "fortitude",
  "will"
]);

export function normalizeCheckTargetCharacteristic(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const aliases = {
    kz: "armor",
    ac: "armor",
    armor: "armor",
    awareness: "awareness",
    reflex: "reflex",
    fortitude: "fortitude",
    will: "will"
  };
  return aliases[raw] ?? "";
}

export function checkTargetCharacteristicLabel(value) {
  return CHECK_TARGET_CHARACTERISTICS[normalizeCheckTargetCharacteristic(value)] ?? "Не указана";
}

export function isDefensiveCharacteristic(value) {
  return DEFENSIVE_CHARACTERISTICS.has(normalizeCheckTargetCharacteristic(value));
}

export function normalizeActionTraits(value = {}) {
  const source = Array.isArray(value)
    ? Object.fromEntries(value.map(id => [String(id), true]))
    : value ?? {};

  return {
    melee: Boolean(source.melee),
    ranged: Boolean(source.ranged),
    area: Boolean(source.area),
    intervention: Boolean(source.intervention)
  };
}

export function actionTraitIds(value = {}) {
  const traits = normalizeActionTraits(value);
  return Object.keys(ACTION_TRAITS).filter(id => traits[id]);
}

export function actionTraitsLabel(value = {}) {
  const ids = actionTraitIds(value);
  return ids.length ? ids.map(id => ACTION_TRAITS[id]).join(", ") : "Нет";
}

function descriptionText(description) {
  return String(description ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru-RU");
}

/**
 * Migration-only prose recognition for old Ability Items.
 * Runtime rules must use structured data after migration.
 */
export function inferLegacyAbilityActionTraits(description, legacyAttackType = "") {
  const traits = normalizeActionTraits();
  const type = String(legacyAttackType ?? "").trim().toLowerCase();

  if (type === "melee") traits.melee = true;
  if (type === "ranged") traits.ranged = true;
  if (type === "area") traits.area = true;

  const text = descriptionText(description);
  if (text.includes("ближняя атака")) traits.melee = true;
  if (text.includes("дистанционная атака")) traits.ranged = true;
  if (text.includes("область действия")) traits.area = true;
  if (text.includes("вмешательство")) traits.intervention = true;

  return traits;
}

function sourceHasModernCheck(itemOrSystem) {
  const source = itemOrSystem?._source?.system;
  if (!source) return false;
  return Object.hasOwn(source, "check") || Object.hasOwn(source, "actionTraits");
}

/**
 * Read the 0.5.52 universal Check while remaining safe for legacy 0.5.51
 * documents until the GM migration has materialized the new fields.
 */
export function abilityCheckConfig(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const modern = system.check ?? {};
  const legacy = system.attackCheck ?? {};
  const modernStored = sourceHasModernCheck(itemOrSystem)
    || Object.hasOwn(system, "check") && !Object.hasOwn(system, "attackCheck");

  if (modernStored) {
    return {
      enabled: Boolean(modern.enabled),
      formula: String(modern.formula ?? "1d20 + {combatDie}"),
      targetCharacteristic: normalizeCheckTargetCharacteristic(modern.targetCharacteristic) || "armor",
      directedDefense: Boolean(system.defenseProcedure?.directedDefense),
      legacy: false
    };
  }

  return {
    enabled: Boolean(legacy.enabled),
    formula: String(legacy.formula ?? "1d20 + {combatDie}"),
    targetCharacteristic: "armor",
    directedDefense: Boolean(legacy.directedDefense),
    legacy: true
  };
}

export function abilityActionTraits(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const modern = normalizeActionTraits(system.actionTraits);
  const modernStored = sourceHasModernCheck(itemOrSystem)
    || Object.hasOwn(system, "actionTraits") && !Object.hasOwn(system, "attackCheck");

  if (modernStored) return modern;

  const legacy = inferLegacyAbilityActionTraits(
    system.description,
    system.attackCheck?.attackType
  );

  return {
    melee: modern.melee || legacy.melee,
    ranged: modern.ranged || legacy.ranged,
    area: modern.area || legacy.area,
    intervention: modern.intervention || legacy.intervention
  };
}

/**
 * A directed KZ attack has a usable standard Self Defense attack type only
 * when it is not an area and exactly one of melee/ranged is set.
 */
export function directedAttackTypeFromTraits(value = {}) {
  const traits = normalizeActionTraits(value);
  if (traits.area) return "";
  if (traits.melee === traits.ranged) return "";
  return traits.melee ? "melee" : "ranged";
}

export function checkStructureWarnings({ targetCharacteristic, traits } = {}) {
  const target = normalizeCheckTargetCharacteristic(targetCharacteristic);
  const normalizedTraits = normalizeActionTraits(traits);
  const warnings = [];

  if (!target) warnings.push("не указана целевая характеристика проверки");

  if (target === "armor" && !normalizedTraits.area) {
    const attackType = directedAttackTypeFromTraits(normalizedTraits);
    if (!attackType) {
      warnings.push("направленная Атака против КЗ должна иметь ровно один признак melee/ranged");
    }
  }

  if (normalizedTraits.melee && normalizedTraits.ranged) {
    warnings.push("одновременно указаны melee и ranged");
  }

  return warnings;
}

/** Compatibility helper for legacy call sites. */
export function legacyAttackTypeFromTraits(value = {}) {
  return normalizeAttackType(directedAttackTypeFromTraits(value));
}
