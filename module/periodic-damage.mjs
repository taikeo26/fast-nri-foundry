import {
  CREATURE_TRAITS,
  RESISTANCE_TRAITS,
  creatureTraitLabel
} from "./config.mjs";
import { normalizeActionContext } from "./action-context.mjs";
import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";

const SYSTEM_ID = "fast-nri";
const BASE_REMOVAL_DC = 11;
const propertyRuleRegistry = new Map();
let lastAppliedOrder = 0;

function esc(value) {
  const text = String(value ?? "");
  return globalThis.foundry?.utils?.escapeHTML
    ? foundry.utils.escapeHTML(text)
    : text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function deepClone(value) {
  if (globalThis.foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values = []) {
  return Array.from(new Set(
    Array.from(values ?? [])
      .map(value => String(value ?? "").trim())
      .filter(Boolean)
  ));
}

function clampInteger(value, minimum = 0) {
  const number = Math.trunc(Number(value) || 0);
  return Math.max(minimum, number);
}

function currentAppliedOrder() {
  const now = Date.now();
  lastAppliedOrder = Math.max(now, lastAppliedOrder + 1);
  return lastAppliedOrder;
}

export function isPeriodicEffect(effectOrSystem) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  return String(system.effectKind ?? "") === "periodic";
}

export function periodicPropertyIds(effectOrSystem) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  return uniqueStrings(system.periodic?.propertyIds ?? []);
}

export function validatePeriodicPropertyIds(propertyIds = []) {
  const ids = uniqueStrings(propertyIds);
  return {
    valid: ids.includes("physical") || ids.includes("magic"),
    propertyIds: ids,
    missingBaseProperty: !ids.includes("physical") && !ids.includes("magic")
  };
}

function actorResistanceEntries(actor) {
  const system = actor?.system ?? actor ?? {};
  const selected = new Set(system.resistanceIds ?? []);
  const legacy = {
    universal: Number(system.resistances?.universal) || 0,
    physical: Number(system.resistances?.physical) || 0,
    magic: Number(system.resistances?.magic) || 0
  };

  for (const [id, value] of Object.entries(legacy)) {
    if (value > 0) selected.add(id);
  }

  return Array.from(selected).map(id => ({
    id,
    label: RESISTANCE_TRAITS[id] ?? CREATURE_TRAITS[id] ?? id,
    value: Math.max(0, Number(system.resistanceValues?.[id]) || legacy[id] || 0)
  })).filter(entry => entry.value > 0);
}

function actorVulnerabilityEntries(actor) {
  const system = actor?.system ?? actor ?? {};
  return Array.from(system.vulnerabilityIds ?? []).map(id => ({
    id,
    label: CREATURE_TRAITS[id] ?? id,
    value: Math.max(0, Number(system.vulnerabilityValues?.[id]) || 0)
  })).filter(entry => entry.value > 0);
}

export function resolvePeriodicValueAgainstActor({ storedValue = 0, propertyIds = [] } = {}, actor) {
  const value = Math.trunc(Number(storedValue) || 0);
  const properties = uniqueStrings(propertyIds);
  const system = actor?.system ?? actor ?? {};
  const immunityIds = new Set(system.immunityIds ?? []);
  const immunityId = properties.find(id => immunityIds.has(id)) ?? null;

  if (immunityId) {
    return {
      storedValue: value,
      propertyIds: properties,
      immunityId,
      immunityLabel: creatureTraitLabel(immunityId),
      matchingResistances: [],
      matchingVulnerabilities: [],
      resistance: null,
      vulnerability: null,
      finalValue: 0,
      removedByImmunity: true,
      nonPositive: false
    };
  }

  const propertySet = new Set(properties);
  const matchingResistances = actorResistanceEntries(actor)
    .filter(entry => entry.id === "universal" || propertySet.has(entry.id))
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));
  const matchingVulnerabilities = actorVulnerabilityEntries(actor)
    .filter(entry => propertySet.has(entry.id))
    .sort((a, b) => b.value - a.value || String(a.id).localeCompare(String(b.id)));

  const resistance = matchingResistances[0] ?? null;
  const vulnerability = matchingVulnerabilities[0] ?? null;
  const finalValue = value - (resistance?.value ?? 0) + (vulnerability?.value ?? 0);

  return {
    storedValue: value,
    propertyIds: properties,
    immunityId: null,
    immunityLabel: "",
    matchingResistances,
    matchingVulnerabilities,
    resistance,
    vulnerability,
    finalValue,
    removedByImmunity: false,
    nonPositive: finalValue <= 0
  };
}

function normalizePropertyRule(rule = {}) {
  return {
    removalModifier: Math.trunc(Number(rule.removalModifier) || 0),
    disableStandardRemovalCheck: Boolean(rule.disableStandardRemovalCheck),
    abilityUuids: uniqueStrings(rule.abilityUuids ?? [])
  };
}

export function registerPeriodicPropertyRule(propertyId, rule = {}) {
  const id = String(propertyId ?? "").trim();
  if (!id) return null;
  const normalized = normalizePropertyRule(rule);
  propertyRuleRegistry.set(id, normalized);
  return normalized;
}

export function unregisterPeriodicPropertyRule(propertyId) {
  return propertyRuleRegistry.delete(String(propertyId ?? "").trim());
}

export function clearPeriodicPropertyRules() {
  propertyRuleRegistry.clear();
}

export function periodicRemovalConfig(effectOrSystem, registry = propertyRuleRegistry) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  const ids = periodicPropertyIds(system);
  const rules = ids.map(id => normalizePropertyRule(registry.get?.(id) ?? registry[id] ?? {}));
  const positive = rules.map(rule => rule.removalModifier).filter(value => value > 0);
  const negative = rules.map(rule => rule.removalModifier).filter(value => value < 0);
  const bonus = positive.length ? Math.max(...positive) : 0;
  const penalty = negative.length ? Math.min(...negative) : 0;
  const disabledByProperty = rules.some(rule => rule.disableStandardRemovalCheck);
  const enabledByEffect = system.periodic?.standardRemovalCheck !== false;
  const abilityUuids = uniqueStrings(rules.flatMap(rule => rule.abilityUuids));

  return {
    enabled: enabledByEffect && !disabledByProperty,
    dc: BASE_REMOVAL_DC,
    bonus,
    penalty,
    modifier: bonus + penalty,
    disabledByProperty,
    abilityUuids
  };
}

export function periodicDurationState(effectOrSystem) {
  const system = effectOrSystem?.system ?? effectOrSystem ?? {};
  const configured = clampInteger(system.periodic?.durationTicks, 0);
  const stored = clampInteger(system.periodic?.runtime?.remainingTicks, 0);
  if (configured <= 0) {
    return { finite: false, configured: 0, remaining: 0, isLastTick: false };
  }
  const remaining = stored > 0 ? stored : configured;
  return {
    finite: true,
    configured,
    remaining,
    isLastTick: remaining <= 1
  };
}

export function periodicDurationLabel(effectOrSystem) {
  const state = periodicDurationState(effectOrSystem);
  if (!state.finite) return "Без ограничения по времени";
  return `${state.remaining} ${state.remaining === 1 ? "срабатывание" : "срабатываний"}`;
}

export function sortPeriodicSnapshot(effects = []) {
  return Array.from(effects ?? [])
    .filter(effect => isPeriodicEffect(effect))
    .sort((a, b) => {
      const av = Number(a?.system?.periodic?.runtime?.storedValue) || 0;
      const bv = Number(b?.system?.periodic?.runtime?.storedValue) || 0;
      if (av !== bv) return bv - av;
      const ao = Number(a?.system?.periodic?.runtime?.appliedOrder) || 0;
      const bo = Number(b?.system?.periodic?.runtime?.appliedOrder) || 0;
      if (ao !== bo) return ao - bo;
      return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
}

export async function rollPeriodicStoredValue(formula) {
  const source = String(formula ?? "").trim();
  if (!source) throw new Error("Не указано значение Периодического урона.");
  const roll = await new Roll(source).evaluate();
  const total = Math.trunc(Number(roll.total));
  if (!Number.isFinite(total)) throw new Error("Формула Периодического урона не дала числовой результат.");
  return { roll, total };
}

async function resolveSourceLabel(effect) {
  const context = effect?.getFlag?.(SYSTEM_ID, "actionContext") ?? null;
  const sourceName = String(context?.source?.name ?? "").trim();
  if (sourceName) return sourceName;
  const uuid = String(effect?.system?.sourceUuid ?? "").trim();
  if (!uuid) return "";
  try {
    const document = await fromUuid(uuid);
    return document?.name ?? "";
  } catch (_error) {
    return "";
  }
}

function periodicPropertiesHTML(propertyIds = []) {
  return uniqueStrings(propertyIds)
    .map(id => `<span class="fast-nri-periodic-property">${esc(creatureTraitLabel(id))}</span>`)
    .join("");
}

function resolutionRowsHTML(resolution) {
  if (resolution.removedByImmunity) {
    return `<div class="fast-nri-periodic-resolution-row danger">Иммунитет: <strong>${esc(resolution.immunityLabel)}</strong></div>`;
  }
  return `
    ${resolution.resistance ? `<div class="fast-nri-periodic-resolution-row">Устойчивость: <strong>${esc(resolution.resistance.label)} −${esc(resolution.resistance.value)}</strong></div>` : ""}
    ${resolution.vulnerability ? `<div class="fast-nri-periodic-resolution-row">Уязвимость: <strong>${esc(resolution.vulnerability.label)} +${esc(resolution.vulnerability.value)}</strong></div>` : ""}
    <div class="fast-nri-periodic-resolution-row">Урон этого тика: <strong>${esc(resolution.finalValue)}</strong></div>`;
}

export async function periodicSpecialAbilityRows(effect) {
  const config = periodicRemovalConfig(effect);
  const rows = [];
  for (const uuid of config.abilityUuids) {
    let ability = null;
    try { ability = await fromUuid(uuid); } catch (_error) { ability = null; }
    rows.push({ uuid, name: ability?.name ?? uuid, available: ability?.type === "ability" });
  }
  return rows;
}

function tickCardHTML({ effect, actor, resolution, sourceLabel = "", abilities = [], resolved = false, result = null, undone = false }) {
  const runtime = effect?.system?.periodic?.runtime ?? {};
  const removal = periodicRemovalConfig(effect);
  const duration = periodicDurationState(effect);
  const buttonLabel = removal.enabled ? "Проверка / Применить урон" : "Применить урон";
  const abilityHTML = abilities.length
    ? `<div class="fast-nri-periodic-special-actions"><small>Специальные способы снятия:</small>${abilities.map(row => row.available
      ? `<button type="button" data-fast-nri-periodic-removal-ability data-effect-uuid="${escAttr(effect.uuid)}" data-ability-uuid="${escAttr(row.uuid)}"><i class="fa-solid fa-kit-medical"></i>${esc(row.name)}</button>`
      : `<span class="fast-nri-periodic-missing-ability" title="Ability не найдена">${esc(row.name)}</span>`).join("")}</div>`
    : "";

  const resultHTML = result ? `
    <div class="fast-nri-periodic-result ${result.removed ? "removed" : ""}">
      <div>Периодический урон: <strong>${esc(result.damage ?? 0)}</strong> · обычные HP: <strong>${esc(result.previousHp ?? 0)} → ${esc(result.afterHp ?? 0)}</strong></div>
      ${result.deathCounterChanged ? `<div>Счётчик смерти: <strong>${esc(result.previousDeathCounter)} → ${esc(result.afterDeathCounter)}</strong>${result.deathCounterRoll ? ` <small>(1d4+3 = ${esc(result.deathCounterRoll)})</small>` : ""}</div>` : ""}
      ${result.removalRoll ? `<div>Проверка снятия: <strong>${esc(result.removalRoll.natural)}${result.removalRoll.modifier ? ` ${result.removalRoll.modifier > 0 ? "+" : ""}${esc(result.removalRoll.modifier)}` : ""} = ${esc(result.removalRoll.total)}</strong> против ${esc(result.removalRoll.dc)} — ${result.removalRoll.success ? "эффект снят" : "эффект остаётся"}</div>` : ""}
      ${result.durationExpired ? `<div>Длительность закончилась после этого тика.</div>` : ""}
      ${result.removedReason ? `<div>${esc(result.removedReason)}</div>` : ""}
      ${undone ? `<div><strong>Тик отменён.</strong></div>` : ""}
    </div>` : "";

  return `
    <div class="fast-nri-periodic-tick-card ${resolved ? "resolved" : ""} ${undone ? "undone" : ""}">
      <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-hourglass-half"></i><strong>Периодический урон: ${esc(effect.name)}</strong></div>
      <div class="fast-nri-periodic-meta"><span>Цель: <strong>${esc(actor?.name ?? "Цель")}</strong></span>${sourceLabel ? `<span>Источник: <strong>${esc(sourceLabel)}</strong></span>` : ""}</div>
      <div class="fast-nri-periodic-properties">${periodicPropertiesHTML(effect.system?.periodic?.propertyIds)}</div>
      <label class="fast-nri-periodic-stored-editor">Сохранённое значение
        <input type="number" step="1" data-fast-nri-periodic-stored-value data-effect-uuid="${escAttr(effect.uuid)}" value="${escAttr(runtime.storedValue ?? 0)}" ${resolved ? "disabled" : ""} />
      </label>
      <div class="fast-nri-periodic-resolution">${resolutionRowsHTML(resolution)}</div>
      <div class="fast-nri-periodic-meta"><span>Длительность: <strong>${esc(periodicDurationLabel(effect))}</strong></span>${duration.finite && duration.isLastTick ? `<span>Последний тик</span>` : ""}</div>
      ${removal.enabled ? `<div class="fast-nri-periodic-meta"><span>Снятие: <strong>1d20${removal.modifier ? ` ${removal.modifier > 0 ? "+" : ""}${esc(removal.modifier)}` : ""} против ${esc(removal.dc)}</strong></span></div>` : `<div class="fast-nri-periodic-meta"><span>Стандартная проверка снятия отключена.</span></div>`}
      ${abilityHTML}
      ${resolved ? resultHTML : `<button type="button" class="fast-nri-periodic-resolve-button" data-fast-nri-periodic-resolve data-effect-uuid="${escAttr(effect.uuid)}"><i class="fa-solid fa-heart-crack"></i>${esc(buttonLabel)}</button>`}
      ${resolved && !undone ? `<button type="button" class="fast-nri-periodic-undo-button" data-fast-nri-periodic-undo><i class="fa-solid fa-rotate-left"></i>Вернуть</button>` : ""}
    </div>`;
}

function removedWithoutDamageHTML({ effectName, actorName, reason, sourceLabel = "", undone = false, undoAvailable = true }) {
  return `
    <div class="fast-nri-periodic-tick-card resolved ${undone ? "undone" : ""}">
      <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-hourglass-end"></i><strong>Периодический урон: ${esc(effectName)}</strong></div>
      <div class="fast-nri-periodic-meta"><span>Цель: <strong>${esc(actorName)}</strong></span>${sourceLabel ? `<span>Источник: <strong>${esc(sourceLabel)}</strong></span>` : ""}</div>
      <div class="fast-nri-periodic-result removed"><strong>${esc(reason)}</strong>${undone ? `<div>Снятие отменено.</div>` : ""}</div>
      ${undone || !undoAvailable ? "" : `<button type="button" class="fast-nri-periodic-undo-button" data-fast-nri-periodic-undo><i class="fa-solid fa-rotate-left"></i>Вернуть</button>`}
    </div>`;
}

async function createRemovedMessage({ actor, effect, reason, effectSnapshot = null, sourceLabel = "" }) {
  const resolvedSourceLabel = sourceLabel || await resolveSourceLabel(effect);
  const snapshot = effectSnapshot ?? effect.toObject();
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: removedWithoutDamageHTML({ effectName: effect.name, actorName: actor.name, reason, sourceLabel: resolvedSourceLabel }),
    flags: {
      [SYSTEM_ID]: {
        kind: "periodic-tick-resolved",
        actorUuid: actor.uuid,
        effectUuid: effect.uuid,
        effectName: effect.name,
        sourceLabel: resolvedSourceLabel,
        resolved: true,
        undone: false,
        periodicUndo: {
          effectSnapshot: snapshot,
          effectWasDeleted: true,
          hpLost: 0,
          previousDeathCounter: Number(actor.system?.deathCounter) || 0,
          afterDeathCounter: Number(actor.system?.deathCounter) || 0
        },
        periodicResult: { hpLost: 0, removed: true, removedReason: reason }
      }
    }
  });
}

export async function postPeriodicApplicationRejected(actor, sourceEffect, resolution, { storedValue = 0 } = {}) {
  if (!actor || !sourceEffect) return null;
  const reason = resolution?.removedByImmunity
    ? `Периодический эффект не наложен: Иммунитет «${resolution.immunityLabel}».`
    : `Периодический эффект не наложен: ${storedValue} − ${resolution?.resistance?.value ?? 0} + ${resolution?.vulnerability?.value ?? 0} = ${resolution?.finalValue ?? 0}.`;
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `
      <div class="fast-nri-periodic-tick-card resolved">
        <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-ban"></i><strong>${esc(sourceEffect.name)}</strong></div>
        <div class="fast-nri-periodic-result removed"><strong>${esc(reason)}</strong></div>
      </div>`,
    flags: { [SYSTEM_ID]: { kind: "periodic-application-rejected", actorUuid: actor.uuid, sourceEffectUuid: sourceEffect.uuid, reason } }
  });
}

export async function applyPeriodicEffectToActor(sourceEffect, actor, {
  allowSystemOnly = false,
  actionContext = null,
  sourceKey = "",
  storedValue = null,
  onCreated = null
} = {}) {
  if (!sourceEffect || sourceEffect.type !== "effect" || !isPeriodicEffect(sourceEffect) || !actor) return null;
  if (sourceEffect.getFlag?.(SYSTEM_ID, "systemOnly") && !allowSystemOnly) return null;

  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.warn(`Нет прав на изменение ${actor.name}.`);
    return null;
  }

  const validation = validatePeriodicPropertyIds(sourceEffect.system?.periodic?.propertyIds ?? []);
  if (!validation.valid) {
    ui.notifications.warn(`${sourceEffect.name}: Периодический эффект должен иметь свойство «Физический» или «Магический». Наложение не выполнено.`);
    return null;
  }

  let rolled = null;
  let value = storedValue;
  try {
    const explicitStoredValue = value !== null
      && value !== undefined
      && String(value).trim() !== ""
      && Number.isFinite(Number(value));
    if (!explicitStoredValue) {
      rolled = await rollPeriodicStoredValue(sourceEffect.system?.periodic?.valueFormula ?? "");
      value = rolled.total;
    }
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка броска Периодического урона", error);
    ui.notifications.error(`${sourceEffect.name}: ${error.message}`);
    return null;
  }
  value = Math.trunc(Number(value) || 0);

  const resolution = resolvePeriodicValueAgainstActor({ storedValue: value, propertyIds: validation.propertyIds }, actor);
  if (resolution.removedByImmunity || resolution.finalValue <= 0) {
    await postPeriodicApplicationRejected(actor, sourceEffect, resolution, { storedValue: value });
    return null;
  }

  const data = sourceEffect.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;
  data.system = deepClone(data.system ?? {});
  data.system.effectKind = "periodic";
  data.system.sourceUuid = sourceKey || sourceEffect.uuid || "";
  const durationTicks = clampInteger(data.system.periodic?.durationTicks, 0);
  data.system.periodic = {
    ...(data.system.periodic ?? {}),
    propertyIds: validation.propertyIds,
    runtime: {
      storedValue: value,
      remainingTicks: durationTicks,
      appliedOrder: currentAppliedOrder()
    }
  };
  data.system.runtime = {
    stackCount: 1,
    mirrorEffectId: "",
    timers: []
  };
  data.system.stacking = { mode: "none" };
  data.effects = [];

  if (actionContext) {
    data.flags = deepClone(data.flags ?? {});
    data.flags[SYSTEM_ID] = {
      ...(data.flags[SYSTEM_ID] ?? {}),
      actionContext: normalizeActionContext(actionContext)
    };
  }

  const created = await actor.createEmbeddedDocuments("Item", [data], { fastNriEffectApply: true });
  const embedded = created?.[0] ?? null;
  if (embedded && typeof onCreated === "function") await onCreated(embedded);
  return embedded;
}

async function preparePeriodicTick(effect, actor) {
  const storedValue = Number(effect.system?.periodic?.runtime?.storedValue) || 0;
  const resolution = resolvePeriodicValueAgainstActor({ storedValue, propertyIds: periodicPropertyIds(effect) }, actor);
  const snapshot = effect.toObject();

  const sourceLabel = await resolveSourceLabel(effect);

  if (resolution.removedByImmunity) {
    const reason = `Эффект снят: появился Иммунитет «${resolution.immunityLabel}».`;
    await effect.delete();
    return createRemovedMessage({ actor, effect, reason, effectSnapshot: snapshot, sourceLabel });
  }

  if (resolution.finalValue <= 0) {
    const reason = `Эффект снят: ${storedValue} − ${resolution.resistance?.value ?? 0} + ${resolution.vulnerability?.value ?? 0} = ${resolution.finalValue}.`;
    await effect.delete();
    return createRemovedMessage({ actor, effect, reason, effectSnapshot: snapshot, sourceLabel });
  }

  const abilities = await periodicSpecialAbilityRows(effect);
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: tickCardHTML({ effect, actor, resolution, sourceLabel, abilities }),
    flags: {
      [SYSTEM_ID]: {
        kind: "periodic-tick",
        actorUuid: actor.uuid,
        effectUuid: effect.uuid,
        effectName: effect.name,
        sourceLabel,
        resolved: false,
        undone: false,
        periodicPrepared: {
          storedValue,
          resolution,
          duration: periodicDurationState(effect)
        }
      }
    }
  });
}

export async function processPeriodicTurnEnd(actor) {
  if (!actor) return [];
  const snapshot = sortPeriodicSnapshot(
    Array.from(actor.items ?? []).filter(item => item.type === "effect" && isPeriodicEffect(item))
  );
  const messages = [];
  for (const snap of snapshot) {
    const live = actor.items?.get?.(snap.id) ?? null;
    if (!live || !isPeriodicEffect(live)) continue;
    const message = await preparePeriodicTick(live, actor);
    if (message) messages.push(message);
  }
  return messages;
}

async function actorFromUuid(uuid) {
  try { return uuid ? await fromUuid(uuid) : null; }
  catch (_error) { return null; }
}

async function effectFromMessage(message) {
  const uuid = message?.getFlag(SYSTEM_ID, "effectUuid") ?? "";
  try { return uuid ? await fromUuid(uuid) : null; }
  catch (_error) { return null; }
}

async function refreshTickMessage(message, effect, actor) {
  if (!message || !effect || !actor) return null;
  const storedValue = Number(effect.system?.periodic?.runtime?.storedValue) || 0;
  const resolution = resolvePeriodicValueAgainstActor({ storedValue, propertyIds: periodicPropertyIds(effect) }, actor);
  const abilities = await periodicSpecialAbilityRows(effect);
  const sourceLabel = message.getFlag(SYSTEM_ID, "sourceLabel") || await resolveSourceLabel(effect);
  await message.update({
    content: tickCardHTML({ effect, actor, resolution, sourceLabel, abilities }),
    [`flags.${SYSTEM_ID}.periodicPrepared`]: {
      storedValue,
      resolution,
      duration: periodicDurationState(effect)
    }
  });
  return resolution;
}

async function updateStoredValueFromCard(input) {
  const messageId = input?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  const message = messageId ? game.messages?.get(messageId) : null;
  if (!message || message.getFlag(SYSTEM_ID, "kind") !== "periodic-tick" || message.getFlag(SYSTEM_ID, "resolved")) return;
  const effect = await effectFromMessage(message);
  if (!effect) return ui.notifications.warn("Периодический эффект уже отсутствует.");
  const actor = effect.parent;
  const next = Math.trunc(Number(input.value) || 0);
  await effect.update({ "system.periodic.runtime.storedValue": next });
  await refreshTickMessage(message, effect, actor);
}

async function rollRemovalCheck(effect) {
  const config = periodicRemovalConfig(effect);
  if (!config.enabled) return null;
  const roll = await new Roll(`1d20${config.modifier ? ` ${config.modifier > 0 ? "+" : "-"} ${Math.abs(config.modifier)}` : ""}`).evaluate();
  const natural = Number(roll.dice?.[0]?.results?.[0]?.result) || Number(roll.total) - config.modifier;
  const total = Number(roll.total) || 0;
  return { natural, total, modifier: config.modifier, dc: config.dc, success: total >= config.dc };
}

export function periodicDamageTransition({
  actorType = "character",
  hp = 0,
  tempHp = 0,
  deathCounter = 0,
  damage = 0,
  rolledDeathCounter = null
} = {}) {
  const previousHp = Math.max(0, Number(hp) || 0);
  const previousTemp = Math.max(0, Number(tempHp) || 0);
  const previousDeathCounter = Math.max(0, Number(deathCounter) || 0);
  const appliedDamage = Math.max(0, Math.trunc(Number(damage) || 0));
  const afterHp = Math.max(0, previousHp - appliedDamage);
  const hpLost = previousHp - afterHp;
  const needsDeathCounterRoll = actorType === "character"
    && appliedDamage > 0
    && previousHp > 0
    && afterHp === 0;

  let afterDeathCounter = previousDeathCounter;
  if (actorType === "character" && appliedDamage > 0) {
    if (needsDeathCounterRoll && Number.isFinite(Number(rolledDeathCounter))) {
      afterDeathCounter = Math.max(0, Math.trunc(Number(rolledDeathCounter)) - 1);
    } else if (previousHp === 0) {
      afterDeathCounter = Math.max(0, previousDeathCounter - 1);
    }
  }

  return {
    damage: appliedDamage,
    previousHp,
    afterHp,
    hpLost,
    previousTemp,
    // Периодический урон всегда обходит временные HP.
    afterTemp: previousTemp,
    previousDeathCounter,
    afterDeathCounter,
    needsDeathCounterRoll
  };
}

async function createDeathCounter() {
  const roll = await new Roll("1d4 + 3").evaluate();
  return { total: Math.max(0, Math.trunc(Number(roll.total) || 0)), roll };
}

async function resolvePeriodicTickFromCard(button) {
  const messageId = button?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  const message = messageId ? game.messages?.get(messageId) : null;
  if (!message || message.getFlag(SYSTEM_ID, "kind") !== "periodic-tick") return null;
  if (message.getFlag(SYSTEM_ID, "resolved")) return ui.notifications.info("Этот тик уже обработан.");

  const effect = await effectFromMessage(message);
  if (!effect || !isPeriodicEffect(effect)) {
    const actor = await actorFromUuid(message.getFlag(SYSTEM_ID, "actorUuid"));
    const effectName = message.getFlag(SYSTEM_ID, "effectName") || "Периодический эффект";
    const sourceLabel = message.getFlag(SYSTEM_ID, "sourceLabel") || "";
    const reason = "Эффект уже снят до разрешения этого тика. Урон не применяется.";
    await message.update({
      content: removedWithoutDamageHTML({ effectName, actorName: actor?.name ?? "Цель", reason, sourceLabel, undoAvailable: false }),
      [`flags.${SYSTEM_ID}.kind`]: "periodic-tick-resolved",
      [`flags.${SYSTEM_ID}.resolved`]: true,
      [`flags.${SYSTEM_ID}.periodicResult`]: { hpLost: 0, removed: true, removedReason: reason }
    });
    ui.notifications.info(reason);
    return null;
  }
  const actor = effect.parent;
  if (!actor) return null;
  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.warn(`Нет прав на изменение ${actor.name}.`);
    return null;
  }

  const storedValue = Number(effect.system?.periodic?.runtime?.storedValue) || 0;
  const resolution = resolvePeriodicValueAgainstActor({ storedValue, propertyIds: periodicPropertyIds(effect) }, actor);
  const sourceLabel = message.getFlag(SYSTEM_ID, "sourceLabel") || await resolveSourceLabel(effect);
  const effectSnapshot = effect.toObject();
  const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
  const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
  const previousDeathCounter = Math.max(0, Number(actor.system?.deathCounter) || 0);

  if (resolution.removedByImmunity || resolution.finalValue <= 0) {
    const reason = resolution.removedByImmunity
      ? `Эффект снят: появился Иммунитет «${resolution.immunityLabel}».`
      : `Эффект снят: ${storedValue} − ${resolution.resistance?.value ?? 0} + ${resolution.vulnerability?.value ?? 0} = ${resolution.finalValue}.`;
    await effect.delete();
    const result = { hpLost: 0, removed: true, removedReason: reason };
    await message.update({
      content: removedWithoutDamageHTML({ effectName: effect.name, actorName: actor.name, reason, sourceLabel }),
      [`flags.${SYSTEM_ID}.kind`]: "periodic-tick-resolved",
      [`flags.${SYSTEM_ID}.resolved`]: true,
      [`flags.${SYSTEM_ID}.periodicResult`]: result,
      [`flags.${SYSTEM_ID}.periodicUndo`]: {
        effectSnapshot,
        effectWasDeleted: true,
        previousHp,
        afterHp: previousHp,
        hpLost: 0,
        previousTemp,
        afterTemp: previousTemp,
        previousDeathCounter,
        afterDeathCounter: previousDeathCounter
      }
    });
    return result;
  }

  const damage = Math.max(1, Math.trunc(resolution.finalValue));
  let transition = periodicDamageTransition({
    actorType: actor.type,
    hp: previousHp,
    tempHp: previousTemp,
    deathCounter: previousDeathCounter,
    damage
  });
  let deathCounterRoll = null;
  if (transition.needsDeathCounterRoll) {
    const created = await createDeathCounter();
    deathCounterRoll = created.total;
    transition = periodicDamageTransition({
      actorType: actor.type,
      hp: previousHp,
      tempHp: previousTemp,
      deathCounter: previousDeathCounter,
      damage,
      rolledDeathCounter: created.total
    });
  }
  const { afterHp, hpLost, afterDeathCounter } = transition;

  const update = { "system.hp.value": afterHp };
  if (actor.type === "character" && afterDeathCounter !== previousDeathCounter) {
    update["system.deathCounter"] = afterDeathCounter;
  }
  await actor.update(update, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });

  const duration = periodicDurationState(effect);
  let removalRoll = null;
  let removed = false;
  let durationExpired = false;
  let removedReason = "";
  let remainingAfter = duration.remaining;

  if (duration.finite) {
    remainingAfter = Math.max(0, duration.remaining - 1);
    if (duration.isLastTick) {
      durationExpired = true;
      removed = true;
      removedReason = "Эффект снят после последнего тика по длительности.";
    }
  }

  if (!removed) {
    removalRoll = await rollRemovalCheck(effect);
    if (removalRoll?.success) {
      removed = true;
      removedReason = "Эффект снят успешной проверкой.";
    }
  }

  if (removed) {
    await effect.delete();
  } else if (duration.finite) {
    await effect.update({ "system.periodic.runtime.remainingTicks": remainingAfter });
  }

  const afterEffectSnapshot = removed ? null : effect.toObject();
  const result = {
    damage,
    hpLost,
    previousHp,
    afterHp,
    previousTemp,
    afterTemp: previousTemp,
    previousDeathCounter,
    afterDeathCounter,
    deathCounterChanged: afterDeathCounter !== previousDeathCounter,
    deathCounterRoll,
    removalRoll,
    removed,
    durationExpired,
    removedReason,
    remainingAfter
  };
  const cardEffect = removed ? {
    name: effectSnapshot.name ?? effect.name,
    uuid: message.getFlag(SYSTEM_ID, "effectUuid") || effect.uuid,
    system: effectSnapshot.system
  } : effect;
  const abilities = removed ? [] : await periodicSpecialAbilityRows(effect);
  await message.update({
    content: tickCardHTML({ effect: cardEffect, actor, resolution, sourceLabel, abilities, resolved: true, result }),
    [`flags.${SYSTEM_ID}.kind`]: "periodic-tick-resolved",
    [`flags.${SYSTEM_ID}.resolved`]: true,
    [`flags.${SYSTEM_ID}.periodicResult`]: result,
    [`flags.${SYSTEM_ID}.periodicUndo`]: {
      effectSnapshot,
      afterEffectSnapshot,
      effectWasDeleted: removed,
      previousHp,
      afterHp,
      hpLost,
      previousTemp,
      afterTemp: previousTemp,
      previousDeathCounter,
      afterDeathCounter
    }
  });

  return result;
}

async function restoreEffectSnapshot(actor, snapshot) {
  if (!actor || !snapshot) return null;
  const data = deepClone(snapshot);
  try {
    const created = await actor.createEmbeddedDocuments("Item", [data], { keepId: true });
    return created?.[0] ?? null;
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось восстановить Periodic Effect с исходным ID, создаём новый", error);
    delete data._id;
    const created = await actor.createEmbeddedDocuments("Item", [data]);
    return created?.[0] ?? null;
  }
}

async function undoPeriodicTick(button) {
  const messageId = button?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  const message = messageId ? game.messages?.get(messageId) : null;
  if (!message || message.getFlag(SYSTEM_ID, "kind") !== "periodic-tick-resolved") return null;
  if (message.getFlag(SYSTEM_ID, "undone")) return ui.notifications.info("Этот тик уже отменён.");

  const undo = message.getFlag(SYSTEM_ID, "periodicUndo") ?? null;
  const actor = await actorFromUuid(message.getFlag(SYSTEM_ID, "actorUuid"));
  if (!undo || !actor) return ui.notifications.error("Не удалось получить данные для Undo Периодического урона.");

  const currentHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
  const maxHp = Math.max(0, Number(actor.system?.hp?.max) || 0);
  const restoredHp = Math.min(maxHp || Number.POSITIVE_INFINITY, currentHp + Math.max(0, Number(undo.hpLost) || 0));
  const currentDeathCounter = Math.max(0, Number(actor.system?.deathCounter) || 0);
  const update = { "system.hp.value": Math.max(0, restoredHp) };
  if (actor.type === "character") {
    if (currentDeathCounter === Math.max(0, Number(undo.afterDeathCounter) || 0)) {
      update["system.deathCounter"] = Math.max(0, Number(undo.previousDeathCounter) || 0);
    } else if (Number(undo.previousDeathCounter) !== Number(undo.afterDeathCounter)) {
      ui.notifications.warn("Счётчик смерти изменился после этого тика. HP будут возвращены, но более новое значение счётчика смерти сохранено.");
    }
  }
  await actor.update(update, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });

  let effect = null;
  const effectUuid = message.getFlag(SYSTEM_ID, "effectUuid");
  try { effect = effectUuid ? await fromUuid(effectUuid) : null; } catch (_error) { effect = null; }

  if (undo.effectWasDeleted) {
    if (!effect) effect = await restoreEffectSnapshot(actor, undo.effectSnapshot);
  } else if (effect && undo.effectSnapshot?.system?.periodic?.runtime) {
    await effect.update({
      "system.periodic.runtime.storedValue": undo.effectSnapshot.system.periodic.runtime.storedValue,
      "system.periodic.runtime.remainingTicks": undo.effectSnapshot.system.periodic.runtime.remainingTicks,
      "system.periodic.runtime.appliedOrder": undo.effectSnapshot.system.periodic.runtime.appliedOrder
    });
  }

  const result = message.getFlag(SYSTEM_ID, "periodicResult") ?? {};
  const effectForCard = effect ?? {
    name: message.getFlag(SYSTEM_ID, "effectName") || "Периодический эффект",
    uuid: effectUuid || "",
    system: undo.effectSnapshot?.system ?? { periodic: { runtime: { storedValue: 0 }, propertyIds: [] } }
  };
  const resolution = resolvePeriodicValueAgainstActor({
    storedValue: effectForCard.system?.periodic?.runtime?.storedValue ?? 0,
    propertyIds: effectForCard.system?.periodic?.propertyIds ?? []
  }, actor);
  const sourceLabel = message.getFlag(SYSTEM_ID, "sourceLabel") || "";
  const abilities = effect ? await periodicSpecialAbilityRows(effect) : [];
  await message.update({
    content: tickCardHTML({ effect: effectForCard, actor, resolution, sourceLabel, abilities, resolved: true, result, undone: true }),
    [`flags.${SYSTEM_ID}.undone`]: true,
    [`flags.${SYSTEM_ID}.restoredEffectUuid`]: effect?.uuid ?? null
  });
  return { actor, effect };
}

export async function usePeriodicRemovalAbility(effect, abilityUuid, { sourceTickMessageId = null } = {}) {
  if (!effect || !isPeriodicEffect(effect)) return ui.notifications.warn("Периодический эффект уже отсутствует.");
  let ability = null;
  try { ability = abilityUuid ? await fromUuid(String(abilityUuid)) : null; } catch (_error) { ability = null; }
  if (!ability || ability.type !== "ability") return ui.notifications.error("Не удалось найти специальную Ability снятия.");

  const actor = effect.parent;
  if (!actor) return ui.notifications.warn("Специальную Ability снятия можно запускать только для Периодического эффекта на Actor.");
  ui.notifications.warn("Специальная Ability запущена из Периодического эффекта. Несоответствие её условиям не блокирует использование.");
  const { useAbility } = await import("./ability-use.mjs");
  const result = await useAbility(actor, ability);
  if (result?.message) {
    await result.message.update({
      [`flags.${SYSTEM_ID}.periodicRemovalEffectUuid`]: effect.uuid,
      [`flags.${SYSTEM_ID}.periodicRemovalSourceTickMessageId`]: sourceTickMessageId
    });
  }
  return result;
}

async function launchRemovalAbility(button) {
  const effectUuid = String(button.dataset.effectUuid ?? "");
  const abilityUuid = String(button.dataset.abilityUuid ?? "");
  let effect = null;
  try { effect = effectUuid ? await fromUuid(effectUuid) : null; } catch (_error) { effect = null; }
  return usePeriodicRemovalAbility(effect, abilityUuid, {
    sourceTickMessageId: button.closest?.(".chat-message, .message")?.dataset?.messageId ?? null
  });
}

export async function resolvePeriodicRemovalAbilitySuccess({ effectUuid = null, degree = null, sourceCheckMessageId = null } = {}) {
  if (!effectUuid || !['success', 'great'].includes(degree)) return null;
  let effect = null;
  try { effect = await fromUuid(effectUuid); } catch (_error) { effect = null; }
  if (!effect || !isPeriodicEffect(effect)) return null;
  const name = effect.name;
  const actor = effect.parent;
  await effect.delete();
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: `<div class="fast-nri-periodic-tick-card resolved"><div class="fast-nri-chat-roll-title"><i class="fa-solid fa-kit-medical"></i><strong>${esc(name)}</strong></div><div class="fast-nri-periodic-result removed">Эффект снят успешной специальной способностью.</div></div>`,
    flags: { [SYSTEM_ID]: { kind: "periodic-special-removal", actorUuid: actor?.uuid ?? null, sourceCheckMessageId } }
  });
  return { effectUuid, degree, actorUuid: actor?.uuid ?? null };
}

async function resolveRemovalAbilityResult(message) {
  if (!message || message.getFlag(SYSTEM_ID, "kind") !== "ability-check") return;
  return resolvePeriodicRemovalAbilitySuccess({
    effectUuid: message.getFlag(SYSTEM_ID, "periodicRemovalEffectUuid"),
    degree: message.getFlag(SYSTEM_ID, "degree"),
    sourceCheckMessageId: message.id
  });
}

export function activatePeriodicDamage(root = document) {
  root.addEventListener("change", event => {
    const input = event.target?.closest?.("[data-fast-nri-periodic-stored-value]");
    if (!input) return;
    void updateStoredValueFromCard(input);
  });

  root.addEventListener("click", async event => {
    const resolve = event.target?.closest?.("[data-fast-nri-periodic-resolve]");
    if (resolve) {
      event.preventDefault(); event.stopPropagation();
      if (resolve.dataset.fastNriBusy === "true") return;
      resolve.dataset.fastNriBusy = "true";
      try { await resolvePeriodicTickFromCard(resolve); }
      finally { delete resolve.dataset.fastNriBusy; }
      return;
    }

    const undo = event.target?.closest?.("[data-fast-nri-periodic-undo]");
    if (undo) {
      event.preventDefault(); event.stopPropagation();
      if (undo.dataset.fastNriBusy === "true") return;
      undo.dataset.fastNriBusy = "true";
      try { await undoPeriodicTick(undo); }
      finally { delete undo.dataset.fastNriBusy; }
      return;
    }

    const ability = event.target?.closest?.("[data-fast-nri-periodic-removal-ability]");
    if (ability) {
      event.preventDefault(); event.stopPropagation();
      if (ability.dataset.fastNriBusy === "true") return;
      ability.dataset.fastNriBusy = "true";
      try { await launchRemovalAbility(ability); }
      finally { delete ability.dataset.fastNriBusy; }
    }
  });

  Hooks.on("createChatMessage", message => {
    void resolveRemovalAbilityResult(message);
  });

  game.fastNri = game.fastNri ?? {};
  game.fastNri.periodic = {
    ...(game.fastNri.periodic ?? {}),
    registerPropertyRule: registerPeriodicPropertyRule,
    unregisterPropertyRule: unregisterPeriodicPropertyRule,
    resolveAgainstActor: resolvePeriodicValueAgainstActor,
    removalConfig: periodicRemovalConfig
  };
}
