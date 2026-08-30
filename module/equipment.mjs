function equippable(item) {
  return item?.type === "weapon" || item?.type === "equipment";
}

function itemHands(item) {
  return Number(item?.system?.hands) >= 2 ? 2 : 1;
}

function equipAge(item) {
  const value = Number(item?.system?.equippedAt);
  return Number.isFinite(value) ? value : 0;
}

function stableOldestFirst(a, b) {
  const age = equipAge(a) - equipAge(b);
  if (age !== 0) return age;

  const sort = Number(a?.sort ?? 0) - Number(b?.sort ?? 0);
  if (sort !== 0) return sort;

  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

export async function setItemEquipped(item, equipped) {
  if (!item || !equippable(item)) return null;

  const actor = item.parent;
  const wantsEquipped = Boolean(equipped);

  // World Item / compendium-like Item without Actor parent:
  // store the flag, but there are no Actor hands to normalize.
  if (!actor || actor.documentName !== "Actor") {
    await item.update({
      "system.equipped": wantsEquipped,
      "system.equippedAt": wantsEquipped ? Date.now() : 0
    });
    return item;
  }

  if (!wantsEquipped) {
    await actor.updateEmbeddedDocuments("Item", [{
      _id: item.id,
      "system.equipped": false,
      "system.equippedAt": 0
    }]);
    return actor.items.get(item.id);
  }

  const current = Array.from(actor.items)
    .filter(other =>
      other.id !== item.id
      && equippable(other)
      && other.system?.equipped === true
    );

  const updates = [];
  const hands = itemHands(item);

  if (hands === 2) {
    // Двуручный предмет освобождает обе руки.
    for (const other of current) {
      updates.push({
        _id: other.id,
        "system.equipped": false,
        "system.equippedAt": 0
      });
    }
  } else {
    // Одноручный предмет снимает любой текущий двуручный.
    for (const other of current.filter(other => itemHands(other) === 2)) {
      updates.push({
        _id: other.id,
        "system.equipped": false,
        "system.equippedAt": 0
      });
    }

    const stillEquippedOneHanded = current
      .filter(other => itemHands(other) === 1)
      .filter(other => !updates.some(update => update._id === other.id))
      .sort(stableOldestFirst);

    // Перед экипировкой нового одноручного должна остаться максимум одна
    // занятая рука. Если их две, снимаем самый давно экипированный предмет.
    while (stillEquippedOneHanded.length >= 2) {
      const oldest = stillEquippedOneHanded.shift();
      updates.push({
        _id: oldest.id,
        "system.equipped": false,
        "system.equippedAt": 0
      });
    }
  }

  updates.push({
    _id: item.id,
    "system.equipped": true,
    "system.equippedAt": Date.now()
  });

  await actor.updateEmbeddedDocuments("Item", updates);
  return actor.items.get(item.id);
}

export async function setItemHands(item, hands) {
  if (!item || !equippable(item)) return null;

  const normalized = Number(hands) >= 2 ? 2 : 1;
  await item.update({ "system.hands": normalized });

  // Если Item уже одет, немедленно нормализуем занятые руки.
  if (item.system?.equipped === true) {
    return setItemEquipped(item, true);
  }

  return item;
}
