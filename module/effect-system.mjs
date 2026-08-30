const SYSTEM_ID = "fast-nri";
const SEED_SETTING = "builtinEffectsSeeded";

export const EFFECT_DURATION_MODES = Object.freeze({
  manual: "Вручную",
  turnEnd: "До конца текущего хода",
  nextTurnStart: "До начала следующего хода",
  rounds: "Раунды"
});

export const EFFECT_EXPIRY_PHASES = Object.freeze({
  turnStart: "В начале хода",
  turnEnd: "В конце хода"
});

export const EFFECT_STACKING_MODES = Object.freeze({
  none: "Не стакается",
  shared: "Стакается — общий таймер",
  independent: "Стакается — независимые таймеры"
});

export const EFFECT_KINDS = Object.freeze({
  condition: "Состояние",
  buff: "Бафф",
  debuff: "Дебафф"
});

export const BUILTIN_EFFECTS = Object.freeze([
  {
    id: "prone",
    name: "Лежит",
    img: "icons/magic/control/silhouette-fall-slip-prone.webp"
  },
  {
    id: "grabbed",
    name: "Схвачен",
    img: "icons/magic/control/debuff-energy-snare-blue.webp"
  },
  {
    id: "immobilized",
    name: "Обездвижен",
    img: "icons/magic/control/debuff-chains-shackles-movement-blue.webp"
  },
  {
    id: "off-guard",
    name: "Застигнут врасплох",
    img: "icons/skills/melee/shield-damaged-broken-blue.webp"
  },
  {
    id: "slowed",
    name: "Замедлен",
    img: "icons/creatures/invertebrates/snail-movement-green.webp"
  },
  {
    id: "weakened",
    name: "Ослаблен",
    img: "icons/skills/wounds/injury-body-pain-gray.webp"
  },
  {
    id: "frightened",
    name: "Испуган",
    img: "icons/magic/control/fear-fright-white.webp"
  },
  {
    id: "unconscious",
    name: "Без сознания",
    img: "icons/svg/unconscious.svg"
  }
]);

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function randomId() {
  if (globalThis.foundry?.utils?.randomID) return foundry.utils.randomID();
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2);
}

function clampInteger(value, minimum = 0) {
  const number = Math.trunc(Number(value) || 0);
  return Math.max(minimum, number);
}

export function effectStackCount(effectOrSystem) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  const mode = String(system.stacking?.mode ?? "none");
  const count = clampInteger(system.runtime?.stackCount, 0);

  if (mode === "none") return count > 0 ? 1 : 0;
  return count;
}

export function buildEffectTimer(duration = {}, combatState = null, id = null) {
  const mode = String(duration?.mode ?? "manual");
  const rounds = Math.max(1, clampInteger(duration?.rounds, 1));
  const expiry = duration?.expiry === "turnEnd" ? "turnEnd" : "turnStart";

  const timer = {
    id: id || randomId(),
    durationMode: mode,
    combatId: "",
    combatantId: "",
    appliedRound: 0,
    appliedTurn: -1,
    expiresRound: 0,
    phase: "manual",
    untracked: false
  };

  if (mode === "manual") return timer;

  if (
    !combatState
    || !combatState.combatId
    || !combatState.combatantId
    || !(combatState.round > 0)
  ) {
    timer.untracked = true;
    return timer;
  }

  timer.combatId = String(combatState.combatId);
  timer.combatantId = String(combatState.combatantId);
  timer.appliedRound = clampInteger(combatState.round, 1);
  timer.appliedTurn = Number.isInteger(combatState.turn)
    ? combatState.turn
    : -1;

  if (mode === "turnEnd") {
    timer.expiresRound = timer.appliedRound;
    timer.phase = "turnEnd";
    return timer;
  }

  if (mode === "nextTurnStart") {
    timer.expiresRound = timer.appliedRound + 1;
    timer.phase = "turnStart";
    return timer;
  }

  if (mode === "rounds") {
    timer.expiresRound = timer.appliedRound + rounds;
    timer.phase = expiry;
    return timer;
  }

  // Unknown duration modes degrade safely to manual.
  timer.durationMode = "manual";
  return timer;
}

export function timerExpiresAtEvent(timer, event) {
  if (!timer || timer.untracked || timer.phase === "manual") return false;
  if (!event || event.combatId !== timer.combatId) return false;
  if (event.phase !== timer.phase) return false;
  if (event.combatantId !== timer.combatantId) return false;

  return Number(event.round) >= Number(timer.expiresRound);
}

export function addStackState(system = {}, timer) {
  const stackingMode = String(system.stacking?.mode ?? "none");
  const runtime = system.runtime ?? {};
  const currentCount = effectStackCount(system);
  const currentTimers = Array.from(runtime.timers ?? []);

  if (stackingMode === "independent") {
    return {
      stackCount: Math.max(1, currentCount + 1),
      timers: [...currentTimers, timer]
    };
  }

  if (stackingMode === "shared") {
    return {
      stackCount: Math.max(1, currentCount + 1),
      timers: [timer]
    };
  }

  return {
    stackCount: 1,
    timers: [timer]
  };
}

export function removeOneStackState(system = {}) {
  const stackingMode = String(system.stacking?.mode ?? "none");
  const currentCount = effectStackCount(system);
  const currentTimers = Array.from(system.runtime?.timers ?? []);

  if (currentCount <= 1 || stackingMode === "none") {
    return {
      deleteEffect: true,
      stackCount: 0,
      timers: []
    };
  }

  if (stackingMode === "independent") {
    return {
      deleteEffect: false,
      stackCount: currentCount - 1,
      timers: currentTimers.slice(0, -1)
    };
  }

  return {
    deleteEffect: false,
    stackCount: currentCount - 1,
    timers: currentTimers
  };
}

export function durationDefinitionLabel(system = {}) {
  const duration = system.duration ?? {};
  const mode = String(duration.mode ?? "manual");

  if (mode === "turnEnd") return "До конца текущего хода";
  if (mode === "nextTurnStart") return "До начала следующего хода";

  if (mode === "rounds") {
    const rounds = Math.max(1, clampInteger(duration.rounds, 1));
    const suffix = duration.expiry === "turnEnd"
      ? "в конце хода"
      : "в начале хода";

    return `${rounds} ${rounds === 1 ? "раунд" : "раундов"}, ${suffix}`;
  }

  return "Вручную";
}

export function runtimeDurationLabel(effectOrSystem, combatState = null) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  const timers = Array.from(system.runtime?.timers ?? []);
  if (!timers.length) return durationDefinitionLabel(system);

  const untracked = timers.filter(timer => timer.untracked);
  if (untracked.length) return "Таймер не запущен — нет активного боя";

  const tracked = timers.filter(timer => timer.phase !== "manual");
  if (!tracked.length) return "Вручную";

  const activeCombatId = combatState?.combatId ?? null;
  const activeRound = Number(combatState?.round) || 0;

  const candidates = tracked
    .filter(timer => !activeCombatId || timer.combatId === activeCombatId)
    .sort((a, b) => Number(a.expiresRound) - Number(b.expiresRound));

  const timer = candidates[0] ?? tracked[0];

  if (!activeRound || !timer.expiresRound) {
    return timer.phase === "turnEnd"
      ? "До конца хода"
      : "До начала хода";
  }

  const roundsLeft = Math.max(0, Number(timer.expiresRound) - activeRound);

  if (roundsLeft === 0) {
    return timer.phase === "turnEnd"
      ? "Спадёт в конце хода"
      : "Спадёт в начале хода";
  }

  return `${roundsLeft} ${roundsLeft === 1 ? "раунд" : "раундов"} • ${
    timer.phase === "turnEnd" ? "конец хода" : "начало хода"
  }`;
}

function currentCombatState() {
  const combat = game.combat;
  if (!combat?.started || !combat.combatant) return null;

  return {
    combatId: combat.id,
    combatantId: combat.combatant.id,
    round: Number(combat.round) || 0,
    turn: Number.isInteger(combat.turn) ? combat.turn : -1
  };
}

function activeCombatDisplayState() {
  const combat = game.combat;
  if (!combat?.started) return null;

  return {
    combatId: combat.id,
    round: Number(combat.round) || 0
  };
}

function sourceKeyFor(effect) {
  return String(effect?.system?.sourceUuid || effect?.uuid || "").trim();
}

function embeddedEffectWithSource(actor, sourceKey) {
  return Array.from(actor?.items ?? []).find(item =>
    item.type === "effect"
    && String(item.system?.sourceUuid ?? "") === sourceKey
  ) ?? null;
}

function mirrorForItem(item) {
  const actor = item?.parent;
  if (!actor) return null;

  const storedId = String(item.system?.runtime?.mirrorEffectId ?? "");
  const stored = storedId ? actor.effects?.get(storedId) : null;
  if (stored) return stored;

  return Array.from(actor.effects ?? []).find(effect =>
    effect.getFlag?.(SYSTEM_ID, "effectItemId") === item.id
  ) ?? null;
}

async function syncMirror(item) {
  if (!item?.isEmbedded || item.type !== "effect") return null;

  const actor = item.parent;
  if (!actor) return null;

  const count = effectStackCount(item);
  const desiredName = count > 1 ? `${item.name} ×${count}` : item.name;

  let mirror = mirrorForItem(item);

  const data = {
    name: desiredName,
    img: item.img,
    description: String(item.system?.description ?? ""),
    origin: item.uuid,
    showIcon: CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS,
    disabled: false,
    changes: [],
    flags: {
      [SYSTEM_ID]: {
        effectItemId: item.id,
        sourceUuid: item.system?.sourceUuid || ""
      }
    }
  };

  if (!mirror) {
    const created = await actor.createEmbeddedDocuments("ActiveEffect", [data]);
    mirror = created?.[0] ?? null;

    if (mirror && item.system?.runtime?.mirrorEffectId !== mirror.id) {
      await item.update({
        "system.runtime.mirrorEffectId": mirror.id
      });
    }
  } else {
    const update = {};
    if (mirror.name !== desiredName) update.name = desiredName;
    if (mirror.img !== item.img) update.img = item.img;
    if (mirror.origin !== item.uuid) update.origin = item.uuid;
    if (mirror.showIcon !== CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS) {
      update.showIcon = CONST.ACTIVE_EFFECT_SHOW_ICON.ALWAYS;
    }

    if (Object.keys(update).length) await mirror.update(update);
  }

  for (const token of actor.getActiveTokens?.(true, true) ?? []) {
    token.renderFlags?.set?.({ refreshEffects: true });
  }

  return mirror;
}

async function deleteMirror(item) {
  const actor = item?.parent;
  if (!actor) return;

  const mirror = mirrorForItem(item);
  if (!mirror) return;

  await actor.deleteEmbeddedDocuments("ActiveEffect", [mirror.id]);

  for (const token of actor.getActiveTokens?.(true, true) ?? []) {
    token.renderFlags?.set?.({ refreshEffects: true });
  }
}

export async function applyEffectToActor(sourceEffect, actor) {
  if (!sourceEffect || sourceEffect.type !== "effect" || !actor) return null;

  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.warn(`Нет прав на изменение ${actor.name}.`);
    return null;
  }

  const sourceKey = sourceKeyFor(sourceEffect);
  if (!sourceKey) {
    ui.notifications.error("У эффекта отсутствует UUID источника.");
    return null;
  }

  const timer = buildEffectTimer(
    sourceEffect.system?.duration,
    currentCombatState()
  );

  if (timer.untracked) {
    ui.notifications.warn(
      `${sourceEffect.name}: активного боя нет, поэтому автоснятие не запущено. Эффект можно снять вручную.`
    );
  }

  const existing = embeddedEffectWithSource(actor, sourceKey);

  if (existing) {
    const next = addStackState(existing.system, timer);

    await existing.update({
      "system.runtime.stackCount": next.stackCount,
      "system.runtime.timers": next.timers
    });

    await syncMirror(existing);
    refreshEffectPanel();

    return existing;
  }

  const data = sourceEffect.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;

  data.system = foundry.utils.deepClone(data.system ?? {});
  data.system.sourceUuid = sourceKey;
  data.system.runtime = {
    stackCount: 1,
    mirrorEffectId: "",
    timers: [timer]
  };

  // ActiveEffect mirrors are runtime-only and must not be copied from source.
  data.effects = [];

  const created = await actor.createEmbeddedDocuments(
    "Item",
    [data],
    { fastNriEffectApply: true }
  );
  const embedded = created?.[0] ?? null;

  if (embedded) {
    await syncMirror(embedded);
    refreshEffectPanel();
  }

  return embedded;
}

export async function removeOneEffectStack(effect) {
  if (!effect?.isEmbedded || effect.type !== "effect") return;

  const next = removeOneStackState(effect.system);

  if (next.deleteEffect) {
    await effect.delete();
    refreshEffectPanel();
    return;
  }

  await effect.update({
    "system.runtime.stackCount": next.stackCount,
    "system.runtime.timers": next.timers
  });

  await syncMirror(effect);
  refreshEffectPanel();
}

function isForwardTurnChange(prior, current) {
  if (!prior || !current) return true;
  if (current.round > prior.round) return true;
  if (current.round < prior.round) return false;

  const priorTurn = Number(prior.turn);
  const currentTurn = Number(current.turn);

  if (!Number.isFinite(priorTurn) || !Number.isFinite(currentTurn)) return true;
  return currentTurn > priorTurn;
}

function timerEventsForTurnChange(combat, prior, current) {
  return [
    prior?.combatantId
      ? {
          phase: "turnEnd",
          combatId: combat.id,
          combatantId: prior.combatantId,
          round: Number(prior.round) || 0
        }
      : null,
    current?.combatantId
      ? {
          phase: "turnStart",
          combatId: combat.id,
          combatantId: current.combatantId,
          round: Number(current.round) || 0
        }
      : null
  ].filter(Boolean);
}

function responsibleForExpiry() {
  if (game.users?.activeGM) {
    return game.users.activeGM.id === game.user.id;
  }
  return game.user.isGM;
}

async function processActorExpiry(actor, events) {
  if (!actor) return;

  const effects = Array.from(actor.items ?? []).filter(item => item.type === "effect");

  for (const effect of effects) {
    const timers = Array.from(effect.system?.runtime?.timers ?? []);
    if (!timers.length) continue;

    const stackingMode = String(effect.system?.stacking?.mode ?? "none");

    if (stackingMode === "independent") {
      const remaining = timers.filter(timer =>
        !events.some(event => timerExpiresAtEvent(timer, event))
      );

      const expiredCount = timers.length - remaining.length;
      if (expiredCount <= 0) continue;

      const currentCount = effectStackCount(effect);
      const nextCount = Math.max(0, currentCount - expiredCount);

      if (nextCount <= 0 || remaining.length <= 0) {
        await effect.delete();
      } else {
        await effect.update({
          "system.runtime.stackCount": nextCount,
          "system.runtime.timers": remaining
        });
        await syncMirror(effect);
      }

      continue;
    }

    if (timers.some(timer =>
      events.some(event => timerExpiresAtEvent(timer, event))
    )) {
      await effect.delete();
    }
  }
}

async function processCombatTurnChange(combat, prior, current) {
  if (!responsibleForExpiry()) return;
  if (!isForwardTurnChange(prior, current)) return;

  const events = timerEventsForTurnChange(combat, prior, current);
  if (!events.length) return;

  const actors = new Map();

  for (const combatant of combat.combatants ?? []) {
    const actor = combatant.actor;
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }

  for (const actor of actors.values()) {
    await processActorExpiry(actor, events);
  }

  refreshEffectPanel();
}

function tokenAtCanvasPoint(x, y) {
  const tokens = Array.from(canvas?.tokens?.placeables ?? []).reverse();

  return tokens.find(token =>
    token.visible
    && token.bounds?.contains?.(x, y)
  ) ?? null;
}

async function resolveDroppedItem(data) {
  if (!data || data.type !== "Item") return null;

  try {
    return await Item.implementation.fromDropData(data);
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось разрешить dropped Item", error);
    return null;
  }
}

async function onCanvasDrop(data) {
  const source = await resolveDroppedItem(data);
  if (!source || source.type !== "effect") return;

  const token = tokenAtCanvasPoint(data.x, data.y);
  if (!token?.actor) {
    ui.notifications.warn("Перетащите эффект прямо на токен.");
    return;
  }

  await applyEffectToActor(source, token.actor);
}

export function effectDragData(effect) {
  return {
    type: "Item",
    uuid: effect.uuid,
    fastNriEffect: true
  };
}

export function effectChatCardHTML(effect, { compact = false } = {}) {
  if (!effect || effect.type !== "effect") return "";

  const duration = durationDefinitionLabel(effect.system);
  const stacking = EFFECT_STACKING_MODES[effect.system?.stacking?.mode]
    ?? EFFECT_STACKING_MODES.none;

  return `
    <div
      class="fast-nri-effect-chat-card ${compact ? "compact" : ""}"
      draggable="true"
      data-fast-nri-effect-drag
      data-effect-uuid="${escAttr(effect.uuid)}"
      title="Перетащите на токен"
    >
      <img src="${escAttr(effect.img)}" alt="" />
      <div class="fast-nri-effect-chat-info">
        <strong>${esc(effect.name)}</strong>
        <small>${esc(duration)}</small>
        ${compact ? "" : `<small>${esc(stacking)}</small>`}
      </div>
      <i class="fa-solid fa-hand-pointer"></i>
    </div>
  `;
}

export async function postEffectToChat(effect, { actor = null } = {}) {
  if (!effect || effect.type !== "effect") return null;

  return ChatMessage.create({
    speaker: actor
      ? ChatMessage.getSpeaker({ actor })
      : ChatMessage.getSpeaker(),
    content: effectChatCardHTML(effect),
    flags: {
      [SYSTEM_ID]: {
        kind: "effect-card",
        effectUuid: effect.uuid
      }
    }
  });
}

export async function resolveEffectDocuments(uuids = []) {
  const effects = [];

  for (const uuid of Array.from(uuids ?? [])) {
    try {
      const document = await fromUuid(uuid);
      if (document?.type === "effect") effects.push(document);
    } catch (error) {
      console.warn(`Быстрая НРИ | Не удалось найти Effect ${uuid}`, error);
    }
  }

  return effects;
}

export function registerEffectSettings() {
  game.settings.register(SYSTEM_ID, SEED_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

export async function seedBuiltinEffectsOnce() {
  if (!game.user.isGM) return;
  if (game.settings.get(SYSTEM_ID, SEED_SETTING)) return;

  let folder = game.folders?.find(folder =>
    folder.type === "Item"
    && folder.name === "Быстрая НРИ — Эффекты"
  ) ?? null;

  if (!folder) {
    folder = await Folder.create({
      name: "Быстрая НРИ — Эффекты",
      type: "Item"
    });
  }

  const existingIds = new Set(
    game.items
      .filter(item => item.type === "effect")
      .map(item => item.getFlag(SYSTEM_ID, "builtinEffectId"))
      .filter(Boolean)
  );

  const data = BUILTIN_EFFECTS
    .filter(effect => !existingIds.has(effect.id))
    .map(effect => ({
      name: effect.name,
      type: "effect",
      img: effect.img,
      folder: folder?.id ?? null,
      flags: {
        [SYSTEM_ID]: {
          builtinEffectId: effect.id
        }
      },
      system: {
        effectKind: "condition",
        duration: {
          mode: "manual",
          rounds: 1,
          expiry: "turnStart"
        },
        stacking: {
          mode: "none"
        }
      }
    }));

  if (data.length) {
    await Item.createDocuments(data);
  }

  await game.settings.set(SYSTEM_ID, SEED_SETTING, true);
}

function controlledActor() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);
  if (controlled.length !== 1) return null;
  return controlled[0].actor ?? null;
}

function effectPanelElement() {
  let panel = document.getElementById("fast-nri-effect-panel");

  if (!panel) {
    panel = document.createElement("section");
    panel.id = "fast-nri-effect-panel";
    panel.className = "fast-nri-effect-panel";
    document.body.append(panel);
  }

  return panel;
}

export function refreshEffectPanel() {
  if (!game.ready) return;

  const panel = effectPanelElement();
  const actor = controlledActor();

  if (!actor) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }

  const effects = Array.from(actor.items ?? [])
    .filter(item => item.type === "effect")
    .sort((a, b) => a.sort - b.sort);

  if (!effects.length) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }

  panel.hidden = false;

  const combatState = activeCombatDisplayState();

  panel.innerHTML = `
    <div class="fast-nri-effect-panel-title">${esc(actor.name)}</div>
    <div class="fast-nri-effect-panel-icons">
      ${effects.map(effect => {
        const count = effectStackCount(effect);
        const duration = runtimeDurationLabel(effect, combatState);

        return `
          <button
            type="button"
            class="fast-nri-effect-panel-icon"
            data-effect-item-id="${escAttr(effect.id)}"
            title="${escAttr(`${effect.name} • ${duration}\nПКМ: снять один стак`)}"
          >
            <img src="${escAttr(effect.img)}" alt="${escAttr(effect.name)}" />
            ${count > 1 ? `<span class="fast-nri-effect-stack-badge">${esc(count)}</span>` : ""}
            <span class="fast-nri-effect-duration-badge">${esc(duration)}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;

  for (const button of panel.querySelectorAll("[data-effect-item-id]")) {
    button.addEventListener("click", event => {
      event.preventDefault();
      const effect = actor.items.get(button.dataset.effectItemId);
      effect?.sheet?.render?.({ force: true });
    });

    button.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();

      const effect = actor.items.get(button.dataset.effectItemId);
      if (effect) void removeOneEffectStack(effect);
    });
  }
}

export function activateEffectChatInteractions(root = document) {
  root.addEventListener("dragstart", event => {
    const element = event.target?.closest?.("[data-fast-nri-effect-drag]");
    if (!element) return;

    const effectUuid = element.dataset.effectUuid;
    const effect = effectUuid ? fromUuidSync(effectUuid) : null;
    if (!effect || effect.type !== "effect") return;

    event.dataTransfer?.setData(
      "text/plain",
      JSON.stringify(effectDragData(effect))
    );

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
    }
  });
}

export function activateEffectSystem() {
  Hooks.on("dropCanvasData", (_canvas, data) => {
    if (data?.type !== "Item") return;
    void onCanvasDrop(data);
  });

  Hooks.on("combatTurnChange", (combat, prior, current) => {
    void processCombatTurnChange(combat, prior, current);
  });

  Hooks.on("controlToken", () => refreshEffectPanel());
  Hooks.on("canvasReady", () => refreshEffectPanel());

  Hooks.on("createItem", (item, options, userId) => {
    if (item.type !== "effect") return;

    if (
      item.isEmbedded
      && userId === game.user.id
      && !options?.fastNriEffectApply
    ) {
      void syncMirror(item);
    }

    refreshEffectPanel();
  });

  Hooks.on("updateItem", (item, _changes, _options, userId) => {
    if (item.type !== "effect") return;

    if (item.isEmbedded && userId === game.user.id) {
      void syncMirror(item);
    }

    refreshEffectPanel();
  });

  Hooks.on("deleteItem", (item, _options, userId) => {
    if (item.type !== "effect") return;

    if (item.isEmbedded && userId === game.user.id) {
      void deleteMirror(item);
    }

    refreshEffectPanel();
  });

  Hooks.on("deleteActiveEffect", (activeEffect, _options, userId) => {
    if (userId !== game.user.id) return;

    const itemId = activeEffect.getFlag?.(SYSTEM_ID, "effectItemId");
    const actor = activeEffect.parent;

    if (!itemId || !actor) return;

    const effectItem = actor.items.get(itemId);
    if (effectItem?.type === "effect") {
      // Removing the visual mirror is interpreted as manually removing
      // the gameplay Effect Item as well.
      void effectItem.delete();
    }
  });

  refreshEffectPanel();
}
