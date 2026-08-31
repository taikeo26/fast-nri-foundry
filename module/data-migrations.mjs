const DATA_MIGRATION_SETTING = "dataSchemaMigration";
const DATA_MIGRATION_VERSION = 1;
const EQUIPMENT_STATE_MIGRATION_SETTING = "equipmentStateMigration";
const EQUIPMENT_STATE_MIGRATION_VERSION = 1;

export function registerDataMigrationSettings() {
  game.settings.register(game.system.id, DATA_MIGRATION_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(game.system.id, EQUIPMENT_STATE_MIGRATION_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
}

/**
 * 0.5.14 replaces the three old fixed resistance fields with the common
 * trait+value model. Existing values are copied once, then the legacy fields
 * are zeroed so removing a resistance in the new UI does not make it return.
 */
export async function migrateDamageTraitsOnce() {
  if (!game.user.isGM) return;

  const current = Number(
    game.settings.get(game.system.id, DATA_MIGRATION_SETTING)
  ) || 0;
  if (current >= DATA_MIGRATION_VERSION) return;

  try {
    const updates = [];

    for (const actor of game.actors) {
      if (!["character", "creature"].includes(actor.type)) continue;

      const ids = new Set(actor.system?.resistanceIds ?? []);
      const values = {};
      const legacy = {
        universal: Number(actor.system?.resistances?.universal) || 0,
        physical: Number(actor.system?.resistances?.physical) || 0,
        magic: Number(actor.system?.resistances?.magic) || 0
      };

      let changed = false;
      for (const [id, value] of Object.entries(legacy)) {
        if (value <= 0) continue;
        ids.add(id);

        const currentValue = Number(actor.system?.resistanceValues?.[id]) || 0;
        if (currentValue <= 0) values[`system.resistanceValues.${id}`] = value;
        changed = true;
      }

      if (!changed) continue;

      updates.push({
        _id: actor.id,
        "system.resistanceIds": Array.from(ids),
        ...values,
        "system.resistances.universal": 0,
        "system.resistances.physical": 0,
        "system.resistances.magic": 0
      });
    }

    if (updates.length) await Actor.updateDocuments(updates);

    await game.settings.set(
      game.system.id,
      DATA_MIGRATION_SETTING,
      DATA_MIGRATION_VERSION
    );

    console.log(`Быстрая НРИ | Миграция Устойчивостей 0.5.14: ${updates.length} Actor(s).`);
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции Устойчивостей 0.5.14", error);
    ui.notifications.error("Не удалось перенести старые Устойчивости в новую модель.");
  }
}


/**
 * 0.5.30 разделяет старый флаг equipped на два отдельных состояния:
 * - equipped: Item активен и учитывается в системных расчётах;
 * - held: предмет физически находится в руках.
 *
 * В 0.5.29 equipped одновременно означал "одето / в руке", поэтому для
 * существующих Item с требованием рук старое значение переносится в held.
 * Начиная с 0.5.31 поля остаются раздельными, но пользовательские переключатели
 * согласуют их по правилам автоматизации удержания.
 */
export async function migrateEquipmentStateOnce() {
  if (!game.user.isGM) return;

  const current = Number(
    game.settings.get(game.system.id, EQUIPMENT_STATE_MIGRATION_SETTING)
  ) || 0;
  if (current >= EQUIPMENT_STATE_MIGRATION_VERSION) return;

  try {
    let embeddedCount = 0;
    let worldCount = 0;

    for (const actor of game.actors) {
      const updates = [];

      for (const item of actor.items) {
        if (!["weapon", "equipment"].includes(item.type)) continue;
        const rawHeld = foundry.utils.getProperty(item._source, "system.held");
        if (typeof rawHeld === "boolean") continue;

        const hands = Math.max(0, Math.min(2, Number(item.system?.hands) || 0));
        updates.push({
          _id: item.id,
          "system.held": hands > 0 && item.system?.equipped === true,
          "system.equippedAt": 0
        });
      }

      if (updates.length) {
        await actor.updateEmbeddedDocuments("Item", updates);
        embeddedCount += updates.length;
      }
    }

    const worldUpdates = [];
    for (const item of game.items) {
      if (!["weapon", "equipment"].includes(item.type)) continue;
      const rawHeld = foundry.utils.getProperty(item._source, "system.held");
      if (typeof rawHeld === "boolean") continue;

      const hands = Math.max(0, Math.min(2, Number(item.system?.hands) || 0));
      worldUpdates.push({
        _id: item.id,
        "system.held": hands > 0 && item.system?.equipped === true,
        "system.equippedAt": 0
      });
    }

    if (worldUpdates.length) {
      await Item.updateDocuments(worldUpdates);
      worldCount = worldUpdates.length;
    }

    await game.settings.set(
      game.system.id,
      EQUIPMENT_STATE_MIGRATION_SETTING,
      EQUIPMENT_STATE_MIGRATION_VERSION
    );

    console.log(
      `Быстрая НРИ | Миграция Экипирован/В руках 0.5.30: ${embeddedCount} embedded, ${worldCount} world Item(s).`
    );
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции Экипирован/В руках 0.5.30", error);
    ui.notifications.error("Не удалось разделить старые состояния «Экипирован» и «В руках».");
  }
}
