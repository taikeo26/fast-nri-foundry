import assert from "node:assert/strict";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    escapeHTML: value => String(value)
  }
};

const { resolveDamageAgainstActor } = await import("../module/rolls.mjs");

function actor({
  resistances = {},
  vulnerabilities = {},
  immunities = []
} = {}) {
  return {
    system: {
      immunityIds: immunities,
      resistanceIds: Object.keys(resistances),
      resistanceValues: resistances,
      vulnerabilityIds: Object.keys(vulnerabilities),
      vulnerabilityValues: vulnerabilities,
      resistances: {
        universal: 0,
        physical: 0,
        magic: 0
      }
    }
  };
}

function part(id, value, damageType, traitIds = []) {
  return {
    id,
    kind: "die",
    faces: 6,
    value,
    currentValue: value,
    damageType,
    traitIds,
    immuneRemoved: false
  };
}

function state(parts, extra = {}) {
  return {
    supported: true,
    parts,
    penalties: [],
    fullCancel: false,
    ...extra
  };
}

// 1. Разные свойства на разных кубах: одна лучшая Устойчивость и
//    одна лучшая Уязвимость применяются ко ВСЕЙ сумме один раз.
{
  const result = resolveDamageAgainstActor(
    state([
      part("fire", 4, "physical", ["fire"]),
      part("poison", 3, "physical", ["poison"]),
      part("zero-fire", 0, "magic", ["fire"])
    ]),
    actor({
      resistances: { fire: 4, poison: 2, physical: 3 },
      vulnerabilities: { poison: 5, magic: 2 }
    })
  );

  assert.equal(result.partsTotal, 7);
  assert.equal(result.resistance?.id, "fire");
  assert.equal(result.resistance?.value, 4);
  assert.equal(result.vulnerability?.id, "poison");
  assert.equal(result.vulnerability?.value, 5);
  assert.equal(result.finalDamage, 8); // 7 - 4 + 5
}

// 2. Куб с 0 после Самозащиты сохраняет свойство и может активировать
//    Уязвимость. Устойчивость сначала упирается в 0, потом Уязвимость
//    создаёт положительный урон.
{
  const zeroed = part("zero-fire", 0, "physical", ["fire"]);
  zeroed.defenseZeroed = true;

  const result = resolveDamageAgainstActor(
    state([zeroed]),
    actor({
      resistances: { fire: 3 },
      vulnerabilities: { fire: 5 }
    })
  );

  assert.equal(result.partsTotal, 0);
  assert.equal(result.resistance?.value, 3);
  assert.equal(result.vulnerability?.value, 5);
  assert.equal(result.finalDamage, 5);
}

// 3. Иммунитет удаляет конкретный куб и вместе с ним все его свойства.
//    Яд с удалённого куба больше не может дать Уязвимость.
{
  const result = resolveDamageAgainstActor(
    state([
      part("fire", 4, "physical", ["fire"]),
      part("poison", 3, "physical", ["poison"])
    ]),
    actor({
      resistances: { fire: 2 },
      vulnerabilities: { poison: 9 },
      immunities: ["poison"]
    })
  );

  assert.equal(result.immuneParts.length, 1);
  assert.equal(result.immuneParts[0].id, "poison");
  assert.equal(result.activeMatchIds.includes("poison"), false);
  assert.equal(result.vulnerability, null);
  assert.equal(result.finalDamage, 2); // 4 - 2
}

// 4. Универсальная Устойчивость конкурирует с профильными за один
//    единственный слот Устойчивости всего нанесения.
{
  const result = resolveDamageAgainstActor(
    state([
      part("fire", 5, "physical", ["fire"]),
      part("magic", 4, "magic", [])
    ]),
    actor({
      resistances: { universal: 6, fire: 4, magic: 3 }
    })
  );

  assert.equal(result.resistance?.id, "universal");
  assert.equal(result.finalDamage, 3); // 9 - 6
}

// 5. Полная отмена Защитой не должна позволять Уязвимости заново
//    «оживить» старые части при нажатии Нанести.
{
  const result = resolveDamageAgainstActor(
    state(
      [part("fire", 6, "physical", ["fire"])],
      { fullCancel: true }
    ),
    actor({
      vulnerabilities: { fire: 10 }
    })
  );

  assert.equal(result.finalDamage, 0);
  assert.equal(result.survivingParts.length, 0);
  assert.equal(result.vulnerability, null);
}

console.log("damage-resolution-regression: OK");
