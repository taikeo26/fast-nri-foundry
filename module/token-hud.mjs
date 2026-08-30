import {
  EFFECT_STACKING_MODES,
  appliedEffectForSource,
  applyEffectToActor,
  durationDefinitionLabel,
  effectStackCount,
  removeOneEffectStack,
  runtimeDurationLabel
} from "./effect-system.mjs";

const HUD_EFFECT_PREFIX = "fast-nri-effect:";

export function hudEffectIdForItem(itemOrId) {
  const id = typeof itemOrId === "string"
    ? itemOrId
    : itemOrId?.id;

  return id ? `${HUD_EFFECT_PREFIX}${id}` : "";
}

export function itemIdFromHudEffectId(statusId) {
  const value = String(statusId ?? "");
  return value.startsWith(HUD_EFFECT_PREFIX)
    ? value.slice(HUD_EFFECT_PREFIX.length)
    : null;
}

export function isFastNriHudEffectId(statusId) {
  return itemIdFromHudEffectId(statusId) !== null;
}

export function worldEffectSources() {
  return Array.from(game?.items ?? [])
    .filter(item => item.type === "effect")
    .sort((a, b) => {
      const aSort = Number(a.sort) || 0;
      const bSort = Number(b.sort) || 0;
      if (aSort !== bSort) return aSort - bSort;

      return String(a.name).localeCompare(String(b.name), "ru");
    });
}

export function sourceEffectFromHudId(statusId) {
  const itemId = itemIdFromHudEffectId(statusId);
  return itemId ? game.items?.get(itemId) ?? null : null;
}

export function buildFastNriHudChoice(source, actor, combatState = null) {
  const id = hudEffectIdForItem(source);
  const applied = appliedEffectForSource(actor, source);
  const count = applied ? effectStackCount(applied) : 0;

  const definition = durationDefinitionLabel(source.system);
  const runtime = applied
    ? runtimeDurationLabel(applied, combatState)
    : definition;

  const stacking = EFFECT_STACKING_MODES[source.system?.stacking?.mode]
    ?? EFFECT_STACKING_MODES.none;

  const stateLabel = applied
    ? [
        count > 1 ? `стаков ${count}` : "активен",
        runtime
      ].join(" • ")
    : definition;

  return {
    _id: id,
    id,
    title: `${source.name} • ${stateLabel} • ${stacking} • ЛКМ: применить • ПКМ: снять один стак`,
    src: source.img,
    isActive: Boolean(applied),
    isOverlay: false,
    order: 100000 + (Number(source.sort) || 0),
    cssClass: [
      "fast-nri-effect-item",
      applied ? "active" : ""
    ].filter(Boolean).join(" ")
  };
}

function currentCombatDisplayState() {
  const combat = game.combat;
  if (!combat?.started) return null;

  return {
    combatId: combat.id,
    round: Number(combat.round) || 0
  };
}

async function handleCoreStatus(hud, event, statusId) {
  if (!hud.actor || !statusId) return;

  await hud.actor.toggleStatusEffect(statusId, {
    overlay: event.button === 2
  });

  await hud.render({ force: true });
}

async function handleFastNriEffect(hud, event, statusId) {
  const actor = hud.actor;
  const source = sourceEffectFromHudId(statusId);

  if (!actor || !source) {
    ui.notifications.warn("Не удалось найти Effect Item для этой иконки.");
    return;
  }

  if (event.button === 2) {
    const applied = appliedEffectForSource(actor, source);
    if (applied) {
      await removeOneEffectStack(applied);
    }
  } else {
    await applyEffectToActor(source, actor);
  }

  await hud.render({ force: true });
}

/**
 * Replace only the Token HUD class, not its template.
 *
 * The palette remains Foundry's native status-effects palette. We append
 * world-level Fast NRI Effect Items to the choices returned by core.
 *
 * Core icons retain core behavior:
 *   LMB -> toggle status
 *   RMB -> toggle overlay
 *
 * Fast NRI Effect Item icons use soft automation:
 *   LMB -> apply / add stack / refresh timer
 *   RMB -> remove one stack; last stack deletes the effect
 */
export function registerFastNriTokenHud() {
  const BaseTokenHUD = CONFIG.Token.hudClass;

  class FastNriTokenHUD extends BaseTokenHUD {
    static DEFAULT_OPTIONS = {
      actions: {
        effect: {
          buttons: [0, 2],
          handler: async function(event, target) {
            const statusId = target.dataset.statusId;

            if (isFastNriHudEffectId(statusId)) {
              await handleFastNriEffect(this, event, statusId);
              return;
            }

            await handleCoreStatus(this, event, statusId);
          }
        }
      }
    };

    _getStatusEffectChoices() {
      const core = super._getStatusEffectChoices();
      const custom = {};
      const combatState = currentCombatDisplayState();

      for (const source of worldEffectSources()) {
        const choice = buildFastNriHudChoice(
          source,
          this.actor,
          combatState
        );

        custom[choice.id] = choice;
      }

      return {
        ...core,
        ...custom
      };
    }
  }

  CONFIG.Token.hudClass = FastNriTokenHUD;
}
