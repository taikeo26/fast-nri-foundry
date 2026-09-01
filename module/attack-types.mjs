export const ATTACK_TYPES = Object.freeze({
  melee: "Ближняя атака",
  ranged: "Дистанционная атака"
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
 * Weapon attack type is explicit in rules 6.3: only melee/ranged.
 *
 * Empty or invalid values can only come from documents created before the
 * 0.5.52 migration. They are treated as melee immediately and persisted as
 * melee by migrateRules63Once(); runtime no longer guesses from range/properties.
 */
export function inferWeaponAttackType(weaponOrSystem) {
  const system = weaponOrSystem?.system ?? weaponOrSystem ?? {};
  return normalizeAttackType(system.attackType) || "melee";
}

/**
 * Migration helper for the melee/ranged portion of old Ability prose.
 * Area is intentionally handled by the independent action-traits migration.
 */
export function inferAbilityAttackTypeFromDescription(description) {
  const text = String(description ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("ru-RU");

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
  isArea = false,
  selfDefenseOverride = ""
} = {}) {
  if (role !== "self") return "fortitude";

  const override = normalizeSelfDefenseCharacteristic(selfDefenseOverride);
  if (override) return override;

  if (isArea) return "";

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
