import { CREATURE_TRAITS } from "./config.mjs";
import {
  normalizeActorWeaponTraining,
  normalizeActorWeaponTrainingUpdate,
  normalizeWeaponTaxonomy,
  normalizeWeaponTaxonomyUpdate
} from "./weapon-taxonomy.mjs";

export const UNARMED_PROPERTY_ID = "unarmed";
export const DEFAULT_UNARMED_ATTACK_NAME = "Безоружная атака";

function normalizeHands(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric >= 2 ? 2 : 1;
}

function normalizePropertyIds(value) {
  const ids = Array.from(value ?? [])
    .map(id => String(id ?? "").trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

function withProperty(ids, propertyId) {
  const result = normalizePropertyIds(ids);
  if (!result.includes(propertyId)) result.push(propertyId);
  return result;
}

function withoutProperty(ids, propertyId) {
  return normalizePropertyIds(ids).filter(id => id !== propertyId);
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

  // Dotted paths are the normal Document.update representation in this system.
  changes[path] = value;
}

/**
 * Normalize a complete Weapon system source.
 *
 * Rules:
 * - an explicitly supplied `unarmed` property wins and forces hands=0;
 * - otherwise hands=0 always receives `unarmed`;
 * - hands=1/2 never keep `unarmed`.
 */
export function normalizeWeaponSystem(system = {}) {
  let hands = normalizeHands(system?.hands);
  let propertyIds = normalizePropertyIds(system?.propertyIds);

  if (propertyIds.includes(UNARMED_PROPERTY_ID)) {
    hands = 0;
    propertyIds = withProperty(propertyIds, UNARMED_PROPERTY_ID);
  } else if (hands === 0) {
    propertyIds = withProperty(propertyIds, UNARMED_PROPERTY_ID);
  } else {
    propertyIds = withoutProperty(propertyIds, UNARMED_PROPERTY_ID);
  }

  return { hands, propertyIds };
}

/**
 * Enforce the hands <-> `Безоружное` invariant for an Item.update payload.
 *
 * Direction matters:
 * - user adds `Безоружное` -> hands becomes 0;
 * - user changes hands to 1/2 -> `Безоружное` is removed;
 * - user changes hands to 0 -> `Безоружное` is added;
 * - user tries to remove `Безоружное` while hands remain 0 -> it is restored.
 */
export function normalizeWeaponUpdate(item, changes) {
  if (!item || item.type !== "weapon" || !changes || typeof changes !== "object") return changes;

  const handsChange = readChange(changes, "system.hands");
  const propertiesChange = readChange(changes, "system.propertyIds");

  if (!handsChange.found && !propertiesChange.found) return changes;

  const currentHands = normalizeHands(item.system?.hands);
  const currentProperties = normalizePropertyIds(item.system?.propertyIds);

  let nextHands = handsChange.found ? normalizeHands(handsChange.value) : currentHands;
  let nextProperties = propertiesChange.found
    ? normalizePropertyIds(propertiesChange.value)
    : currentProperties;

  const hadUnarmed = currentProperties.includes(UNARMED_PROPERTY_ID);
  const hasUnarmed = nextProperties.includes(UNARMED_PROPERTY_ID);
  const explicitlyAddedUnarmed = propertiesChange.found && hasUnarmed && !hadUnarmed;

  if (explicitlyAddedUnarmed) {
    // Giving the property is an explicit request: it takes precedence over a
    // simultaneous hands value and turns the weapon into a hands-free attack.
    nextHands = 0;
    nextProperties = withProperty(nextProperties, UNARMED_PROPERTY_ID);
  } else if (handsChange.found) {
    // A direct hands change takes precedence when `unarmed` was not newly added.
    nextProperties = nextHands === 0
      ? withProperty(nextProperties, UNARMED_PROPERTY_ID)
      : withoutProperty(nextProperties, UNARMED_PROPERTY_ID);
  } else if (nextHands === 0) {
    // hands=0 cannot exist without the property, so manual removal is reverted.
    nextProperties = withProperty(nextProperties, UNARMED_PROPERTY_ID);
  } else {
    nextProperties = withoutProperty(nextProperties, UNARMED_PROPERTY_ID);
  }

  writeChange(changes, "system.hands", nextHands);
  writeChange(changes, "system.propertyIds", nextProperties);

  // If the weapon becomes hands-free through the property, it can no longer be
  // physically held. Keep `Экипирован` untouched.
  if (nextHands === 0) {
    writeChange(changes, "system.held", false);
    writeChange(changes, "system.equippedAt", 0);
  }

  return changes;
}

export function defaultUnarmedAttackData() {
  return {
    name: DEFAULT_UNARMED_ATTACK_NAME,
    type: "weapon",
    system: {
      range: "Ближняя",
      typeId: "",
      categoryId: "",
      attackType: "melee",
      propertyIds: [UNARMED_PROPERTY_ID],
      equipped: true,
      held: false,
      hands: 0,
      equippedAt: 0,
      damageType: "physical",
      damage: {
        partial: "1d4",
        success: "2d4",
        great: "2d4+1"
      }
    }
  };
}

function hasDefaultUnarmedAttackSource(actor) {
  const sources = Array.from(actor?._source?.items ?? []);
  return sources.some(item => item?.type === "weapon" && item?.name === DEFAULT_UNARMED_ATTACK_NAME);
}

export function addDefaultUnarmedAttackToActorSource(actor) {
  if (!actor || !["character", "creature"].includes(actor.type)) return false;
  if (hasDefaultUnarmedAttackSource(actor)) return false;
  if (typeof actor.updateSource !== "function") return false;

  const items = Array.from(actor?._source?.items ?? []).map(item => ({ ...item }));
  items.push(defaultUnarmedAttackData());
  actor.updateSource({ items });
  return true;
}


function componentTraitIds(component, weapon, actor) {
  const traits = new Set(component?.traitIds ?? []);

  // Creature source traits are properties of each damage part.
  for (const id of actor?.system?.creatureTraitIds ?? []) traits.add(id);

  // Legacy worlds could store creature damage properties on the Weapon itself.
  // This compatibility stays at data interpretation, never prose parsing.
  for (const id of weapon?.system?.propertyIds ?? []) {
    if (Object.hasOwn(CREATURE_TRAITS, id)) traits.add(id);
  }

  return Array.from(traits);
}

/**
 * Structured Weapon damage profile shared by production v2 and retained
 * compatibility helpers. Keeping this out of rolls.mjs prevents Weapon v2
 * from depending on legacy chat orchestration.
 */
export function weaponDamageComponents(actor, weapon, profile) {
  const configured = Array.from(weapon?.system?.damageComponents?.[profile] ?? [])
    .map(component => ({
      formula: String(component?.formula ?? "").trim(),
      damageType: ["physical", "magic"].includes(component?.damageType)
        ? component.damageType
        : "physical",
      traitIds: componentTraitIds(component, weapon, actor)
    }))
    .filter(component => component.formula);

  if (configured.length) return configured;

  const formula = String(weapon?.system?.damage?.[profile] ?? "0").trim() || "0";
  return [{
    formula,
    damageType: weapon?.system?.damageType === "magic" ? "magic" : "physical",
    traitIds: componentTraitIds({ traitIds: [] }, weapon, actor)
  }];
}

export function activateWeaponRules() {
  Hooks.on("preCreateItem", item => {
    if (item?.type !== "weapon") return;

    const sourceSystem = item.system ?? item._source?.system ?? {};
    const normalized = normalizeWeaponSystem(sourceSystem);
    const taxonomy = normalizeWeaponTaxonomy(sourceSystem);
    item.updateSource({
      "system.hands": normalized.hands,
      "system.propertyIds": normalized.propertyIds,
      "system.typeId": taxonomy.typeId,
      "system.categoryId": taxonomy.categoryId,
      ...(normalized.hands === 0 ? {
        "system.held": false,
        "system.equippedAt": 0
      } : {})
    });
  });

  Hooks.on("preUpdateItem", (item, changes) => {
    normalizeWeaponUpdate(item, changes);
    normalizeWeaponTaxonomyUpdate(item, changes);
  });

  Hooks.on("preCreateActor", actor => {
    if (actor?.type === "character") {
      const training = normalizeActorWeaponTraining(actor.system ?? actor._source?.system ?? {});
      actor.updateSource({
        "system.weaponProficiencyIds": training.weaponProficiencyIds,
        "system.weaponMasteryIds": training.weaponMasteryIds
      });
    }
    addDefaultUnarmedAttackToActorSource(actor);
  });

  Hooks.on("preUpdateActor", (actor, changes) => {
    normalizeActorWeaponTrainingUpdate(actor, changes);
  });
}
