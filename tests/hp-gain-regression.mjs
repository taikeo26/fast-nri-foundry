import assert from "node:assert/strict";

globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    escapeHTML: value => String(value),
    getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object)
  }
};

const { resolveHpGainAgainstActor, resolveTemporaryHp } = await import("../module/health-actions.mjs");

function actor({ reductions = {}, bonuses = {}, immunities = [], damageImmunities = [] } = {}) {
  return {
    system: {
      hpGainReductionIds: Object.keys(reductions),
      hpGainReductionValues: reductions,
      hpGainBonusIds: Object.keys(bonuses),
      hpGainBonusValues: bonuses,
      hpGainImmunityIds: immunities,
      // Должны быть полностью проигнорированы каналом Получения HP.
      immunityIds: damageImmunities
    }
  };
}

function part(id, value, traits = []) {
  return {
    id,
    kind: "die",
    faces: 6,
    value,
    rolledValue: value,
    currentValue: value,
    traitIds: traits,
    immuneRemoved: false
  };
}

function state(parts, penalty = 0) {
  return {
    supported: true,
    parts,
    penalties: penalty > 0 ? [{ id: "p", value: penalty, currentValue: penalty }] : []
  };
}

// 1. Один общий канал: свойства разных частей дают один лучший Снижающий
//    модификатор и один лучший Бонус на всё Получение HP.
{
  const result = resolveHpGainAgainstActor(
    state([
      part("holy", 5, ["holy"]),
      part("healing", 3, ["healing"])
    ]),
    actor({
      reductions: { holy: 2, healing: 4 },
      bonuses: { holy: 3, healing: 1 }
    })
  );

  assert.equal(result.partsTotal, 8);
  assert.equal(result.reduction?.id, "healing");
  assert.equal(result.reduction?.value, 4);
  assert.equal(result.bonus?.id, "holy");
  assert.equal(result.bonus?.value, 3);
  assert.equal(result.finalAmount, 7); // 8 - 4 + 3
}

// 2. Иммунитет Получения HP удаляет только совпавшую часть и её свойства.
{
  const result = resolveHpGainAgainstActor(
    state([
      part("holy", 5, ["holy"]),
      part("healing", 3, ["healing"])
    ]),
    actor({
      immunities: ["holy"],
      bonuses: { holy: 10, healing: 2 }
    })
  );

  assert.equal(result.immuneParts.length, 1);
  assert.equal(result.immuneParts[0].id, "holy");
  assert.equal(result.activeMatchIds.includes("holy"), false);
  assert.equal(result.bonus?.id, "healing");
  assert.equal(result.finalAmount, 5); // 3 + 2
}

// 3. Защиты от урона не влияют на Получение HP.
{
  const result = resolveHpGainAgainstActor(
    state([part("holy", 5, ["holy"])]),
    actor({ damageImmunities: ["holy"] })
  );
  assert.equal(result.finalAmount, 5);
}

// 4. Универсальное Снижение конкурирует за тот же один слот.
{
  const result = resolveHpGainAgainstActor(
    state([part("healing", 6, ["healing"])]),
    actor({ reductions: { universal: 4, healing: 2 } })
  );
  assert.equal(result.reduction?.id, "universal");
  assert.equal(result.finalAmount, 2);
}

// 5. Бонус срабатывает после Снижения и может создать положительный итог.
{
  const result = resolveHpGainAgainstActor(
    state([part("holy", 2, ["holy"])]),
    actor({ reductions: { holy: 5 }, bonuses: { holy: 3 } })
  );
  assert.equal(result.afterReduction, 0);
  assert.equal(result.finalAmount, 3);
}

// 6. Временные HP не складываются: сохраняется большее значение.
assert.equal(resolveTemporaryHp(3, 5), 5);
assert.equal(resolveTemporaryHp(7, 5), 7);
assert.equal(resolveTemporaryHp(0, 4), 4);

console.log("hp-gain-regression: OK");
