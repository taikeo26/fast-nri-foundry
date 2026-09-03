import {
  actionStateFlagUpdate,
  actionStateFromMessage,
  addAffected,
  appendResolutionStep,
  bindOutcomePoolToAffected,
  createActionState,
  finalizeAllTargetResults,
  normalizeActionState,
  normalizeFinalTargetResult,
  normalizeTargetResult,
  recalculateTargetResult,
  removeAffected,
  removeResolutionStep,
  rerollAllFinalResultDice,
  rerollFinalResultDie,
  rerollResolutionStep,
  resolveDegrees,
  setDeclarationRoll,
  setOutcomeResolution,
  setTargetResultBase
} from "./action-state.mjs";
import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";

/**
 * Fast NRI 0.5.66 — isolated live-QA vertical slice for Unified ActionState.
 *
 * This is deliberately NOT a Weapon/Ability/Spell/Maneuver adapter. It exposes
 * one artificial ActionDefinition through game.fastNri.qa and a QA Macro pack,
 * so the new pipeline can be exercised in Foundry without switching legacy
 * runtime paths.
 */

export const QA_UNIFIED_KIND = "qa-unified-action";
export const QA_FINAL_KIND = "qa-unified-final-result";
export const QA_APPLICATION_KIND = "qa-unified-application";
export const QA_DECLARATION_FORMULA = "1d20 + 1d8";
export const QA_OUTCOME_FORMULA = "3d8";
export const QA_DEFENSE_FORMULA = "1d20 + 1d6";
export const QA_DEFENSE_DC = 12;

const DEGREE_LABELS = Object.freeze({
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
});

const QA_PROFILE_ACTIVE_DICE = Object.freeze({
  failure: 0,
  partial: 1,
  success: 2,
  great: 3
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escAttr(value) {
  return esc(value);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function randomId(prefix = "qa") {
  const id = globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${id}`;
}

export function qaDegreeVsArmor(total, armor, naturalD20 = null) {
  if (naturalD20 === 1) return "failure";
  const partial = finiteNumberOrNull(armor?.partial);
  const success = finiteNumberOrNull(armor?.success);
  const great = finiteNumberOrNull(armor?.great);
  if ([partial, success, great].some(value => value === null)) return null;
  if (total < partial) return "failure";
  if (total < success) return "partial";
  if (total < great) return "success";
  return "great";
}

export function qaProfileActiveDice(degree) {
  return QA_PROFILE_ACTIVE_DICE[degree] ?? 0;
}

export function qaFinalResultTotal(finalTargetResult) {
  const finalResult = normalizeFinalTargetResult(finalTargetResult);
  return finalResult.result.outcomeViews
    .flatMap(view => view.parts)
    .filter(part => !part.excluded)
    .reduce((sum, part) => sum + (Number(part.value) || 0), 0);
}

function rollNaturalD20(roll) {
  const die = Array.from(roll?.dice ?? []).find(entry => Number(entry?.faces) === 20);
  const result = Array.from(die?.results ?? []).find(entry => entry?.active !== false && !entry?.discarded);
  return finiteNumberOrNull(result?.result);
}

function rolledDiceParts(roll) {
  const result = [];
  let index = 0;
  for (const die of Array.from(roll?.dice ?? [])) {
    for (const dieResult of Array.from(die?.results ?? [])) {
      if (dieResult?.active === false || dieResult?.discarded) continue;
      const value = finiteNumberOrNull(dieResult?.result);
      const faces = finiteNumberOrNull(die?.faces);
      if (value === null || faces === null) continue;
      index += 1;
      result.push({
        partId: `d${index}`,
        kind: "die",
        faces,
        value,
        metadata: { qa: true }
      });
    }
  }
  return result;
}

async function showInPlaceRollDice(roll, { synchronize = true } = {}) {
  if (!roll) return false;
  const dice3d = globalThis.game?.dice3d ?? null;
  if (!dice3d || typeof dice3d.showForRoll !== "function") return false;
  try {
    return Boolean(await dice3d.showForRoll(roll, game.user, Boolean(synchronize), null, false));
  } catch (error) {
    console.warn("Быстрая НРИ | QA 0.5.66: не удалось показать 3D бросок", error);
    return false;
  }
}

async function evaluatedRoll(formula) {
  const roll = await new Roll(formula).evaluate();
  await showInPlaceRollDice(roll);
  return roll;
}

function qaDefinition() {
  return {
    sourceKind: "ability",
    sourceRef: {
      actorUuid: null,
      itemUuid: null,
      name: "QA 0.5.66 — Unified ActionState",
      implementationId: "qa-unified-066"
    },
    traits: ["attack", "area", "qa"],
    declaration: {
      rollMode: "attack",
      formula: QA_DECLARATION_FORMULA,
      label: "QA-атака",
      degreeResolverId: "qa-armor-thresholds",
      targetCharacteristic: "armor"
    },
    outcome: {
      resolverId: "qa-shared-damage",
      rollMode: "shared",
      projectionStage: "afterDefense",
      buttonLabel: "Бросок урона",
      componentKinds: ["damage"]
    },
    defenseProcedureIds: ["qa-defense"],
    metadata: {
      qaFixture: "0.5.66",
      profiles: { ...QA_PROFILE_ACTIVE_DICE },
      defenseDc: QA_DEFENSE_DC
    }
  };
}

function qaContext() {
  return {
    version: 3,
    actionId: randomId("action"),
    source: {
      actorUuid: null,
      itemUuid: null,
      itemType: "ability",
      name: "QA 0.5.66 — Unified ActionState"
    },
    initiator: { actorUuid: null, tokenUuid: null },
    targets: [],
    check: {
      enabled: true,
      formula: QA_DECLARATION_FORMULA,
      targetCharacteristic: "armor"
    },
    traits: { area: true },
    traitIds: ["attack", "area", "qa"],
    defenseProcedures: { directed: true, counteraction: false, dodge: true }
  };
}

function tokenRef(token) {
  const document = token?.document ?? token;
  const actor = token?.actor ?? document?.actor ?? null;
  const tokenUuid = String(document?.uuid ?? token?.uuid ?? "").trim();
  const actorUuid = String(actor?.uuid ?? "").trim();
  if (!tokenUuid && !actorUuid) return null;
  return {
    tokenUuid: tokenUuid || null,
    actorUuid: actorUuid || null,
    name: token?.name ?? document?.name ?? actor?.name ?? "Существо"
  };
}

function currentControlledTokens() {
  return Array.from(globalThis.canvas?.tokens?.controlled ?? []).filter(Boolean);
}

function currentTargetTokens() {
  return Array.from(globalThis.game?.user?.targets ?? []).filter(Boolean);
}

function tokenForAffected(affected) {
  const placeables = Array.from(globalThis.canvas?.tokens?.placeables ?? []);
  return placeables.find(token => {
    const uuid = token?.document?.uuid ?? token?.uuid;
    return uuid && uuid === affected?.tokenUuid;
  }) ?? null;
}

function actorForAffected(affected) {
  const token = tokenForAffected(affected);
  if (token?.actor) return token.actor;
  const actorUuid = String(affected?.actorUuid ?? "");
  const match = /^Actor\.([^.]+)$/.exec(actorUuid);
  if (match) return globalThis.game?.actors?.get?.(match[1]) ?? null;
  return null;
}

function qaDegreeResolver({ affected, declarationRoll }) {
  const actor = actorForAffected(affected);
  const armor = actor?.system?.armor ?? null;
  const normalizedArmor = armor ? {
    partial: finiteNumberOrNull(armor.partial),
    success: finiteNumberOrNull(armor.success),
    great: finiteNumberOrNull(armor.great)
  } : null;
  const degree = qaDegreeVsArmor(declarationRoll.total, normalizedArmor, declarationRoll.naturalD20);
  if (!degree) {
    return {
      resolverId: "qa-armor-thresholds",
      input: { armor: normalizedArmor },
      error: "missing-target-threshold"
    };
  }
  return {
    resolverId: "qa-armor-thresholds",
    input: { armor: normalizedArmor },
    degree
  };
}

function qaProfileProjectedSnapshot(targetResult) {
  const target = normalizeTargetResult(targetResult);
  const degree = target.base.degree;
  const activeCount = qaProfileActiveDice(degree);
  const next = structuredClone(target.base);
  const dice = next.outcomeViews.flatMap(view => view.parts.filter(part => part.kind === "die"));
  dice.forEach((part, index) => {
    const active = index < activeCount;
    part.excluded = !active;
    part.exclusionReason = active ? null : "profile";
  });
  next.metadata = {
    ...(next.metadata ?? {}),
    qaProfileDegree: degree,
    qaProfileActiveDice: activeCount
  };
  return next;
}

function targetBeforeStep(targetResult, stepId = null) {
  const target = normalizeTargetResult(targetResult);
  if (!stepId) return recalculateTargetResult(target);
  const index = target.steps.findIndex(step => step.stepId === stepId);
  if (index < 0) return recalculateTargetResult(target);
  return recalculateTargetResult({ ...target, steps: target.steps.slice(0, index) });
}

function smallestActiveDieOperation(targetResult, stepId = null) {
  const before = targetBeforeStep(targetResult, stepId);
  const candidates = before.current.outcomeViews
    .flatMap(view => view.parts)
    .filter(part => part.kind === "die" && !part.excluded)
    .sort((a, b) => (a.value - b.value) || String(a.partId).localeCompare(String(b.partId)));
  if (!candidates.length) return { resolverId: "noop", params: {} };
  const smallest = candidates[0];
  return {
    resolverId: "remove-smallest-active-die",
    params: {
      count: 1,
      reason: "qa-defense",
      tieBreakerPartIds: [smallest.partId]
    }
  };
}

function qaDefenseSucceeded(rollState) {
  if (Number(rollState?.naturalD20) === 1) return false;
  if (Number(rollState?.naturalD20) === 20) return true;
  return Number(rollState?.total) >= QA_DEFENSE_DC;
}

function rootMessageFromElement(element) {
  const messageId = element?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  return messageId ? globalThis.game?.messages?.get?.(messageId) ?? null : null;
}

function stateFromRootElement(element) {
  const message = rootMessageFromElement(element);
  return { message, state: actionStateFromMessage(message) };
}

function qaOutcomeSummary(state) {
  if (state.outcome.status !== "resolved") return "Результат ещё не брошен";
  const pool = state.outcome.pools[0];
  if (!pool) return "Результат пуст";
  return pool.parts.map(part => `d${part.faces}: ${part.value}`).join(" · ");
}

function degreeStateHTML(entry) {
  const state = entry.degreeState;
  if (state.status === "resolved") {
    const armor = state.input?.armor;
    const threshold = armor
      ? `КЗ ${armor.partial ?? "—"}/${armor.success ?? "—"}/${armor.great ?? "—"}`
      : "КЗ —";
    return `<span class="fast-nri-qa-degree">${esc(threshold)} · <strong>${esc(DEGREE_LABELS[state.baseDegree] ?? state.baseDegree)}</strong></span>`;
  }
  if (state.status === "error") {
    return `<span class="fast-nri-qa-degree fast-nri-qa-error">Степень не определена · ${esc(state.error || "ошибка порога")}</span>`;
  }
  if (state.status === "stale") return `<span class="fast-nri-qa-degree fast-nri-qa-stale">Степень требует пересчёта</span>`;
  return `<span class="fast-nri-qa-degree">Степень ещё не определена</span>`;
}

function resultPartsHTML(targetResult) {
  const target = targetResult ? normalizeTargetResult(targetResult) : null;
  const parts = target?.current?.outcomeViews?.flatMap(view => view.parts) ?? [];
  if (!parts.length) return "";
  return `<div class="fast-nri-qa-pool">${parts.map(part => {
    const cls = part.excluded ? " fast-nri-qa-die-excluded" : "";
    return `<span class="fast-nri-qa-die${cls}">d${esc(part.faces ?? "?")}=${esc(part.value)}</span>`;
  }).join("")}</div>`;
}

function defenseRowsHTML(entry) {
  const target = entry.targetResult ? normalizeTargetResult(entry.targetResult) : null;
  const steps = target?.steps ?? [];
  if (!steps.length) return "";
  return `<div class="fast-nri-qa-defense-list">${steps.map(step => {
    const success = step.operation?.resolverId !== "noop";
    const own = step.actor?.tokenUuid && step.actor.tokenUuid === entry.tokenUuid;
    return `<div class="fast-nri-qa-defense-row">
      <span><strong>${esc(step.actor?.name || "Защитник")}</strong> → ${esc(entry.name || "цель")}${own ? " · Самозащита" : ""}</span>
      <span>${esc(step.roll?.formula || "")}: <strong>${esc(step.roll?.total ?? "—")}</strong> · ${success ? "Успех" : "Провал"}${step.wasRerolled ? " · переброшено" : ""}</span>
      <span class="fast-nri-qa-row-actions">
        <button type="button" data-fast-nri-qa-defense-reroll data-affected-id="${escAttr(entry.affectedId)}" data-step-id="${escAttr(step.stepId)}"><i class="fa-solid fa-rotate"></i><span>Переброс</span></button>
        <button type="button" data-fast-nri-qa-defense-undo data-affected-id="${escAttr(entry.affectedId)}" data-step-id="${escAttr(step.stepId)}"><i class="fa-solid fa-xmark"></i><span>Отмена</span></button>
      </span>
    </div>`;
  }).join("")}</div>`;
}

export function qaActionCardHTML(rawState) {
  const state = normalizeActionState(rawState);
  const roll = state.declarationRoll;
  const rosterStale = state.degreeResolution.status === "stale";
  const outcomeReady = ["resolved", "resolved-with-errors"].includes(state.degreeResolution.status)
    && state.degreeResolution.resolvedCount > 0
    && !rosterStale;
  const finalizationCurrent = state.finalization.status === "resolved"
    && state.finalization.basedOnResolutionRevision === state.revisions.resolution;
  const canFinalize = state.outcome.status === "resolved"
    && state.affected.some(entry => entry.targetResult && !entry.targetResult.stale)
    && !finalizationCurrent;

  return `<div class="fast-nri-chat-roll fast-nri-qa-action-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-flask"></i><strong>QA 0.5.66 — единый ActionState</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Искусственный ActionDefinition</span><span>legacy workflow не используется</span></div>

    <section class="fast-nri-qa-stage">
      <div class="fast-nri-qa-stage-title">Объявление</div>
      <div>Атака: <strong>${esc(roll.formula || QA_DECLARATION_FORMULA)} = ${esc(roll.total ?? "—")}</strong>${roll.naturalD20 ? ` · d20=${esc(roll.naturalD20)}` : ""}</div>
    </section>

    <section class="fast-nri-qa-stage">
      <div class="fast-nri-qa-stage-title">Затронутые существа</div>
      <div class="fast-nri-qa-target-actions">
        <button type="button" data-fast-nri-qa-add-targets><i class="fa-solid fa-crosshairs"></i><span>Добавить цели</span></button>
        <button type="button" data-fast-nri-qa-add-controlled><i class="fa-solid fa-object-group"></i><span>Добавить выделенное</span></button>
      </div>
      ${state.affected.length ? `<div class="fast-nri-qa-roster">${state.affected.map(entry => `
        <div class="fast-nri-qa-target-row">
          <div class="fast-nri-qa-target-head">
            <span><strong>${esc(entry.name || "Существо")}</strong> ${degreeStateHTML(entry)}</span>
            <button type="button" data-fast-nri-qa-remove-affected data-affected-id="${escAttr(entry.affectedId)}" title="Удалить из списка"><i class="fa-solid fa-trash"></i></button>
          </div>
          ${resultPartsHTML(entry.targetResult)}
          ${defenseRowsHTML(entry)}
          ${entry.targetResult?.current?.outcomeViews?.length ? `<button type="button" data-fast-nri-qa-defense data-affected-id="${escAttr(entry.affectedId)}"><i class="fa-solid fa-shield-halved"></i><span>Защита</span></button>` : ""}
        </div>`).join("")}</div>` : `<div class="fast-nri-roll-empty">Добавь существ вручную кнопками выше.</div>`}
      ${rosterStale ? `<div class="fast-nri-qa-warning">Список изменён: сохранённая атака не перебрасывается, но степени нужно определить заново.</div>` : ""}
      <button type="button" data-fast-nri-qa-resolve-degrees ${state.affected.length ? "" : "disabled"}><i class="fa-solid fa-scale-balanced"></i><span>Определить степени</span></button>
    </section>

    <section class="fast-nri-qa-stage">
      <div class="fast-nri-qa-stage-title">Результат</div>
      <div>${esc(qaOutcomeSummary(state))}</div>
      ${state.outcome.status === "resolved"
        ? `<div class="fast-nri-qa-warning">Это один общий пул 3d8. Каждая цель получает своё независимое представление по степени и своим Защитам.</div>`
        : `<button type="button" data-fast-nri-qa-roll-outcome ${outcomeReady ? "" : "disabled"}><i class="fa-solid fa-dice"></i><span>Бросок урона</span></button>`}
    </section>

    <section class="fast-nri-qa-stage">
      <div class="fast-nri-qa-stage-title">Финализация</div>
      ${state.finalization.status === "stale" ? `<div class="fast-nri-qa-warning">Ранее сформированные результаты устарели после изменения Resolution.</div>` : ""}
      ${finalizationCurrent ? `<div class="fast-nri-qa-warning">Текущая ревизия FinalResult уже сформирована.</div>` : ""}
      <button type="button" data-fast-nri-qa-finalize ${canFinalize ? "" : "disabled"}><i class="fa-solid fa-file-circle-check"></i><span>Сформировать результаты</span></button>
    </section>
  </div>`;
}

async function persistRootMessage(message, state) {
  if (!message) return null;
  const next = normalizeActionState({ ...state, rootMessageId: message.id });
  await message.update({
    content: qaActionCardHTML(next),
    ...actionStateFlagUpdate(next),
    "flags.fast-nri.kind": QA_UNIFIED_KIND
  });
  return next;
}

export async function startUnifiedActionQa() {
  let state = createActionState({ actionContext: qaContext(), definition: qaDefinition(), metadata: { qaFixture: "0.5.66" } });
  const roll = await evaluatedRoll(QA_DECLARATION_FORMULA);
  state = setDeclarationRoll(state, {
    status: "rolled",
    formula: QA_DECLARATION_FORMULA,
    total: roll.total,
    naturalD20: rollNaturalD20(roll),
    data: null
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: qaActionCardHTML(state),
    flags: {
      "fast-nri": {
        kind: QA_UNIFIED_KIND,
        actionState: state
      }
    }
  });
  await persistRootMessage(message, state);
  return message;
}

async function addRosterFromTokens(element, tokens, addedFrom) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const refs = tokens.map(tokenRef).filter(Boolean);
  const next = addAffected(state, refs, { addedFrom });
  await persistRootMessage(message, next);
}

async function removeRosterEntry(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  await persistRootMessage(message, removeAffected(state, element.dataset.affectedId));
}

async function resolveRosterDegrees(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const next = resolveDegrees(state, qaDegreeResolver);
  await persistRootMessage(message, next);
}

async function rollQaOutcome(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  if (!["resolved", "resolved-with-errors"].includes(state.degreeResolution.status)) {
    ui.notifications.warn("Сначала нажми «Определить степени». ");
    return;
  }

  const roll = await evaluatedRoll(QA_OUTCOME_FORMULA);
  const parts = rolledDiceParts(roll);
  if (!parts.length) {
    ui.notifications.error("QA: не удалось получить отдельные результаты 3d8.");
    return;
  }

  let next = setOutcomeResolution(state, {
    status: "resolved",
    resolverId: "qa-shared-damage",
    rollMode: "shared",
    projectionStage: "afterDefense",
    pools: [{
      poolId: "qa-shared-damage",
      scope: "shared",
      formula: QA_OUTCOME_FORMULA,
      parts,
      metadata: { qa: true }
    }],
    components: [{ kind: "damage", poolId: "qa-shared-damage" }]
  });

  for (const entry of next.affected) {
    if (!entry.targetResult || entry.degreeState.status !== "resolved") continue;
    next = bindOutcomePoolToAffected(next, entry.affectedId, { poolId: "qa-shared-damage" });
    const rebound = next.affected.find(item => item.affectedId === entry.affectedId);
    if (!rebound?.targetResult) continue;
    next = setTargetResultBase(next, entry.affectedId, qaProfileProjectedSnapshot(rebound.targetResult), {
      preserveSteps: false
    });
  }

  await persistRootMessage(message, next);
}

function exactlyOneControlledDefender() {
  const controlled = currentControlledTokens();
  if (controlled.length !== 1) {
    ui.notifications.warn("Для QA-Защиты выдели ровно один токен-защитник.");
    return null;
  }
  return controlled[0];
}

function rollStateFromRoll(roll, formula) {
  return {
    status: "rolled",
    formula,
    total: roll.total,
    naturalD20: rollNaturalD20(roll),
    data: null
  };
}

async function addQaDefense(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const affectedId = element.dataset.affectedId;
  const affected = state.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return;
  const defender = exactlyOneControlledDefender();
  if (!defender) return;

  const roll = await evaluatedRoll(QA_DEFENSE_FORMULA);
  const rollState = rollStateFromRoll(roll, QA_DEFENSE_FORMULA);
  const success = qaDefenseSucceeded(rollState);
  const operation = success
    ? smallestActiveDieOperation(affected.targetResult)
    : { resolverId: "noop", params: {} };

  const ref = tokenRef(defender) ?? {};
  const next = appendResolutionStep(state, affectedId, {
    stepId: randomId("def"),
    type: "defense",
    actor: {
      actorUuid: ref.actorUuid ?? null,
      tokenUuid: ref.tokenUuid ?? null,
      name: ref.name ?? "Защитник"
    },
    actionRef: {
      itemUuid: null,
      name: "QA-защита",
      procedureId: "qa-defense"
    },
    roll: rollState,
    operation
  });
  await persistRootMessage(message, next);
}

async function rerollQaDefense(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const affectedId = element.dataset.affectedId;
  const stepId = element.dataset.stepId;
  const affected = state.affected.find(entry => entry.affectedId === affectedId);
  const step = affected?.targetResult?.steps?.find(entry => entry.stepId === stepId);
  if (!step) return;

  const formula = step.roll?.formula || QA_DEFENSE_FORMULA;
  const roll = await evaluatedRoll(formula);
  const nextRoll = rollStateFromRoll(roll, formula);
  const next = rerollResolutionStep(state, affectedId, stepId, nextRoll, {
    deriveOperation: ({ step: rerolledStep, targetResult }) => qaDefenseSucceeded(rerolledStep.roll)
      ? smallestActiveDieOperation(targetResult, rerolledStep.stepId)
      : { resolverId: "noop", params: {} }
  });
  await persistRootMessage(message, next);
}

async function undoQaDefense(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const next = removeResolutionStep(state, element.dataset.affectedId, element.dataset.stepId);
  await persistRootMessage(message, next);
}

function finalDice(finalResult) {
  const normalized = normalizeFinalTargetResult(finalResult);
  return normalized.result.outcomeViews.flatMap(view =>
    view.parts
      .filter(part => part.kind === "die")
      .map(part => ({ ...part, viewId: view.viewId }))
  );
}

export function qaFinalCardHTML(rawFinalResult) {
  const finalResult = normalizeFinalTargetResult(rawFinalResult);
  const dice = finalDice(finalResult);
  const total = qaFinalResultTotal(finalResult);
  return `<div class="fast-nri-chat-roll fast-nri-qa-final-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-file-circle-check"></i><strong>Final Result · ${esc(finalResult.provenance.name || "существо")}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Рассчитано для: ${esc(finalResult.provenance.name || "—")}</span><span>Application не привязан к этой цели</span></div>
    <section class="fast-nri-qa-stage">
      <div class="fast-nri-qa-stage-title">Итоговый результат</div>
      <div class="fast-nri-qa-final-total">Урон: <strong>${esc(total)}</strong></div>
      <div class="fast-nri-qa-reroll-editor">
        <div class="fast-nri-qa-stage-title">Переброс кубов</div>
        ${dice.length ? dice.map(part => `<div class="fast-nri-qa-final-die-row ${part.excluded ? "fast-nri-qa-die-excluded" : ""}">
          <span>d${esc(part.faces)} = <strong>${esc(part.value)}</strong>${part.excluded ? " · исключён" : ""}</span>
          ${!part.excluded ? `<button type="button" data-fast-nri-qa-final-reroll data-view-id="${escAttr(part.viewId)}" data-part-id="${escAttr(part.partId)}" data-faces="${escAttr(part.faces)}"><i class="fa-solid fa-rotate"></i><span>Переброс</span></button>` : ""}
        </div>`).join("") : `<div class="fast-nri-roll-empty">В результате нет случайных кубов.</div>`}
        <button type="button" data-fast-nri-qa-final-reroll-all ${dice.some(part => !part.excluded) ? "" : "disabled"}><i class="fa-solid fa-dice"></i><span>Перебросить всё</span></button>
      </div>
    </section>
    <div class="fast-nri-damage-actions"><button type="button" class="fast-nri-apply-damage-button" data-fast-nri-qa-final-apply><i class="fa-solid fa-check"></i><span>Применить к выделенным</span></button></div>
  </div>`;
}

async function finalizeQaResults(element) {
  const { message, state } = stateFromRootElement(element);
  if (!message || !state) return;
  const next = finalizeAllTargetResults(state);
  await persistRootMessage(message, next);
  if (!next.finalization.results.length) {
    ui.notifications.warn("Нет готовых TargetResult для финализации.");
    return;
  }

  for (const finalResult of next.finalization.results) {
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: qaFinalCardHTML(finalResult),
      flags: {
        "fast-nri": {
          kind: QA_FINAL_KIND,
          qaRootMessageId: message.id,
          qaFinalResult: finalResult
        }
      }
    });
  }
}

function finalResultFromMessage(message) {
  const value = message?.getFlag?.("fast-nri", "qaFinalResult") ?? null;
  return value ? normalizeFinalTargetResult(value) : null;
}

async function persistFinalMessage(message, finalResult) {
  const normalized = normalizeFinalTargetResult(finalResult);
  await message.update({
    content: qaFinalCardHTML(normalized),
    "flags.fast-nri.qaFinalResult": normalized
  });
  return normalized;
}

async function rerollFinalDieFromChat(element) {
  const message = rootMessageFromElement(element);
  const finalResult = finalResultFromMessage(message);
  if (!message || !finalResult) return;
  const faces = Math.max(2, Number(element.dataset.faces) || 0);
  const roll = await evaluatedRoll(`1d${faces}`);
  const value = rolledDiceParts(roll)[0]?.value;
  if (!value) return;
  const next = rerollFinalResultDie(finalResult, {
    viewId: element.dataset.viewId,
    partId: element.dataset.partId,
    value
  });
  await persistFinalMessage(message, next);
}

async function rerollAllFinalDiceFromChat(element) {
  const message = rootMessageFromElement(element);
  const finalResult = finalResultFromMessage(message);
  if (!message || !finalResult) return;
  const active = finalDice(finalResult).filter(part => !part.excluded);
  if (!active.length) return;
  const formula = active.map(part => `1d${part.faces}`).join(" + ");
  const roll = await evaluatedRoll(formula);
  const rolled = rolledDiceParts(roll);
  const values = {};
  active.forEach((part, index) => {
    const value = rolled[index]?.value;
    if (value) values[part.partId] = value;
  });
  const next = rerollAllFinalResultDice(finalResult, values);
  await persistFinalMessage(message, next);
}

function uniqueControlledRecipients() {
  const seen = new Set();
  return currentControlledTokens().filter(token => {
    const key = token?.document?.uuid ?? token?.uuid ?? token?.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function applicationCardHTML(data) {
  return `<div class="fast-nri-chat-roll fast-nri-qa-application-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-heart-crack"></i><strong>${esc(data.tokenName)}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>QA Application transaction</span><span>Результат был рассчитан для ${esc(data.provenanceName || "—")}</span></div>
    <div class="fast-nri-qa-final-total">Получает <strong>${esc(data.damage)}</strong> урона · HP ${esc(data.previousHp)} → ${esc(data.afterHp)}${data.previousTemp !== data.afterTemp ? ` · временные HP ${esc(data.previousTemp)} → ${esc(data.afterTemp)}` : ""}</div>
    ${data.undone ? `<div class="fast-nri-qa-warning">Отменено</div>` : `<button type="button" data-fast-nri-qa-application-undo><i class="fa-solid fa-rotate-left"></i><span>Отмена</span></button>`}
  </div>`;
}

async function applyFinalResultFromChat(element) {
  const message = rootMessageFromElement(element);
  const finalResult = finalResultFromMessage(message);
  if (!message || !finalResult) return;
  const recipients = uniqueControlledRecipients();
  if (!recipients.length) {
    ui.notifications.warn("Выдели один или несколько токенов для Application.");
    return;
  }
  const damage = Math.max(0, qaFinalResultTotal(finalResult));

  for (const token of recipients) {
    const actor = token?.actor;
    if (!actor) continue;
    const previousHp = finiteNumberOrNull(actor.system?.hp?.value);
    const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
    if (previousHp === null) continue;
    const tempSpent = Math.min(previousTemp, damage);
    const afterTemp = previousTemp - tempSpent;
    const afterHp = Math.max(0, previousHp - Math.max(0, damage - tempSpent));
    await actor.update({
      "system.hp.temp": afterTemp,
      "system.hp.value": afterHp
    }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });

    const data = {
      tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
      actorUuid: actor.uuid,
      tokenName: token.name || actor.name || "Получатель",
      provenanceName: finalResult.provenance.name,
      finalResultId: finalResult.finalResultId,
      damage,
      previousHp,
      afterHp,
      previousTemp,
      afterTemp,
      undone: false
    };
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor, token: token.document ?? token }),
      content: applicationCardHTML(data),
      flags: { "fast-nri": { kind: QA_APPLICATION_KIND, qaApplication: data } }
    });
  }
}

async function resolveActorForApplication(data) {
  if (data?.tokenUuid) {
    try {
      const tokenDocument = await fromUuid(data.tokenUuid);
      if (tokenDocument?.actor) return tokenDocument.actor;
    } catch (_error) { /* fall through */ }
  }
  if (data?.actorUuid) {
    try { return await fromUuid(data.actorUuid); }
    catch (_error) { /* fall through */ }
  }
  return null;
}

async function undoQaApplication(element) {
  const message = rootMessageFromElement(element);
  const data = message?.getFlag?.("fast-nri", "qaApplication") ?? null;
  if (!message || !data || data.undone) return;
  const actor = await resolveActorForApplication(data);
  if (!actor) {
    ui.notifications.error("QA: не удалось найти Actor для Undo.");
    return;
  }
  await actor.update({
    "system.hp.value": data.previousHp,
    "system.hp.temp": data.previousTemp
  }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  const next = { ...data, undone: true };
  await message.update({
    content: applicationCardHTML(next),
    "flags.fast-nri.qaApplication": next
  });
}

async function clickHandler(event) {
  const selectorMap = [
    ["[data-fast-nri-qa-add-targets]", el => addRosterFromTokens(el, currentTargetTokens(), "target")],
    ["[data-fast-nri-qa-add-controlled]", el => addRosterFromTokens(el, currentControlledTokens(), "controlled")],
    ["[data-fast-nri-qa-remove-affected]", removeRosterEntry],
    ["[data-fast-nri-qa-resolve-degrees]", resolveRosterDegrees],
    ["[data-fast-nri-qa-roll-outcome]", rollQaOutcome],
    ["[data-fast-nri-qa-defense]", addQaDefense],
    ["[data-fast-nri-qa-defense-reroll]", rerollQaDefense],
    ["[data-fast-nri-qa-defense-undo]", undoQaDefense],
    ["[data-fast-nri-qa-finalize]", finalizeQaResults],
    ["[data-fast-nri-qa-final-reroll]", rerollFinalDieFromChat],
    ["[data-fast-nri-qa-final-reroll-all]", rerollAllFinalDiceFromChat],
    ["[data-fast-nri-qa-final-apply]", applyFinalResultFromChat],
    ["[data-fast-nri-qa-application-undo]", undoQaApplication]
  ];

  for (const [selector, handler] of selectorMap) {
    const element = event.target.closest(selector);
    if (!element) continue;
    event.preventDefault();
    event.stopPropagation();
    if (element.dataset.fastNriBusy === "true") return;
    element.dataset.fastNriBusy = "true";
    try { await handler(element); }
    catch (error) {
      console.error("Быстрая НРИ | QA 0.5.66 vertical slice", error);
      ui.notifications.error(`QA 0.5.66: ${error?.message || "ошибка"}`);
    } finally {
      delete element.dataset.fastNriBusy;
    }
    return;
  }
}

export function activateUnifiedActionQa(root = document) {
  root.addEventListener("click", clickHandler);
  game.fastNri = game.fastNri ?? {};
  game.fastNri.qa = {
    ...(game.fastNri.qa ?? {}),
    startUnifiedAction: startUnifiedActionQa
  };
}
