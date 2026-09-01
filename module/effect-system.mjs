import { normalizeActionContext } from "./action-context.mjs";

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

export const OFF_GUARD_EFFECT_ID = "off-guard";

export function isSystemOnlyEffect(effectOrSource) {
  return Boolean(effectOrSource?.getFlag?.(SYSTEM_ID, "systemOnly"));
}
const RELATIVE_OFF_GUARD_FLAG = "relativeOffGuardReasons";

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

function uniqueStrings(values = []) {
  return Array.from(new Set(
    Array.from(values ?? [])
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  ));
}

export function builtinEffectId(effect) {
  if (!effect || effect.type !== "effect") return "";

  const directId = String(effect.getFlag?.(SYSTEM_ID, "builtinEffectId") ?? "");
  if (directId) return directId;

  const sourceUuid = String(effect.system?.sourceUuid ?? "").trim();
  if (!sourceUuid) return "";

  const source = globalThis.fromUuidSync?.(sourceUuid) ?? null;
  return String(source?.getFlag?.(SYSTEM_ID, "builtinEffectId") ?? "");
}

export function isOffGuardEffect(effect) {
  return builtinEffectId(effect) === OFF_GUARD_EFFECT_ID;
}

const LEGACY_SURROUNDED_EFFECT_ID = "surrounded";

function isLegacySurroundedEffect(effect) {
  return builtinEffectId(effect) === LEGACY_SURROUNDED_EFFECT_ID;
}

export function actorHasBuiltinEffect(actor, builtinId) {
  if (!actor) return false;
  const id = String(builtinId ?? "").trim();
  if (!id) return false;

  return Array.from(actor.items ?? []).some(item =>
    item.type === "effect" && builtinEffectId(item) === id
  );
}

export function hasManualOffGuardEffect(actor) {
  return actorHasBuiltinEffect(actor, OFF_GUARD_EFFECT_ID);
}

export function hasConditionOffGuardEffect(actor) {
  return actorHasBuiltinEffect(actor, "prone")
    || actorHasBuiltinEffect(actor, "grabbed");
}

export function hasStoredOffGuardSource(actor) {
  return hasManualOffGuardEffect(actor) || hasConditionOffGuardEffect(actor);
}

export function normalizeRelativeOffGuardState(entries = []) {
  const result = [];
  for (const entry of Array.from(entries ?? [])) {
    const observerUuid = String(entry?.observerUuid ?? "").trim();
    if (!observerUuid) continue;
    const reasons = uniqueStrings(entry?.reasons ?? []);
    if (!reasons.length) continue;

    const existing = result.find(item => item.observerUuid === observerUuid);
    if (existing) existing.reasons = uniqueStrings([...existing.reasons, ...reasons]);
    else result.push({ observerUuid, reasons });
  }
  return result;
}

export function addRelativeOffGuardReasonState(entries = [], observerUuid, reasonId) {
  const observer = String(observerUuid ?? "").trim();
  const reason = String(reasonId ?? "").trim();
  const next = normalizeRelativeOffGuardState(entries);
  if (!observer || !reason) return next;

  const entry = next.find(item => item.observerUuid === observer);
  if (entry) entry.reasons = uniqueStrings([...entry.reasons, reason]);
  else next.push({ observerUuid: observer, reasons: [reason] });
  return next;
}

export function removeRelativeOffGuardReasonState(entries = [], observerUuid, reasonId) {
  const observer = String(observerUuid ?? "").trim();
  const reason = String(reasonId ?? "").trim();
  return normalizeRelativeOffGuardState(entries)
    .map(entry => entry.observerUuid === observer
      ? { ...entry, reasons: uniqueStrings(entry.reasons).filter(existing => existing !== reason) }
      : entry)
    .filter(entry => entry.reasons.length > 0);
}

function observerUuid(observerOrUuid) {
  if (typeof observerOrUuid === "string") return observerOrUuid.trim();

  // Relative rules belong to the observing creature, not to one particular
  // placed Token. Accept Actor, Token, or TokenDocument callers and normalize
  // all Token-shaped inputs to their Actor UUID.
  const actorUuid = observerOrUuid?.actor?.uuid
    ?? observerOrUuid?.document?.actor?.uuid
    ?? "";
  return String(actorUuid || observerOrUuid?.uuid || "").trim();
}

export function relativeOffGuardState(targetActor) {
  if (!targetActor) return [];
  return normalizeRelativeOffGuardState(
    targetActor.getFlag?.(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG) ?? []
  );
}

export function replaceRelativeOffGuardReasonState(entries = [], reasonId, observerUuids = []) {
  const reason = String(reasonId ?? "").trim();
  const desired = new Set(uniqueStrings(observerUuids));
  const next = normalizeRelativeOffGuardState(entries)
    .map(entry => ({
      observerUuid: entry.observerUuid,
      reasons: uniqueStrings(entry.reasons).filter(existing => existing !== reason)
    }))
    .filter(entry => entry.reasons.length > 0);

  if (!reason) return next;

  for (const observerUuid of Array.from(desired).sort()) {
    const entry = next.find(item => item.observerUuid === observerUuid);
    if (entry) entry.reasons = uniqueStrings([...entry.reasons, reason]);
    else next.push({ observerUuid, reasons: [reason] });
  }

  return normalizeRelativeOffGuardState(next);
}

export async function replaceRelativeOffGuardReasonObservers(targetActor, reasonId, observerUuids = []) {
  if (!targetActor) return false;

  const current = relativeOffGuardState(targetActor);
  const next = replaceRelativeOffGuardReasonState(current, reasonId, observerUuids);
  if (JSON.stringify(current) === JSON.stringify(next)) return false;

  if (next.length) await targetActor.setFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG, next);
  else await targetActor.unsetFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG);
  return true;
}

export function relativeOffGuardReasons(targetActor, observerOrUuid) {
  if (!targetActor) return [];
  const observer = observerUuid(observerOrUuid);
  if (!observer) return [];

  const entries = normalizeRelativeOffGuardState(
    targetActor.getFlag?.(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG) ?? []
  );
  return entries.find(entry => entry.observerUuid === observer)?.reasons ?? [];
}

export async function addRelativeOffGuardReason(targetActor, observerOrUuid, reasonId) {
  if (!targetActor) return false;
  const observer = observerUuid(observerOrUuid);
  if (!observer) return false;

  const current = targetActor.getFlag?.(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG) ?? [];
  const next = addRelativeOffGuardReasonState(current, observer, reasonId);
  await targetActor.setFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG, next);
  return true;
}

export async function removeRelativeOffGuardReason(targetActor, observerOrUuid, reasonId) {
  if (!targetActor) return false;
  const observer = observerUuid(observerOrUuid);
  if (!observer) return false;

  const current = targetActor.getFlag?.(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG) ?? [];
  const next = removeRelativeOffGuardReasonState(current, observer, reasonId);

  if (next.length) await targetActor.setFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG, next);
  else await targetActor.unsetFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG);
  return true;
}

export function isOffGuardFor(targetActor, observerOrUuid = null) {
  if (!targetActor) return false;
  if (hasStoredOffGuardSource(targetActor)) return true;
  return relativeOffGuardReasons(targetActor, observerOrUuid).length > 0;
}

/**
 * Remove persisted Surrounding state created by 0.5.35-0.5.48.
 *
 * Starting with 0.5.49 Surrounding is calculated lazily at action resolution,
 * so legacy embedded Effect Items, their world source, and the old relative
 * `surrounded` flag must not remain visible or influence rules. This cleanup is
 * idempotent and GM-only; it is safe to run on every ready.
 */
export async function cleanupLegacySurroundedState() {
  if (!globalThis.game?.user?.isGM) return false;

  const actors = new Map();
  for (const actor of Array.from(game.actors ?? [])) {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  }

  for (const scene of Array.from(game.scenes ?? [])) {
    for (const token of Array.from(scene?.tokens ?? [])) {
      const actor = token?.actor;
      if (actor?.uuid) actors.set(actor.uuid, actor);
    }
  }

  for (const actor of actors.values()) {
    const legacyEffects = Array.from(actor.items ?? [])
      .filter(item => item.type === "effect" && isLegacySurroundedEffect(item));

    for (const effect of legacyEffects) {
      try {
        await effect.delete({ fastNriSystemEffectRemoval: true });
      } catch (error) {
        console.warn(`Быстрая НРИ | Не удалось удалить старый Effect «Окружён» у ${actor.name}`, error);
      }
    }

    const current = relativeOffGuardState(actor);
    const next = replaceRelativeOffGuardReasonState(
      current,
      LEGACY_SURROUNDED_EFFECT_ID,
      []
    );

    if (JSON.stringify(current) !== JSON.stringify(next)) {
      try {
        if (next.length) await actor.setFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG, next);
        else await actor.unsetFlag(SYSTEM_ID, RELATIVE_OFF_GUARD_FLAG);
      } catch (error) {
        console.warn(`Быстрая НРИ | Не удалось очистить старое относительное Окружение у ${actor.name}`, error);
      }
    }
  }

  const sources = Array.from(game.items ?? [])
    .filter(item => item.type === "effect" && isLegacySurroundedEffect(item));

  for (const source of sources) {
    try {
      await source.delete();
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось удалить старый мировой Effect «Окружён»", error);
    }
  }

  refreshNativeEffectHud();
  return true;
}

export function effectSourceKey(effectOrUuid) {
  if (typeof effectOrUuid === "string") {
    return String(effectOrUuid).trim();
  }

  return String(
    effectOrUuid?.system?.sourceUuid
    || effectOrUuid?.uuid
    || ""
  ).trim();
}

export function appliedEffectForSource(actor, effectOrUuid) {
  const sourceKey = effectSourceKey(effectOrUuid);
  if (!actor || !sourceKey) return null;

  return Array.from(actor.items ?? []).find(item =>
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

  refreshEffectTokenIcons(actor);

  return mirror;
}

/**
 * Refresh native effect icons on canvas Token placeables representing Actor.
 * Actor#getActiveTokens(..., false) must return placeables here because
 * renderFlags belongs to canvas Token, not TokenDocument.
 */
export function refreshEffectTokenIcons(actor) {
  let refreshed = 0;
  for (const token of actor?.getActiveTokens?.(false, false) ?? []) {
    if (!token?.renderFlags?.set) continue;
    token.renderFlags.set({ refreshEffects: true });
    refreshed += 1;
  }
  return refreshed;
}

async function deleteMirror(item) {
  const actor = item?.parent;
  if (!actor) return;

  const mirror = mirrorForItem(item);
  if (!mirror) return;

  await actor.deleteEmbeddedDocuments("ActiveEffect", [mirror.id], { fastNriSystemEffectRemoval: true });

  refreshEffectTokenIcons(actor);
}

export async function applyEffectToActor(sourceEffect, actor, { allowSystemOnly = false, actionContext = null } = {}) {
  if (!sourceEffect || sourceEffect.type !== "effect" || !actor) return null;
  if (isSystemOnlyEffect(sourceEffect) && !allowSystemOnly) return null;

  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.warn(`Нет прав на изменение ${actor.name}.`);
    return null;
  }

  const sourceKey = effectSourceKey(sourceEffect);
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

  const existing = appliedEffectForSource(actor, sourceKey);

  if (existing) {
    const next = addStackState(existing.system, timer);
    const update = {
      "system.runtime.stackCount": next.stackCount,
      "system.runtime.timers": next.timers
    };
    if (actionContext) {
      update["flags.fast-nri.actionContext"] = normalizeActionContext(actionContext);
    }

    await existing.update(update);

    await syncMirror(existing);
    refreshNativeEffectHud(actor);

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
  if (actionContext) {
    data.flags = foundry.utils.deepClone(data.flags ?? {});
    data.flags[SYSTEM_ID] = {
      ...(data.flags[SYSTEM_ID] ?? {}),
      actionContext: normalizeActionContext(actionContext)
    };
  }

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
    refreshNativeEffectHud(actor);
  }

  return embedded;
}

export async function removeOneEffectStack(effect) {
  if (!effect?.isEmbedded || effect.type !== "effect") return;
  if (isSystemOnlyEffect(effect)) return;

  const next = removeOneStackState(effect.system);

  if (next.deleteEffect) {
    const actor = effect.parent;
    await effect.delete();
    refreshNativeEffectHud(actor);
    return;
  }

  await effect.update({
    "system.runtime.stackCount": next.stackCount,
    "system.runtime.timers": next.timers
  });

  await syncMirror(effect);
  refreshNativeEffectHud(effect.parent);
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

  refreshNativeEffectHud();
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

  await applyEffectToActor(source, token.actor, {
    actionContext: data.fastNriActionContext ?? null
  });
}

export function effectDragData(effect, { actionContext = null } = {}) {
  return {
    type: "Item",
    uuid: effect.uuid,
    fastNriEffect: true,
    ...(actionContext ? { fastNriActionContext: normalizeActionContext(actionContext) } : {})
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

  const initialSeedComplete = Boolean(game.settings.get(SYSTEM_ID, SEED_SETTING));

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
    // После первоначального заполнения не восстанавливаем удалённые пользователем
    // ручные Effect. Системные источники при этом должны существовать всегда.
    .filter(effect => !initialSeedComplete || effect.systemOnly)
    .map(effect => ({
      name: effect.name,
      type: "effect",
      img: effect.img,
      folder: folder?.id ?? null,
      flags: {
        [SYSTEM_ID]: {
          builtinEffectId: effect.id,
          systemOnly: Boolean(effect.systemOnly)
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

  if (!initialSeedComplete) {
    await game.settings.set(SYSTEM_ID, SEED_SETTING, true);
  }
}

/**
 * Re-render Foundry's native Token HUD when it is currently open.
 * This updates active highlights and stack/duration tooltips in-place.
 */
export function refreshNativeEffectHud(actor = null) {
  const hud = canvas?.hud?.token;
  if (!hud?.rendered) return;

  if (
    actor?.uuid
    && hud.actor?.uuid
    && hud.actor.uuid !== actor.uuid
  ) {
    return;
  }

  void hud.render({ force: true });
}

export function activateEffectChatInteractions(root = document) {
  root.addEventListener("dragstart", event => {
    const element = event.target?.closest?.("[data-fast-nri-effect-drag]");
    if (!element) return;

    const effectUuid = element.dataset.effectUuid;
    const effect = effectUuid ? fromUuidSync(effectUuid) : null;
    if (!effect || effect.type !== "effect") return;

    const messageId = element.closest(".chat-message, .message")?.dataset?.messageId ?? null;
    const message = messageId ? game.messages?.get(messageId) : null;
    const actionContext = message?.getFlag(SYSTEM_ID, "actionContext") ?? null;

    event.dataTransfer?.setData(
      "text/plain",
      JSON.stringify(effectDragData(effect, { actionContext }))
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


  Hooks.on("preDeleteItem", (item, options) => {
    if (item.type !== "effect" || !item.isEmbedded) return;
    if (!isSystemOnlyEffect(item)) return;
    if (options?.fastNriSystemEffectRemoval) return;
    return false;
  });

  Hooks.on("preDeleteActiveEffect", (activeEffect, options) => {
    if (options?.fastNriSystemEffectRemoval) return;

    const itemId = activeEffect.getFlag?.(SYSTEM_ID, "effectItemId");
    const actor = activeEffect.parent;
    if (!itemId || !actor) return;

    const effectItem = actor.items.get(itemId);
    if (effectItem?.type === "effect" && isSystemOnlyEffect(effectItem)) {
      return false;
    }
  });

  Hooks.on("createItem", (item, options, userId) => {
    if (item.type !== "effect") return;

    if (
      item.isEmbedded
      && userId === game.user.id
      && !options?.fastNriEffectApply
    ) {
      void syncMirror(item);
    }

    refreshNativeEffectHud(item.parent?.documentName === "Actor" ? item.parent : null);
  });

  Hooks.on("updateItem", (item, _changes, _options, userId) => {
    if (item.type !== "effect") return;

    if (item.isEmbedded && userId === game.user.id) {
      void syncMirror(item);
    }

    refreshNativeEffectHud(item.parent?.documentName === "Actor" ? item.parent : null);
  });

  Hooks.on("deleteItem", (item, _options, userId) => {
    if (item.type !== "effect") return;

    if (item.isEmbedded && userId === game.user.id) {
      void deleteMirror(item);
    }

    refreshNativeEffectHud(item.parent?.documentName === "Actor" ? item.parent : null);
  });

  Hooks.on("deleteActiveEffect", (activeEffect, _options, userId) => {
    if (userId !== game.user.id) return;

    const itemId = activeEffect.getFlag?.(SYSTEM_ID, "effectItemId");
    const actor = activeEffect.parent;

    if (!itemId || !actor) return;

    const effectItem = actor.items.get(itemId);
    if (effectItem?.type === "effect" && !isSystemOnlyEffect(effectItem)) {
      // Removing the visual mirror is interpreted as manually removing
      // the gameplay Effect Item as well for ordinary user-managed effects.
      void effectItem.delete();
    }
  });

  refreshNativeEffectHud();
}
