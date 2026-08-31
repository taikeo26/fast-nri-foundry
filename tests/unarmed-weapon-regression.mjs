import assert from "node:assert/strict";
import {
  DEFAULT_UNARMED_ATTACK_NAME,
  UNARMED_PROPERTY_ID,
  addDefaultUnarmedAttackToActorSource,
  defaultUnarmedAttackData,
  normalizeWeaponSystem,
  normalizeWeaponUpdate
} from "../module/weapon-rules.mjs";

function fakeWeapon({ hands = 1, propertyIds = [], held = false, equipped = false } = {}) {
  return {
    type: "weapon",
    system: { hands, propertyIds: [...propertyIds], held, equipped, equippedAt: held ? 123 : 0 }
  };
}

// Complete source: any hands-free weapon is automatically Unarmed.
assert.deepEqual(
  normalizeWeaponSystem({ hands: 0, propertyIds: [] }),
  { hands: 0, propertyIds: [UNARMED_PROPERTY_ID] }
);

// Complete source: explicitly giving Unarmed to a weapon forces hands=0.
assert.deepEqual(
  normalizeWeaponSystem({ hands: 2, propertyIds: ["reach", UNARMED_PROPERTY_ID] }),
  { hands: 0, propertyIds: ["reach", UNARMED_PROPERTY_ID] }
);

// Adding hand requirements removes Unarmed.
{
  const weapon = fakeWeapon({ hands: 0, propertyIds: [UNARMED_PROPERTY_ID], equipped: true });
  const changes = { "system.hands": 1 };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes["system.hands"], 1);
  assert.deepEqual(changes["system.propertyIds"], []);
}

// Removing hand requirements adds Unarmed and clears held, but not equipped.
{
  const weapon = fakeWeapon({ hands: 1, propertyIds: [], held: true, equipped: true });
  const changes = { "system.hands": 0 };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes["system.hands"], 0);
  assert.deepEqual(changes["system.propertyIds"], [UNARMED_PROPERTY_ID]);
  assert.equal(changes["system.held"], false);
  assert.equal(changes["system.equippedAt"], 0);
  assert.equal(changes["system.equipped"], undefined);
}

// Giving Unarmed manually to a one-handed weapon zeroes its hand requirement.
{
  const weapon = fakeWeapon({ hands: 1, propertyIds: ["steady"], held: true, equipped: true });
  const changes = { "system.propertyIds": ["steady", UNARMED_PROPERTY_ID] };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes["system.hands"], 0);
  assert.deepEqual(changes["system.propertyIds"], ["steady", UNARMED_PROPERTY_ID]);
  assert.equal(changes["system.held"], false);
}

// Trying to remove Unarmed without adding a hand requirement immediately restores it.
{
  const weapon = fakeWeapon({ hands: 0, propertyIds: [UNARMED_PROPERTY_ID] });
  const changes = { "system.propertyIds": [] };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes["system.hands"], 0);
  assert.deepEqual(changes["system.propertyIds"], [UNARMED_PROPERTY_ID]);
}

// If both are changed at once and Unarmed is newly assigned, Unarmed wins.
{
  const weapon = fakeWeapon({ hands: 1, propertyIds: [] });
  const changes = {
    "system.hands": 2,
    "system.propertyIds": [UNARMED_PROPERTY_ID]
  };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes["system.hands"], 0);
  assert.deepEqual(changes["system.propertyIds"], [UNARMED_PROPERTY_ID]);
}

// Standard Actor weapon.
{
  const item = defaultUnarmedAttackData();
  assert.equal(item.name, DEFAULT_UNARMED_ATTACK_NAME);
  assert.equal(item.type, "weapon");
  assert.equal(item.system.hands, 0);
  assert.equal(item.system.equipped, true);
  assert.equal(item.system.held, false);
  assert.deepEqual(item.system.propertyIds, [UNARMED_PROPERTY_ID]);
  assert.equal(item.system.range, "Ближняя");
  assert.equal(item.system.damageType, "physical");
  assert.equal(item.system.damage.partial, "1d4");
  assert.equal(item.system.damage.success, "2d4");
  assert.equal(item.system.damage.great, "2d4+1");
}

// New Actor source gets exactly one standard attack; this is creation-only, not a migration.
{
  const actor = {
    type: "character",
    _source: { items: [] },
    updateSource(update) {
      if (update.items) this._source.items = update.items;
    }
  };

  assert.equal(addDefaultUnarmedAttackToActorSource(actor), true);
  assert.equal(actor._source.items.length, 1);
  assert.equal(actor._source.items[0].name, DEFAULT_UNARMED_ATTACK_NAME);

  assert.equal(addDefaultUnarmedAttackToActorSource(actor), false, "Повторный preCreate не должен дублировать атаку");
  assert.equal(actor._source.items.length, 1);
}

// Non Fast-NRI Actor type is untouched.
{
  const actor = {
    type: "other",
    _source: { items: [] },
    updateSource() { throw new Error("should not update"); }
  };
  assert.equal(addDefaultUnarmedAttackToActorSource(actor), false);
}

// Nested update payloads are normalized too.
{
  const weapon = fakeWeapon({ hands: 1, propertyIds: [] });
  const changes = { system: { propertyIds: [UNARMED_PROPERTY_ID] } };
  normalizeWeaponUpdate(weapon, changes);
  assert.equal(changes.system.hands, 0);
  assert.deepEqual(changes.system.propertyIds, [UNARMED_PROPERTY_ID]);
  assert.equal(changes.system.held, false);
}

console.log("unarmed-weapon-regression: OK");
