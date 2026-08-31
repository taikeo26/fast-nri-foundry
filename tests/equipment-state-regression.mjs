import assert from "node:assert/strict";
import {
  freeHands,
  heldHandsTotal,
  itemHands,
  itemIsEquipped,
  itemIsHeld,
  itemIsUsable,
  itemRequiresHands,
  setItemEquipped,
  setItemHands,
  setItemHeld
} from "../module/equipment.mjs";

function fakeItem({
  id = "item",
  type = "weapon",
  equipped = false,
  held = false,
  hands = 1,
  equippedAt = 0,
  sort = 0
} = {}) {
  return {
    id,
    type,
    sort,
    parent: null,
    system: { equipped, held, hands, equippedAt },
    async update(update) {
      for (const [key, value] of Object.entries(update)) {
        if (key === "system.equipped") this.system.equipped = value;
        if (key === "system.held") this.system.held = value;
        if (key === "system.hands") this.system.hands = value;
        if (key === "system.equippedAt") this.system.equippedAt = value;
      }
      return this;
    }
  };
}

function fakeActor(...items) {
  const actor = {
    documentName: "Actor",
    items,
    async updateEmbeddedDocuments(_type, updates) {
      const changed = [];
      for (const update of updates) {
        const item = items.find(entry => entry.id === update._id);
        assert.ok(item, `Unknown item ${update._id}`);
        const payload = { ...update };
        delete payload._id;
        await item.update(payload);
        changed.push(item);
      }
      return changed;
    }
  };
  items.contents = items;
  items.get = id => items.find(item => item.id === id) ?? null;
  for (const item of items) item.parent = actor;
  return actor;
}

// Предмет без рук: held неприменим, equipped работает самостоятельно.
const freeItem = fakeItem({ id: "armor", type: "equipment", hands: 0, equipped: false, held: false });
fakeActor(freeItem);
assert.equal(itemHands(freeItem), 0);
assert.equal(itemRequiresHands(freeItem), false);
await setItemEquipped(freeItem, true);
assert.equal(freeItem.system.equipped, true);
assert.equal(freeItem.system.held, false);
assert.equal(itemIsHeld(freeItem), false);
assert.equal(itemIsUsable(freeItem), true);

// Экипирование предмета, требующего руку, автоматически берёт его в руки,
// если место свободно.
const sword = fakeItem({ id: "sword", hands: 1 });
const swordActor = fakeActor(sword);
await setItemEquipped(sword, true);
assert.equal(itemIsEquipped(sword), true);
assert.equal(itemIsHeld(sword), true);
assert.equal(itemIsUsable(sword), true);
assert.equal(heldHandsTotal(swordActor), 1);
assert.equal(freeHands(swordActor), 1);

// Снятие equipped выпускает предмет из рук.
await setItemEquipped(sword, false);
assert.equal(sword.system.equipped, false);
assert.equal(sword.system.held, false);
assert.equal(heldHandsTotal(swordActor), 0);

// Снятие held также снимает equipped.
await setItemHeld(sword, true);
assert.equal(sword.system.equipped, true);
assert.equal(sword.system.held, true);
await setItemHeld(sword, false);
assert.equal(sword.system.equipped, false);
assert.equal(sword.system.held, false);

// Две занятые руки: попытка просто Экипировать третий одноручный предмет
// должна провалиться без вытеснения текущих предметов.
const first = fakeItem({ id: "first", hands: 1, equipped: true, held: true, equippedAt: 100, sort: 10 });
const second = fakeItem({ id: "second", hands: 1, equipped: true, held: true, equippedAt: 200, sort: 20 });
const third = fakeItem({ id: "third", hands: 1, equipped: false, held: false, sort: 30 });
const oneHandActor = fakeActor(first, second, third);
assert.equal(heldHandsTotal(oneHandActor), 2);
await setItemEquipped(third, true);
assert.equal(third.system.equipped, false, "Экипировка при занятых руках не должна включаться");
assert.equal(third.system.held, false);
assert.equal(first.system.equipped, true);
assert.equal(first.system.held, true);
assert.equal(second.system.equipped, true);
assert.equal(second.system.held, true);

// Прямая команда «В руках» для третьего одноручного вытесняет самый давно
// взятый предмет и одновременно экипирует новый.
await setItemHeld(third, true);
assert.equal(first.system.equipped, false, "Самый старый предмет должен быть разэкипирован");
assert.equal(first.system.held, false, "Самый старый предмет должен быть выпущен из рук");
assert.equal(second.system.equipped, true);
assert.equal(second.system.held, true);
assert.equal(third.system.equipped, true);
assert.equal(third.system.held, true);
assert.equal(heldHandsTotal(oneHandActor), 2);

// Двуручный предмет через «В руках» освобождает обе руки и разэкипирует всё
// остальное, что требует рук.
const greatsword = fakeItem({ id: "greatsword", hands: 2, equipped: false, held: false });
oneHandActor.items.push(greatsword);
greatsword.parent = oneHandActor;
await setItemHeld(greatsword, true);
assert.equal(second.system.equipped, false);
assert.equal(second.system.held, false);
assert.equal(third.system.equipped, false);
assert.equal(third.system.held, false);
assert.equal(greatsword.system.equipped, true);
assert.equal(greatsword.system.held, true);
assert.equal(heldHandsTotal(oneHandActor), 2);

// При занятой двуручным вещи попытка просто экипировать одноручную ничего не
// меняет в руках.
await setItemEquipped(first, true);
assert.equal(first.system.equipped, false);
assert.equal(first.system.held, false);
assert.equal(greatsword.system.equipped, true);
assert.equal(greatsword.system.held, true);

// Но прямое «В руках» для одноручного вытесняет двуручный предмет.
await setItemHeld(first, true);
assert.equal(greatsword.system.equipped, false);
assert.equal(greatsword.system.held, false);
assert.equal(first.system.equipped, true);
assert.equal(first.system.held, true);
assert.equal(heldHandsTotal(oneHandActor), 1);

// Изменение предмета на 0 рук очищает held, но сохраняет equipped.
await setItemHands(first, 0);
assert.equal(first.system.hands, 0);
assert.equal(first.system.held, false);
assert.equal(first.system.equipped, true);
assert.equal(itemIsUsable(first), true);

console.log("equipment-state-regression: OK");
