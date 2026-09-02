import { itemIsUsable } from "./equipment.mjs";
import { cellsAtRadius, isStandingAndConscious } from "./field-geometry.mjs";

export const REACH_PROPERTY_ID = "reach";

function actorItems(actor) {
  return actor?.items?.contents ?? Array.from(actor?.items ?? []);
}

function normalizeRange(value) {
  return String(value ?? "").trim().toLocaleLowerCase("ru-RU");
}

function cellKey(cell) {
  if (!cell || !Number.isFinite(Number(cell.i)) || !Number.isFinite(Number(cell.j))) return "";
  return `${Number(cell.i)}:${Number(cell.j)}:${cell.k ?? ""}`;
}

export function weaponHasProperty(weapon, propertyId) {
  if (!weapon || weapon.type !== "weapon") return false;
  const id = String(propertyId ?? "").trim();
  if (!id) return false;
  return Array.from(weapon.system?.propertyIds ?? []).map(String).includes(id);
}

/**
 * 0.5.56.2: melee/ranged is a structured Weapon property and no longer
 * inferred from the display value of Distance. Legacy textual range is kept
 * only as a fallback for pre-migration documents.
 */
export function isMeleeWeapon(weapon) {
  if (!weapon || weapon.type !== "weapon") return false;
  const attackType = String(weapon.system?.attackType ?? "").trim().toLowerCase();
  if (attackType === "melee") return true;
  if (attackType === "ranged") return false;

  const range = normalizeRange(weapon.system?.range);
  return range === "melee" || range.startsWith("ближ") || range === "1";
}

/**
 * Applied Effect Items may explicitly suppress melee control without hard
 * blocking attack buttons. This is field-state automation only.
 */
export function actorHasMeleeControlBlocker(actor) {
  if (!actor) return false;
  return actorItems(actor).some(item =>
    item?.type === "effect"
    && item.system?.rules?.disableMeleeControl === true
  );
}

export function canCreateMeleeControl(actor) {
  if (!actor) return false;
  if (!isStandingAndConscious(actor)) return false;
  if (actorHasMeleeControlBlocker(actor)) return false;
  return true;
}

/**
 * Return usable melee Weapon Items which currently contribute field control.
 * `itemIsUsable` preserves the equipment contract:
 * - hands-free weapon: Equipped is enough;
 * - hand-requiring weapon: must be Equipped and Held.
 */
export function meleeControlSources(actor) {
  if (!canCreateMeleeControl(actor)) return [];

  return actorItems(actor).filter(item =>
    item?.type === "weapon"
    && isMeleeWeapon(item)
    && itemIsUsable(item)
  );
}

/**
 * A normal melee source controls radius 1. A Reach source controls radius 2
 * only. Several sources are combined, so an actor may control both radii.
 */
export function meleeControlRadii(actor) {
  const radii = new Set();

  for (const weapon of meleeControlSources(actor)) {
    radii.add(weaponHasProperty(weapon, REACH_PROPERTY_ID) ? 2 : 1);
  }

  return Array.from(radii).sort((a, b) => a - b);
}

/**
 * Return the union of all Fast NRI melee-controlled grid cells around the
 * Token's complete footprint. Geometry itself is delegated to field-geometry.
 */
export function controlledMeleeCells(tokenOrDocument, grid = globalThis.canvas?.grid ?? null) {
  const tokenDocument = tokenOrDocument?.document ?? tokenOrDocument ?? null;
  const actor = tokenDocument?.actor ?? tokenOrDocument?.actor ?? null;
  if (!actor) return [];

  const unique = new Map();
  for (const radius of meleeControlRadii(actor)) {
    for (const cell of cellsAtRadius(tokenOrDocument, radius, grid)) {
      const key = cellKey(cell);
      if (key && !unique.has(key)) unique.set(key, cell);
    }
  }

  return Array.from(unique.values());
}
