const DATA_MIGRATION_SETTING = "dataSchemaMigration";
const DATA_MIGRATION_VERSION = 1;

export function registerDataMigrationSettings() {
  game.settings.register(game.system.id, DATA_MIGRATION_SETTING, {
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
