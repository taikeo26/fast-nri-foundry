import {
  inferAbilityAttackTypeFromDescription,
  inferWeaponAttackType,
  normalizeAttackType,
  normalizeSelfDefenseCharacteristic
} from "./attack-types.mjs";
import {
  directedAttackTypeFromTraits,
  inferLegacyAbilityActionTraits
} from "./check-system.mjs";

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

  game.settings.register(game.system.id, RULES_63_MIGRATION_SETTING, {
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

const RULES_63_MIGRATION_SETTING = "rules63AttackTypesMigration";
const RULES_63_MIGRATION_VERSION = 2;

function normalizeRussianName(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
}

function legacyAbilityAttackType(item) {
  const inferred = inferAbilityAttackTypeFromDescription(item?.system?.description);
  if (inferred) return inferred;

  const known = new Map([
    ["быстрый клинок", "melee"],
    ["хищная хватка", "melee"],
    ["разряд разлома", "ranged"]
  ]);

  return known.get(normalizeRussianName(item?.name)) ?? "";
}

function rules63ItemUpdate(item) {
  if (!item) return null;

  if (item.type === "weapon") {
    const raw = foundry.utils.getProperty(item._source, "system.attackType");
    if (normalizeAttackType(raw)) return null;

    const attackType = inferWeaponAttackType(item);
    return attackType ? { _id: item.id, "system.attackType": attackType } : null;
  }

  if (item.type === "ability" && item.system?.attackCheck?.enabled) {
    const update = { _id: item.id };
    const rawLegacyType = String(
      foundry.utils.getProperty(item._source, "system.attackCheck.attackType") ?? ""
    ).trim().toLowerCase();
    const inferredType = normalizeAttackType(rawLegacyType) || legacyAbilityAttackType(item);
    const traits = inferLegacyAbilityActionTraits(
      item.system?.description,
      rawLegacyType || inferredType
    );

    // Keep old melee/ranged data materialized for backwards compatibility.
    if (!normalizeAttackType(rawLegacyType) && inferredType) {
      update["system.attackCheck.attackType"] = inferredType;
    }

    // 0.5.52 universal Check. Legacy attackCheck was always a KZ check.
    update["system.check.enabled"] = true;
    update["system.check.formula"] = String(
      item.system?.attackCheck?.formula ?? "1d20 + {combatDie}"
    );
    update["system.check.targetCharacteristic"] = "armor";
    update["system.actionTraits.melee"] = traits.melee;
    update["system.actionTraits.ranged"] = traits.ranged;
    update["system.actionTraits.area"] = traits.area;
    update["system.actionTraits.intervention"] = traits.intervention;
    update["system.defenseProcedure.directedDefense"] = Boolean(
      item.system?.attackCheck?.directedDefense
    );

    return update;
  }

  return null;
}

/**
 * 0.5.50–0.5.52 / rules 6.3:
 * - materialize melee/ranged attack type on existing Weapon Items;
 * - migrate legacy Ability attackCheck into the universal Check model;
 * - split melee/ranged from the independent area action property;
 * - migrate the Rift Fairy's explicit rule: Self Defense always uses Reflex.
 *
 * Runtime never relies on the name after this one-time migration.
 */
export async function migrateRules63Once() {
  if (!game.user.isGM) return;

  const current = Number(
    game.settings.get(game.system.id, RULES_63_MIGRATION_SETTING)
  ) || 0;
  if (current >= RULES_63_MIGRATION_VERSION) return;

  try {
    let embeddedCount = 0;
    let worldItemCount = 0;
    let actorCount = 0;
    let unresolvedAbilities = 0;

    for (const actor of game.actors) {
      const itemUpdates = [];
      for (const item of actor.items) {
        const update = rules63ItemUpdate(item);
        if (update) itemUpdates.push(update);

        if (
          item.type === "ability"
          && item.system?.attackCheck?.enabled
          && item.system?.attackCheck?.directedDefense
          && !inferLegacyAbilityActionTraits(
            item.system?.description,
            item.system?.attackCheck?.attackType
          ).area
          && !directedAttackTypeFromTraits(inferLegacyAbilityActionTraits(
            item.system?.description,
            item.system?.attackCheck?.attackType || legacyAbilityAttackType(item)
          ))
        ) {
          unresolvedAbilities += 1;
        }
      }

      if (itemUpdates.length) {
        await actor.updateEmbeddedDocuments("Item", itemUpdates);
        embeddedCount += itemUpdates.length;
      }

      if (
        actor.type === "creature"
        && normalizeRussianName(actor.name) === "фея разлома"
        && normalizeSelfDefenseCharacteristic(
          foundry.utils.getProperty(actor._source, "system.selfDefenseCharacteristicOverride")
        ) !== "reflex"
      ) {
        await actor.update({ "system.selfDefenseCharacteristicOverride": "reflex" });
        actorCount += 1;
      }
    }

    const worldUpdates = [];
    for (const item of game.items) {
      const update = rules63ItemUpdate(item);
      if (update) worldUpdates.push(update);

      if (
        item.type === "ability"
        && item.system?.attackCheck?.enabled
        && item.system?.attackCheck?.directedDefense
        && !inferLegacyAbilityActionTraits(
          item.system?.description,
          item.system?.attackCheck?.attackType
        ).area
        && !directedAttackTypeFromTraits(inferLegacyAbilityActionTraits(
          item.system?.description,
          item.system?.attackCheck?.attackType || legacyAbilityAttackType(item)
        ))
      ) {
        unresolvedAbilities += 1;
      }
    }

    if (worldUpdates.length) {
      await Item.updateDocuments(worldUpdates);
      worldItemCount = worldUpdates.length;
    }

    await game.settings.set(
      game.system.id,
      RULES_63_MIGRATION_SETTING,
      RULES_63_MIGRATION_VERSION
    );

    console.log(
      `Быстрая НРИ | Миграция правил 6.3: ${embeddedCount} embedded Item, ` +
      `${worldItemCount} world Item, ${actorCount} Actor; ` +
      `${unresolvedAbilities} Ability требуют ручной разметки типа атаки.`
    );

    if (unresolvedAbilities > 0) {
      ui.notifications.warn(
        `Быстрая НРИ 6.3: ${unresolvedAbilities} атакующих Ability не удалось однозначно ` +
        `разметить как Ближние/Дистанционные. Проверьте поле «Вид исходной атаки 6.3».`
      );
    }
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции правил 6.3", error);
    ui.notifications.error("Не удалось завершить миграцию типов атак для правил 6.3.");
  }
}
