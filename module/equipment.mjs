function equippable(item) {
  return item?.type === "weapon" || item?.type === "equipment";
}

export function itemHands(item) {
  const value = Number(item?.system?.hands);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 2 ? 2 : 1;
}

export function itemRequiresHands(item) {
  return itemHands(item) > 0;
}

export function itemIsEquipped(item) {
  return equippable(item) && item?.system?.equipped === true;
}

export function itemIsHeld(item) {
  return equippable(item)
    && itemRequiresHands(item)
    && item?.system?.held === true;
}

/**
 * Предмет участвует в системном использовании только если он Экипирован.
 * Если предмет требует рук, он дополнительно должен находиться В руках.
 */
export function itemIsUsable(item) {
  if (!itemIsEquipped(item)) return false;
  return !itemRequiresHands(item) || itemIsHeld(item);
}

function actorItems(actor) {
  return actor?.items?.contents ?? Array.from(actor?.items ?? []);
}

/**
 * Внутренний маркер порядка удержания. Поле equippedAt сохранено ради
 * совместимости старых документов; для предметов, требующих рук, теперь оно
 * отмечает момент, когда предмет фактически оказался В руках.
 */
function heldAge(item) {
  const value = Number(item?.system?.equippedAt);
  return Number.isFinite(value) ? value : 0;
}

function stableOldestHeldFirst(a, b) {
  const age = heldAge(a) - heldAge(b);
  if (age !== 0) return age;

  const sort = Number(a?.sort ?? 0) - Number(b?.sort ?? 0);
  if (sort !== 0) return sort;

  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}

export function heldHandsTotal(actor, { excludeItemId = null } = {}) {
  if (!actor) return 0;

  return actorItems(actor).reduce((total, item) => {
    if (!equippable(item) || item.id === excludeItemId) return total;
    if (!itemIsHeld(item)) return total;
    return total + itemHands(item);
  }, 0);
}

export function freeHands(actor, { excludeItemId = null } = {}) {
  return Math.max(0, 2 - heldHandsTotal(actor, { excludeItemId }));
}

async function updateActorItems(actor, updates) {
  if (!updates.length) return [];
  return actor.updateEmbeddedDocuments("Item", updates);
}

function releaseUpdate(item) {
  return {
    _id: item.id,
    "system.held": false,
    "system.equipped": false,
    "system.equippedAt": 0
  };
}

function holdUpdate(item, timestamp = Date.now()) {
  return {
    _id: item.id,
    "system.held": true,
    "system.equipped": true,
    "system.equippedAt": timestamp
  };
}

/**
 * Изменить состояние Экипирован.
 *
 * Предмет без требования рук просто переключает equipped.
 * Предмет, требующий руки:
 * - снятие equipped также выпускает его из рук;
 * - включение equipped автоматически берёт его в руки только если места хватает;
 * - если рук не хватает, состояние не меняется и другие предметы не вытесняются.
 */
export async function setItemEquipped(item, equipped) {
  if (!item || !equippable(item)) return null;

  const wantsEquipped = Boolean(equipped);
  const actor = item.parent;
  const requiresHands = itemRequiresHands(item);

  // World/Compendium Item: рук Actor нет. Храним только редактируемое состояние.
  if (!actor || actor.documentName !== "Actor") {
    const update = { "system.equipped": wantsEquipped };
    if (!wantsEquipped && requiresHands) {
      update["system.held"] = false;
      update["system.equippedAt"] = 0;
    }
    if (!requiresHands && item.system?.held === true) update["system.held"] = false;
    await item.update(update);
    return item;
  }

  if (!wantsEquipped) {
    await updateActorItems(actor, [releaseUpdate(item)]);
    return actor.items.get?.(item.id) ?? item;
  }

  if (!requiresHands) {
    await updateActorItems(actor, [{
      _id: item.id,
      "system.equipped": true,
      "system.held": false,
      "system.equippedAt": 0
    }]);
    return actor.items.get?.(item.id) ?? item;
  }

  // Уже находится в руках: достаточно вернуть активность.
  if (itemIsHeld(item)) {
    await updateActorItems(actor, [{
      _id: item.id,
      "system.equipped": true
    }]);
    return actor.items.get?.(item.id) ?? item;
  }

  // В отличие от прямой команды "В руках", экипировка никого не вытесняет.
  if (freeHands(actor, { excludeItemId: item.id }) < itemHands(item)) {
    return actor.items.get?.(item.id) ?? item;
  }

  await updateActorItems(actor, [holdUpdate(item)]);
  return actor.items.get?.(item.id) ?? item;
}

/**
 * Изменить состояние В руках.
 *
 * Взять предмет в руки всегда включает Экипирован.
 * - 2 руки: освобождает и разэкипирует все остальные предметы, требующие рук;
 * - 1 рука: при переполнении снимает самые давно взятые предметы до появления места.
 *
 * Выпустить предмет из рук всегда снимает Экипирован, если предмет требует рук.
 */
export async function setItemHeld(item, held) {
  if (!item || !equippable(item)) return null;

  const wantsHeld = Boolean(held);
  const actor = item.parent;

  if (!itemRequiresHands(item)) {
    if (item.system?.held === true) await item.update({ "system.held": false });
    return item;
  }

  if (!actor || actor.documentName !== "Actor") {
    await item.update({
      "system.held": wantsHeld,
      "system.equipped": wantsHeld,
      "system.equippedAt": wantsHeld ? Date.now() : 0
    });
    return item;
  }

  if (!wantsHeld) {
    await updateActorItems(actor, [releaseUpdate(item)]);
    return actor.items.get?.(item.id) ?? item;
  }

  const current = actorItems(actor)
    .filter(other => other.id !== item.id && equippable(other));

  const updates = [];
  const hands = itemHands(item);

  if (hands === 2) {
    // Двуручный предмет занимает обе руки и полностью освобождает остальные.
    for (const other of current) {
      if (!itemRequiresHands(other)) continue;
      if (!itemIsHeld(other) && !itemIsEquipped(other)) continue;
      updates.push(releaseUpdate(other));
    }
  } else {
    let usedHands = heldHandsTotal(actor, { excludeItemId: item.id });

    if (usedHands >= 2) {
      const heldOthers = current
        .filter(other => itemIsHeld(other))
        .sort(stableOldestHeldFirst);

      while (usedHands + 1 > 2 && heldOthers.length) {
        const oldest = heldOthers.shift();
        updates.push(releaseUpdate(oldest));
        usedHands -= itemHands(oldest);
      }
    }
  }

  updates.push(holdUpdate(item));
  await updateActorItems(actor, updates);
  return actor.items.get?.(item.id) ?? item;
}

export async function setItemHands(item, hands) {
  if (!item || !equippable(item)) return null;

  const numeric = Number(hands);
  const normalized = !Number.isFinite(numeric) || numeric <= 0
    ? 0
    : numeric >= 2 ? 2 : 1;

  const wasHeld = itemIsHeld(item);
  const wasEquipped = itemIsEquipped(item);

  const update = { "system.hands": normalized };

  if (normalized === 0) {
    update["system.held"] = false;
    update["system.equippedAt"] = 0;
  }

  await item.update(update);

  // Изменение количества рук у уже удерживаемого предмета должно немедленно
  // привести руки к валидному состоянию по тем же правилам удержания.
  if (normalized > 0 && wasHeld) {
    return setItemHeld(item, true);
  }

  // Предмет был активен без рук, но после редактирования стал требовать руки.
  // Пытаемся взять его только при наличии места; при нехватке он перестаёт быть
  // Экипированным, не вытесняя другие предметы.
  if (normalized > 0 && wasEquipped && !itemIsHeld(item)) {
    const actor = item.parent;
    if (actor?.documentName === "Actor" && freeHands(actor, { excludeItemId: item.id }) < normalized) {
      await item.update({
        "system.equipped": false,
        "system.held": false,
        "system.equippedAt": 0
      });
      return item;
    }
    return setItemEquipped(item, true);
  }

  return item;
}
