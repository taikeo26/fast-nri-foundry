import {
  inferAbilityAttackTypeFromDescription,
  normalizeAttackType,
  normalizeSelfDefenseCharacteristic
} from "./attack-types.mjs";
import {
  directedAttackTypeFromTraits,
  inferLegacyAbilityActionTraits
} from "./check-system.mjs";
import {
  legacyWeaponTypeIdFromName,
  normalizeActorWeaponTraining,
  normalizeWeaponTypeId,
  weaponCategoryIdForType
} from "./weapon-taxonomy.mjs";

const DATA_MIGRATION_SETTING = "dataSchemaMigration";
const DATA_MIGRATION_VERSION = 1;
const EQUIPMENT_STATE_MIGRATION_SETTING = "equipmentStateMigration";
const EQUIPMENT_STATE_MIGRATION_VERSION = 1;
const WEAPON_TAXONOMY_MIGRATION_SETTING = "weaponTaxonomyMigration";
const WEAPON_TAXONOMY_MIGRATION_VERSION = 1;

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

  game.settings.register(game.system.id, WEAPON_TAXONOMY_MIGRATION_SETTING, {
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

function weaponTaxonomyItemUpdate(item) {
  if (!item || item.type !== "weapon") return null;

  const storedTypeId = normalizeWeaponTypeId(
    foundry.utils.getProperty(item._source, "system.typeId")
  );
  const typeId = storedTypeId || legacyWeaponTypeIdFromName(item.name);
  const categoryId = weaponCategoryIdForType(typeId);
  const rawTypeId = String(foundry.utils.getProperty(item._source, "system.typeId") ?? "");
  const rawCategoryId = String(foundry.utils.getProperty(item._source, "system.categoryId") ?? "");

  if (rawTypeId === typeId && rawCategoryId === categoryId) return null;
  return {
    _id: item.id,
    "system.typeId": typeId,
    "system.categoryId": categoryId
  };
}

/**
 * 0.5.56: materialize structured weapon taxonomy and Actor weapon training.
 * Exact Item-name matching is migration-only; runtime never infers taxonomy
 * from a name or description. Unknown legacy weapons remain untyped.
 */
export async function migrateWeaponTaxonomyOnce() {
  if (!game.user.isGM) return;

  const current = Number(
    game.settings.get(game.system.id, WEAPON_TAXONOMY_MIGRATION_SETTING)
  ) || 0;
  if (current >= WEAPON_TAXONOMY_MIGRATION_VERSION) return;

  try {
    let embeddedCount = 0;
    let worldCount = 0;
    let actorCount = 0;

    for (const actor of game.actors) {
      if (actor.type === "character") {
        const training = normalizeActorWeaponTraining(actor.system ?? {});
        const currentProficiencies = Array.from(actor.system?.weaponProficiencyIds ?? []);
        const currentMasteries = Array.from(actor.system?.weaponMasteryIds ?? []);
        if (
          JSON.stringify(currentProficiencies) !== JSON.stringify(training.weaponProficiencyIds)
          || JSON.stringify(currentMasteries) !== JSON.stringify(training.weaponMasteryIds)
        ) {
          await actor.update({
            "system.weaponProficiencyIds": training.weaponProficiencyIds,
            "system.weaponMasteryIds": training.weaponMasteryIds
          });
          actorCount += 1;
        }
      }

      const updates = [];
      for (const item of actor.items) {
        const update = weaponTaxonomyItemUpdate(item);
        if (update) updates.push(update);
      }
      if (updates.length) {
        await actor.updateEmbeddedDocuments("Item", updates);
        embeddedCount += updates.length;
      }
    }

    const worldUpdates = [];
    for (const item of game.items) {
      const update = weaponTaxonomyItemUpdate(item);
      if (update) worldUpdates.push(update);
    }
    if (worldUpdates.length) {
      await Item.updateDocuments(worldUpdates);
      worldCount = worldUpdates.length;
    }

    await game.settings.set(
      game.system.id,
      WEAPON_TAXONOMY_MIGRATION_SETTING,
      WEAPON_TAXONOMY_MIGRATION_VERSION
    );

    console.log(
      `Быстрая НРИ | Миграция оружейной таксономии 0.5.56: ${embeddedCount} embedded, ${worldCount} world Weapon, ${actorCount} Actor(s).`
    );
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции оружейной таксономии 0.5.56", error);
    ui.notifications.error("Не удалось завершить миграцию типов оружия 0.5.56.");
  }
}

const RULES_63_MIGRATION_SETTING = "rules63AttackTypesMigration";
const RULES_63_MIGRATION_VERSION = 6;

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

    // 0.5.52: legacy/empty weapon attack type is removed. Every old weapon
    // without an explicit valid type is migrated to melee; ranged is only
    // preserved when it was explicitly stored as ranged.
    return { _id: item.id, "system.attackType": "melee" };
  }

  if (item.type === "ability") {
    const update = { _id: item.id };

    // 0.5.55.2: Ability becomes a container of self-contained executable
    // implementations. Existing structured data is copied deterministically;
    // no prose is parsed. A legacy variable class-resource range becomes one
    // implementation per stored price so the old choice remains explicit.
    const rawImplementations = foundry.utils.getProperty(item._source, "system.implementations");
    if (!Array.isArray(rawImplementations) || rawImplementations.length === 0) {
      const source = item.system ?? {};
      const rawCosts = source.costs ?? {};
      const legacyCost = Math.max(0, Math.trunc(Number(source.classResourceCost) || 0));
      const min = Math.max(0, Math.trunc(Number(rawCosts.classResourceMin) || legacyCost));
      const max = Math.max(min, Math.trunc(Number(rawCosts.classResourceMax) || min));
      const costs = [];
      for (let amount = min; amount <= max; amount += 1) costs.push(amount);
      if (!costs.length) costs.push(0);
      const baseTraits = new Set(Array.from(source.traitIds ?? []));
      if (source.category === "spell") baseTraits.add("spell");
      if (source.actionTraits?.melee) baseTraits.add("melee");
      if (source.actionTraits?.ranged) baseTraits.add("ranged");
      if (source.actionTraits?.area) baseTraits.add("area");
      if (source.actionTraits?.intervention) baseTraits.add("intervention");
      if (source.defenseAction?.enabled) baseTraits.add("defensive");

      // Worlds which jump directly from the legacy attackCheck model must not
      // lose their executable Check merely because top-level 0.5.52 fields are
      // materialized later in this same migration pass. Use only structured
      // legacy fields here; runtime still never parses prose.
      if (source.attackCheck?.enabled) {
        const legacyAttackType = normalizeAttackType(source.attackCheck?.attackType);
        if (legacyAttackType) baseTraits.add(legacyAttackType);
        baseTraits.add("attack");
      }
      const implementationCheck = source.check?.enabled
        ? foundry.utils.deepClone(source.check)
        : source.attackCheck?.enabled
          ? {
              enabled: true,
              formula: String(source.attackCheck?.formula ?? "1d20 + {combatDie}"),
              targetCharacteristic: "armor"
            }
          : foundry.utils.deepClone(source.check ?? {});
      const implementationDefenseProcedure = foundry.utils.deepClone(source.defenseProcedure ?? {});
      if (source.attackCheck?.enabled && implementationDefenseProcedure.directedDefense == null) {
        implementationDefenseProcedure.directedDefense = Boolean(source.attackCheck?.directedDefense);
      }

      update["system.implementations"] = costs.map((amount, index) => ({
        id: globalThis.foundry?.utils?.randomID?.() ?? `legacy${item.id}${index}`.slice(0, 16),
        name: costs.length > 1 ? `Реализация — ${amount} ресурса` : "Основная реализация",
        description: "",
        traitIds: Array.from(baseTraits),
        costs: {
          action: Math.max(0, Math.trunc(Number(rawCosts.action) || 0)),
          movement: Math.max(0, Math.trunc(Number(rawCosts.movement) || 0)),
          intervention: Math.max(0, Math.trunc(Number(rawCosts.intervention) || 0)),
          freeAction: Boolean(rawCosts.freeAction),
          classResource: amount,
          additionalText: String(rawCosts.additionalText ?? "")
        },
        targeting: foundry.utils.deepClone(source.targeting ?? {}),
        conditionText: String(source.conditionText ?? ""),
        requirementText: String(source.requirementText ?? ""),
        limitationText: String(source.limitationText ?? ""),
        exceptionText: String(source.exceptionText ?? ""),
        check: foundry.utils.deepClone(implementationCheck),
        defenseProcedure: foundry.utils.deepClone(implementationDefenseProcedure),
        profiles: foundry.utils.deepClone(source.profiles ?? {}),
        outcomes: foundry.utils.deepClone(source.outcomes ?? {}),
        defenseAction: foundry.utils.deepClone(source.defenseAction ?? {}),
        effectUuids: Array.from(source.effectUuids ?? []),
        repeat: { count: 1, label: "Результат" }
      }));
    }

    // 0.5.55: materialize the new authoring fields from existing structured
    // data. No prose is parsed here. category/actionTraits/defenseAction are
    // deterministic sources which existed before the new editor.
    const rawTraitIds = foundry.utils.getProperty(item._source, "system.traitIds");
    if (!Array.isArray(rawTraitIds)) {
      const ids = new Set();
      if (item.system?.category === "spell") ids.add("spell");
      if (item.system?.actionTraits?.melee) ids.add("melee");
      if (item.system?.actionTraits?.ranged) ids.add("ranged");
      if (item.system?.actionTraits?.area) ids.add("area");
      if (item.system?.actionTraits?.intervention) ids.add("intervention");
      if (item.system?.defenseAction?.enabled) ids.add("defensive");
      update["system.traitIds"] = Array.from(ids);
    }

    const rawCosts = foundry.utils.getProperty(item._source, "system.costs");
    if (!rawCosts || typeof rawCosts !== "object") {
      const legacyCost = Math.max(0, Math.trunc(Number(item.system?.classResourceCost) || 0));
      update["system.costs.classResourceMin"] = legacyCost;
      update["system.costs.classResourceMax"] = legacyCost;
    }

    // 0.5.53: every existing Defense Ability receives an explicit procedure.
    // All defense infrastructure which existed before 0.5.53 implemented the
    // Directed Defense rules, so the migration is deterministic and does not
    // infer anything from the description.
    const rawProcedure = String(
      foundry.utils.getProperty(item._source, "system.defenseAction.procedure") ?? ""
    ).trim();
    if (item.system?.defenseAction?.enabled && !["directed", "counteraction", "dodge"].includes(rawProcedure)) {
      update["system.defenseAction.procedure"] = "directed";
    }

    if (item.system?.attackCheck?.enabled) {
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
    }

    return Object.keys(update).length > 1 ? update : null;
  }

  return null;
}

/**
 * 0.5.50–0.5.55 / rules 6.3 runtime + Ability authoring:
 * - migrate every legacy/empty Weapon attack type to melee;
 * - migrate legacy Ability attackCheck into the universal Check model;
 * - split melee/ranged from the independent area action property;
 * - materialize the 0.5.53 Defense Ability procedure (legacy = directed);
 * - materialize 0.5.55 Ability traitIds and class-resource cost fields;
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
