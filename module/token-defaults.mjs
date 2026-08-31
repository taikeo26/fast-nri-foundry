const TOKEN_MIGRATION_SETTING = "tokenHpBarsMigration";
const TOKEN_MIGRATION_VERSION = 1;
const AUTO_ROTATE_MIGRATION_SETTING = "disableAutoRotateMigration";
const AUTO_ROTATE_MIGRATION_VERSION = 1;

export function tokenDefaultsForActorType(actorType) {
  const disposition = actorType === "character"
    ? CONST.TOKEN_DISPOSITIONS.FRIENDLY
    : actorType === "creature"
      ? CONST.TOKEN_DISPOSITIONS.HOSTILE
      : undefined;

  return {
    displayBars: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
    bar1: { attribute: "hp" },
    bar2: { attribute: "" },
    ...(disposition === undefined ? {} : { disposition })
  };
}

/**
 * Hidden migration markers.
 * - HP bar migration is world-scoped because it updates world Documents.
 * - auto-rotate migration is client-scoped because Foundry's own
 *   core.tokenAutoRotate setting is client-specific.
 */
export function registerTokenDefaultSettings() {
  game.settings.register(game.system.id, TOKEN_MIGRATION_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });

  game.settings.register(game.system.id, AUTO_ROTATE_MIGRATION_SETTING, {
    scope: "client",
    config: false,
    type: Number,
    default: 0
  });
}

/**
 * New Fast NRI Actors use the native Foundry HP resource bar by default.
 * The manifest already declares primaryTokenAttribute="hp"; this hook adds
 * always-visible bars and explicitly clears the secondary bar.
 */
export function activateTokenDefaults() {
  Hooks.on("preCreateActor", actor => {
    const defaults = tokenDefaultsForActorType(actor?.type);
    actor.updateSource({
      "prototypeToken.displayBars": defaults.displayBars,
      "prototypeToken.bar1.attribute": defaults.bar1.attribute,
      "prototypeToken.bar2.attribute": defaults.bar2.attribute,
      ...(defaults.disposition === undefined
        ? {}
        : { "prototypeToken.disposition": defaults.disposition })
    });
  });
}

async function migrateActorPrototypes() {
  const updates = game.actors
    .filter(actor => ["character", "creature"].includes(actor.type))
    .map(actor => ({
      _id: actor.id,
      "prototypeToken.displayBars": CONST.TOKEN_DISPLAY_MODES.ALWAYS,
      "prototypeToken.bar1.attribute": "hp",
      "prototypeToken.bar2.attribute": ""
    }));

  if (updates.length) await Actor.updateDocuments(updates);
  return updates.length;
}

async function migrateSceneTokens() {
  let count = 0;

  for (const scene of game.scenes) {
    const updates = scene.tokens
      .filter(token => token.actor && ["character", "creature"].includes(token.actor.type))
      .map(token => ({
        _id: token.id,
        displayBars: CONST.TOKEN_DISPLAY_MODES.ALWAYS,
        "bar1.attribute": "hp",
        "bar2.attribute": ""
      }));

    if (!updates.length) continue;
    await scene.updateEmbeddedDocuments("Token", updates);
    count += updates.length;
  }

  return count;
}

/**
 * Apply native HP bars once to Actors/Tokens which already existed before
 * this release. Later manual Token settings are not overwritten on startup.
 */
export async function migrateTokenBarsOnce() {
  if (!game.user.isGM) return;

  const current = Number(
    game.settings.get(game.system.id, TOKEN_MIGRATION_SETTING)
  ) || 0;

  if (current >= TOKEN_MIGRATION_VERSION) return;

  try {
    const actorCount = await migrateActorPrototypes();
    const tokenCount = await migrateSceneTokens();

    await game.settings.set(
      game.system.id,
      TOKEN_MIGRATION_SETTING,
      TOKEN_MIGRATION_VERSION
    );

    console.log(
      `Быстрая НРИ | Native HP bars: ${actorCount} prototype, ${tokenCount} scene token(s).`
    );
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции полос HP", error);
    ui.notifications.error("Не удалось применить стандартные полосы HP к токенам.");
  }
}

/**
 * Foundry v14 has its own client setting core.tokenAutoRotate. Movement uses
 * it by default for dragging/keyboard movement. Set it to false once for each
 * user instead of locking Token rotation, so manual rotation remains usable.
 */
export async function disableTokenAutoRotateByDefaultOnce() {
  const current = Number(
    game.settings.get(game.system.id, AUTO_ROTATE_MIGRATION_SETTING)
  ) || 0;

  if (current >= AUTO_ROTATE_MIGRATION_VERSION) return;

  try {
    const coreSetting = game.settings.settings.get("core.tokenAutoRotate");
    if (!coreSetting) {
      console.warn("Быстрая НРИ | core.tokenAutoRotate setting not found; skipped.");
      return;
    }

    await game.settings.set("core", "tokenAutoRotate", false);
    await game.settings.set(
      game.system.id,
      AUTO_ROTATE_MIGRATION_SETTING,
      AUTO_ROTATE_MIGRATION_VERSION
    );

    console.log("Быстрая НРИ | Автоповорот токенов при движении отключён по умолчанию.");
  } catch (error) {
    console.error("Быстрая НРИ | Не удалось отключить автоповорот токенов", error);
  }
}
