/**
 * 0.5.56 — canonical weapon taxonomy and Character weapon training.
 *
 * Runtime rules never infer weapon type/category from Item names or prose.
 * Exact-name lookup exists only for one-time migration of legacy 0.5.55.x
 * documents into the structured taxonomy.
 */

export const WEAPON_CATEGORIES = Object.freeze({
  chainWeapons: "Цепное оружие",
  clubs: "Дубины",
  swords: "Мечи",
  axes: "Топоры",
  hammers: "Молоты",
  spears: "Копья",
  staves: "Посохи",
  firearms: "Огнестрельное оружие",
  whips: "Кнуты",
  daggers: "Кинжалы",
  sickles: "Серпы",
  slings: "Пращи",
  bows: "Луки",
  crossbows: "Арбалеты",
  branches: "Ветви",
  holySymbols: "Священные символы",
  rods: "Жезлы",
  orbs: "Сферы",
  wands: "Палочки"
});

export const WEAPON_TYPES = Object.freeze({
  chain: Object.freeze({ label: "Цеп", categoryId: "chainWeapons" }),
  flail: Object.freeze({ label: "Кистень", categoryId: "chainWeapons" }),
  club: Object.freeze({ label: "Дубина", categoryId: "clubs" }),
  shortSword: Object.freeze({ label: "Короткий меч", categoryId: "swords" }),
  longSword: Object.freeze({ label: "Длинный меч", categoryId: "swords" }),
  rapier: Object.freeze({ label: "Рапира", categoryId: "swords" }),
  oneHandedAxe: Object.freeze({ label: "Одноручный топор", categoryId: "axes" }),
  twoHandedAxe: Object.freeze({ label: "Двуручный топор", categoryId: "axes" }),
  brutalAxe: Object.freeze({ label: "Жестокий топор", categoryId: "axes" }),
  twoHandedHammer: Object.freeze({ label: "Двуручный молот", categoryId: "hammers" }),
  heavyHammer: Object.freeze({ label: "Тяжёлый молот", categoryId: "hammers" }),
  longSpear: Object.freeze({ label: "Длинное копьё", categoryId: "spears" }),
  combatStaff: Object.freeze({ label: "Боевой посох", categoryId: "staves" }),
  greatSword: Object.freeze({ label: "Двуручный меч", categoryId: "swords" }),
  pistol: Object.freeze({ label: "Пистолет", categoryId: "firearms" }),
  whip: Object.freeze({ label: "Кнут", categoryId: "whips" }),
  dagger: Object.freeze({ label: "Кинжал", categoryId: "daggers" }),
  sickle: Object.freeze({ label: "Серп", categoryId: "sickles" }),
  sling: Object.freeze({ label: "Праща", categoryId: "slings" }),
  longBow: Object.freeze({ label: "Длинный лук", categoryId: "bows" }),
  crossbow: Object.freeze({ label: "Арбалет", categoryId: "crossbows" }),
  shortBow: Object.freeze({ label: "Короткий лук", categoryId: "bows" }),
  branch: Object.freeze({ label: "Ветвь", categoryId: "branches" }),
  divineSymbol: Object.freeze({ label: "Божественный символ", categoryId: "holySymbols" }),
  rod: Object.freeze({ label: "Жезл", categoryId: "rods" }),
  orb: Object.freeze({ label: "Сфера", categoryId: "orbs" }),
  wand: Object.freeze({ label: "Волшебная палочка", categoryId: "wands" }),
  twoHandedMagicStaff: Object.freeze({ label: "Двуручный волшебный посох", categoryId: "staves" })
});

export const WEAPON_TYPE_IDS = Object.freeze(Object.keys(WEAPON_TYPES));
export const WEAPON_CATEGORY_IDS = Object.freeze(Object.keys(WEAPON_CATEGORIES));

export const WEAPON_TYPE_CHOICES = Object.freeze(
  Object.fromEntries(WEAPON_TYPE_IDS.map(id => [id, WEAPON_TYPES[id].label]))
);

export const WEAPON_CATEGORY_CHOICES = Object.freeze(
  Object.fromEntries(WEAPON_CATEGORY_IDS.map(id => [id, WEAPON_CATEGORIES[id]]))
);

function uniqueStrings(value) {
  return Array.from(new Set(Array.from(value ?? [])
    .map(id => String(id ?? "").trim())
    .filter(Boolean)));
}

function readChange(changes, path) {
  if (!changes || typeof changes !== "object") return { found: false, value: undefined };
  if (Object.prototype.hasOwnProperty.call(changes, path)) {
    return { found: true, value: changes[path] };
  }

  const parts = path.split(".");
  let cursor = changes;
  for (const part of parts) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false, value: undefined };
    }
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}

function writeChange(changes, path, value) {
  if (Object.prototype.hasOwnProperty.call(changes, path)) {
    changes[path] = value;
    return;
  }

  const [root, ...rest] = path.split(".");
  if (rest.length === 1 && changes[root] && typeof changes[root] === "object") {
    changes[root][rest[0]] = value;
    return;
  }

  changes[path] = value;
}

export function normalizeWeaponTypeId(value) {
  const id = String(value ?? "").trim();
  return Object.prototype.hasOwnProperty.call(WEAPON_TYPES, id) ? id : "";
}

export function normalizeWeaponCategoryId(value) {
  const id = String(value ?? "").trim();
  return Object.prototype.hasOwnProperty.call(WEAPON_CATEGORIES, id) ? id : "";
}

export function weaponTypeLabel(typeId) {
  return WEAPON_TYPES[normalizeWeaponTypeId(typeId)]?.label ?? "";
}

export function weaponCategoryLabel(categoryId) {
  return WEAPON_CATEGORIES[normalizeWeaponCategoryId(categoryId)] ?? "";
}

export function weaponCategoryIdForType(typeId) {
  return WEAPON_TYPES[normalizeWeaponTypeId(typeId)]?.categoryId ?? "";
}

export function weaponTypeIdsForCategory(categoryId) {
  const normalizedCategory = normalizeWeaponCategoryId(categoryId);
  if (!normalizedCategory) return [];
  return WEAPON_TYPE_IDS.filter(id => WEAPON_TYPES[id].categoryId === normalizedCategory);
}

export function firstWeaponTypeIdForCategory(categoryId) {
  return weaponTypeIdsForCategory(categoryId)[0] ?? "";
}

function normalizedRussianLabel(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
}

/** Migration-only exact label lookup. Never use this in runtime rule resolution. */
export function legacyWeaponTypeIdFromName(name) {
  const normalized = normalizedRussianLabel(name);
  if (!normalized) return "";
  for (const [id, definition] of Object.entries(WEAPON_TYPES)) {
    if (normalizedRussianLabel(definition.label) === normalized) return id;
  }
  return "";
}

/** HB-04: typeId is authoritative and always determines categoryId. */
export function normalizeWeaponTaxonomy(system = {}) {
  const typeId = normalizeWeaponTypeId(system?.typeId);
  return {
    typeId,
    categoryId: typeId ? weaponCategoryIdForType(typeId) : ""
  };
}

/** HB-04 for Item.update payloads, including nested ApplicationV2 form data. */
export function normalizeWeaponTaxonomyUpdate(item, changes) {
  if (!item || item.type !== "weapon" || !changes || typeof changes !== "object") return changes;

  const typeChange = readChange(changes, "system.typeId");
  const categoryChange = readChange(changes, "system.categoryId");
  if (!typeChange.found && !categoryChange.found) return changes;

  const currentTypeId = normalizeWeaponTypeId(item.system?.typeId);
  const requestedTypeId = typeChange.found
    ? normalizeWeaponTypeId(typeChange.value)
    : currentTypeId;

  // Category cannot independently contradict the type. Category changes from
  // the Item Sheet are translated into a compatible type before Document.update.
  writeChange(changes, "system.typeId", requestedTypeId);
  writeChange(changes, "system.categoryId", weaponCategoryIdForType(requestedTypeId));
  return changes;
}

export function normalizeWeaponTrainingIds(value) {
  return uniqueStrings(value).filter(id => Boolean(normalizeWeaponTypeId(id)));
}

/** Complete Actor source normalization: Mastery is always a subset of Proficiency. */
export function normalizeActorWeaponTraining(system = {}) {
  const proficiencies = normalizeWeaponTrainingIds(system?.weaponProficiencyIds);
  const masteries = normalizeWeaponTrainingIds(system?.weaponMasteryIds);
  const proficiencySet = new Set(proficiencies);
  for (const id of masteries) proficiencySet.add(id);
  return {
    weaponProficiencyIds: Array.from(proficiencySet),
    weaponMasteryIds: masteries
  };
}

/**
 * HB-03 for Actor.update payloads.
 * Direction-sensitive rules:
 * - newly added Mastery adds Proficiency;
 * - removing Proficiency removes Mastery;
 * - removing Mastery leaves Proficiency;
 * - adding Proficiency does not add Mastery.
 */
export function normalizeActorWeaponTrainingUpdate(actor, changes) {
  if (!actor || actor.type !== "character" || !changes || typeof changes !== "object") return changes;

  const proficiencyChange = readChange(changes, "system.weaponProficiencyIds");
  const masteryChange = readChange(changes, "system.weaponMasteryIds");
  if (!proficiencyChange.found && !masteryChange.found) return changes;

  const currentProficiencies = normalizeWeaponTrainingIds(actor.system?.weaponProficiencyIds);
  const currentMasteries = normalizeWeaponTrainingIds(actor.system?.weaponMasteryIds);
  let nextProficiencies = proficiencyChange.found
    ? normalizeWeaponTrainingIds(proficiencyChange.value)
    : [...currentProficiencies];
  let nextMasteries = masteryChange.found
    ? normalizeWeaponTrainingIds(masteryChange.value)
    : [...currentMasteries];

  const currentProficiencySet = new Set(currentProficiencies);
  const currentMasterySet = new Set(currentMasteries);
  const nextProficiencySet = new Set(nextProficiencies);
  const nextMasterySet = new Set(nextMasteries);

  // Mastery added by this update wins over a stale proficiency field serialized
  // by submitOnChange and materializes its required Proficiency.
  for (const id of nextMasterySet) {
    if (!currentMasterySet.has(id)) nextProficiencySet.add(id);
  }

  // Explicit removal of an existing Proficiency wins over a stale Mastery field.
  for (const id of currentProficiencySet) {
    if (!nextProficiencySet.has(id)) nextMasterySet.delete(id);
  }

  // Final invariant for imported/direct update payloads.
  for (const id of nextMasterySet) nextProficiencySet.add(id);

  nextProficiencies = Array.from(nextProficiencySet);
  nextMasteries = Array.from(nextMasterySet).filter(id => nextProficiencySet.has(id));

  writeChange(changes, "system.weaponProficiencyIds", nextProficiencies);
  writeChange(changes, "system.weaponMasteryIds", nextMasteries);
  return changes;
}

function weaponTypeIdFromInput(weaponOrTypeId) {
  if (typeof weaponOrTypeId === "string") return normalizeWeaponTypeId(weaponOrTypeId);
  return normalizeWeaponTypeId(weaponOrTypeId?.system?.typeId ?? weaponOrTypeId?.typeId);
}

export function actorHasWeaponProficiency(actor, weaponOrTypeId) {
  if (actor?.type !== "character") return false;
  const typeId = weaponTypeIdFromInput(weaponOrTypeId);
  if (!typeId) return false;
  return normalizeWeaponTrainingIds(actor.system?.weaponProficiencyIds).includes(typeId);
}

export function actorHasWeaponMastery(actor, weaponOrTypeId) {
  if (actor?.type !== "character") return false;
  const typeId = weaponTypeIdFromInput(weaponOrTypeId);
  if (!typeId) return false;
  return normalizeWeaponTrainingIds(actor.system?.weaponMasteryIds).includes(typeId);
}
