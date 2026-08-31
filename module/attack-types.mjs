export const ATTACK_TYPES = Object.freeze({
  melee: "Ближняя атака",
  ranged: "Дистанционная атака",
  area: "Область действия"
});

export const SELF_DEFENSE_CHARACTERISTICS = Object.freeze({
  fortitude: "Стойкость",
  reflex: "Рефлекс"
});

export function normalizeAttackType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(ATTACK_TYPES, type) ? type : "";
}

export function normalizeSelfDefenseCharacteristic(value) {
  const characteristic = String(value ?? "").trim().toLowerCase();
  return Object.hasOwn(SELF_DEFENSE_CHARACTERISTICS, characteristic)
    ? characteristic
    : "";
}

/**
 * 6.3 attack-type fallback for pre-migration Weapon Items.
 *
 * Explicit machine data always wins. Reach is a melee property even when the
 * printed range is numeric. A printed melee label is also melee. Remaining
 * non-empty ranges are treated as ranged weapon attacks.
 */
export function inferWeaponAttackType(weaponOrSystem) {
  const system = weaponOrSystem?.system ?? weaponOrSystem ?? {};
  const explicit = normalizeAttackType(system.attackType);
  if (explicit) return explicit;

  const properties = new Set(Array.from(system.propertyIds ?? []).map(String));
  const range = String(system.range ?? "").trim().toLocaleLowerCase("ru-RU");

  if (properties.has("reach") || range.startsWith("ближ")) return "melee";
  if (range) return "ranged";
  return "";
}

/**
 * Extract an attack type from a legacy ability description when the wording
 * already makes the 6.3 type unambiguous. This is a migration helper only;
 * runtime never parses prose to decide a rule.
 */
export function inferAbilityAttackTypeFromDescription(description) {
  const text = String(description ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru-RU");

  if (text.includes("область действия")) return "area";
  if (text.includes("ближняя атака")) return "melee";
  if (text.includes("дистанционная атака")) return "ranged";
  return "";
}

/**
 * 6.3 changes only Self Defense. Ally directed defense keeps the general
 * Directed Defense characteristic (Fortitude).
 */
export function defenseCharacteristicForRole({
  role,
  attackType = "",
  selfDefenseOverride = ""
} = {}) {
  if (role !== "self") return "fortitude";

  const override = normalizeSelfDefenseCharacteristic(selfDefenseOverride);
  if (override) return override;

  const type = normalizeAttackType(attackType);
  if (type === "melee") return "fortitude";
  if (type === "ranged") return "reflex";
  return "";
}

export function attackTypeLabel(value) {
  return ATTACK_TYPES[normalizeAttackType(value)] ?? "Не указан";
}

export function defenseCharacteristicLabel(value) {
  return SELF_DEFENSE_CHARACTERISTICS[normalizeSelfDefenseCharacteristic(value)] ?? "Не определена";
}
