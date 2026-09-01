const SYSTEM_ID = "fast-nri";
const PACK_NAME = "fast-nri-test-abilities-055";
const PACK_LABEL = "Быстрая НРИ — тестовые способности 0.5.55";
const PACK_COLLECTION = `world.${PACK_NAME}`;
const SEED_SETTING = "testAbilityCompendiumSeed";
export const TEST_COMPENDIUM_SEED_VERSION = "0.5.55-compendium-1";

export function testAbilityCompendiumId() {
  return PACK_COLLECTION;
}

export function testAbilityCompendiumSeedUrl() {
  const path = `systems/${SYSTEM_ID}/test-items/ability-spell-test-items.json`;
  return globalThis.foundry?.utils?.getRoute?.(path) ?? `/${path}`;
}

export function registerTestCompendiumSettings() {
  game.settings.register(SYSTEM_ID, SEED_SETTING, {
    name: "Test Ability Compendium Seed",
    scope: "world",
    config: false,
    type: String,
    default: ""
  });
}

function compendiumOwnership() {
  return {
    PLAYER: "OBSERVER",
    TRUSTED: "OBSERVER",
    ASSISTANT: "OWNER",
    GAMEMASTER: "OWNER"
  };
}

async function loadSeedItems() {
  const response = await fetch(testAbilityCompendiumSeedUrl(), { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading test Ability seed`);
  const items = await response.json();
  if (!Array.isArray(items) || !items.length) throw new Error("Test Ability seed is empty or invalid");
  return items;
}

async function getOrCreatePack() {
  let pack = game.packs.get(PACK_COLLECTION);
  if (pack) return { pack, created: false };

  const CompendiumCollection = foundry.documents.collections.CompendiumCollection;
  try {
    pack = await CompendiumCollection.createCompendium({
      name: PACK_NAME,
      label: PACK_LABEL,
      type: "Item",
      package: "world",
      system: SYSTEM_ID,
      private: false,
      ownership: compendiumOwnership()
    });
    return { pack, created: true };
  } catch (error) {
    // Another active GM may have created it at the same time. Re-read before failing.
    pack = game.packs.get(PACK_COLLECTION);
    if (pack) return { pack, created: false };
    throw error;
  }
}

/**
 * Ensure an editable world compendium with the live-QA Ability/Spell fixtures exists.
 * The seed runs once per world/version. After that, users may freely edit or delete
 * entries without the system overwriting their work on every reload.
 */
export async function ensureTestAbilityCompendium() {
  if (!game.user?.isGM) return { skipped: "not-gm" };

  const seededVersion = game.settings.get(SYSTEM_ID, SEED_SETTING);
  if (seededVersion === TEST_COMPENDIUM_SEED_VERSION) {
    return { skipped: "already-seeded", pack: game.packs.get(PACK_COLLECTION) ?? null };
  }

  const { pack, created } = await getOrCreatePack();
  if (!pack) throw new Error("Unable to create or access test Ability compendium");

  const index = await pack.getIndex();
  let seeded = 0;

  // Never overwrite an existing non-empty test pack: it is intentionally editable.
  if (!index.size) {
    if (pack.locked) {
      console.warn("Быстрая НРИ | Тестовый компендиум пуст, но заблокирован; заселение пропущено.");
      return { skipped: "locked", pack, created };
    }

    const items = await loadSeedItems();
    const prepared = items.map((item, i) => ({
      ...item,
      flags: {
        ...(item.flags ?? {}),
        [SYSTEM_ID]: {
          ...(item.flags?.[SYSTEM_ID] ?? {}),
          testCompendiumSeed: TEST_COMPENDIUM_SEED_VERSION,
          testCompendiumIndex: i
        }
      }
    }));

    const createdItems = await Item.implementation.createDocuments(prepared, { pack: pack.collection });
    seeded = Array.isArray(createdItems) ? createdItems.length : prepared.length;
  }

  await game.settings.set(SYSTEM_ID, SEED_SETTING, TEST_COMPENDIUM_SEED_VERSION);
  console.log(`Быстрая НРИ | Тестовый компендиум готов: ${pack.collection}; добавлено Item: ${seeded}`);
  if (created || seeded) {
    ui.notifications.info("Создан компендиум «Быстрая НРИ — тестовые способности 0.5.55»");
  }
  return { pack, created, seeded };
}
