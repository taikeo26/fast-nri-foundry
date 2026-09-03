import {
  ACTION_DEGREES,
  actionStateFlagUpdate,
  actionStateFromMessage,
  addTargetSlotSelections,
  appendPartResolutionStep,
  assignOutcomeUnitToTarget,
  createActionState,
  normalizeActionState,
  normalizeTargetResult,
  recalculateTargetResult,
  registerActionRoll,
  registerOutcomePool,
  rerollRegisteredOutcomePart,
  setRegisteredOutcomePartExcluded,
  removePartResolutionStep,
  removeTargetSlotSelection,
  rerollPartResolutionStep,
  resolveAllPartTargetDegrees,
  resolvePartTargetSelectionDegree,
  setPartTargetResultBase,
  shiftPartTargetDegree,
  validateActionStateV2
} from "./action-state.mjs";
import {
  createApplicationReceipt,
  evaluateFinalResultDependencies,
  materializeActionFinalResults,
  normalizeApplicationReceipt,
  normalizeFinalResultPackage,
  resolveFinalResultAmount
} from "./action-final-results.mjs";
import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";
import { filterDuplicateTargetSelectionsByHardBlock } from "./hard-blocks.mjs";
import { preventDuplicateTargetSelectionsEnabled } from "./settings.mjs";

/**
 * Fast NRI 0.5.76 — target-first ActionState v2 lifecycle QA cards.
 *
 * Artificial fixtures only. They prove that the canonical two-card UX can
 * address ActionPart + TargetSlot directly, then materialize independent FinalResult recipient streams and Application receipts without falling back to root affected[]. Real Ability/Spell/Weapon adapters remain untouched.
 */

export const QA_V2_DECLARATION_KIND = "qa-v2-parts-declaration";
export const QA_V2_RESOLUTION_KIND = "qa-v2-parts-resolution";
export const QA_V2_FINAL_KIND = "qa-v2-final-result";
export const QA_V2_APPLICATION_KIND = "qa-v2-application";
export const QA_V2_DEFENSE_FORMULA = "1d20 + 1d6";
export const QA_V2_DEFENSE_DC = 12;

const DEGREE_LABELS = Object.freeze({
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
});

const PROFILE_ACTIVE_DICE = Object.freeze({ failure: 0, partial: 1, success: 2, great: 3 });

const SCENARIOS = Object.freeze({
  arrows: {
    id: "arrows",
    label: "3 независимые атаки",
    description: "Три ActionPart, три независимых Attack Roll и три именованных потока целей.",
    definition: {
      sourceKind: "ability",
      sourceRef: { name: "QA 0.5.76 — 3 независимые атаки", implementationId: "qa-v2-arrows" },
      parts: [{
        partId: "arrow",
        label: "Стрела",
        repeat: { count: 3 },
        targetSlots: [{
          slotId: "target",
          label: "Цель стрелы",
          roles: ["resolution", "recipient"],
          selectionMode: "manual",
          min: 1,
          max: 1
        }],
        declaration: {
          rollMode: "attack",
          formula: "1d20 + 1d8",
          label: "Атака стрелы",
          degreeResolverId: "qa-armor-thresholds",
          targetCharacteristic: "armor"
        },
        outcomeComponents: [{
          componentId: "damage",
          type: "damage",
          label: "Урон стрелы",
          recipient: { type: "targetSlot", targetSlotId: "target" },
          timing: "resolution",
          valueSource: { type: "roll", params: { formula: "3d8" } },
          delivery: { mode: "independent" }
        }],
        defenseProcedureIds: ["qa-defense"]
      }]
    }
  },
  drain: {
    id: "drain",
    label: "Урон цели → зависимое лечение источника",
    description: "Один ActionPart, отдельный resolution/recipient slot урона и recipient-only slot источника.",
    definition: {
      sourceKind: "spell",
      sourceRef: { name: "QA 0.5.76 — Зависимый результат", implementationId: "qa-v2-drain" },
      parts: [{
        partId: "drain",
        label: "Похищение-like",
        targetSlots: [
          {
            slotId: "damage-target",
            label: "Цель урона",
            roles: ["resolution", "recipient"],
            selectionMode: "manual",
            min: 1,
            max: 1
          },
          {
            slotId: "self",
            label: "Получатель восстановления",
            roles: ["recipient"],
            selectionMode: "source",
            min: 1,
            max: 1
          }
        ],
        declaration: {
          rollMode: "attack",
          formula: "1d20 + 1d8",
          label: "Атака",
          degreeResolverId: "qa-armor-thresholds",
          targetCharacteristic: "armor"
        },
        outcomeComponents: [
          {
            componentId: "damage",
            type: "damage",
            label: "Урон",
            recipient: { type: "targetSlot", targetSlotId: "damage-target" },
            timing: "resolution",
            valueSource: { type: "roll", params: { formula: "3d4" } }
          },
          {
            componentId: "healing",
            type: "healing",
            label: "Зависимое лечение",
            recipient: { type: "targetSlot", targetSlotId: "self" },
            timing: "application",
            dependsOn: [{ componentId: "damage", condition: "component-applied-positive" }],
            valueSource: { type: "largest-die", componentId: "damage" }
          },
          {
            componentId: "resource",
            type: "resource",
            label: "Восстановление ресурса",
            recipient: { type: "targetSlot", targetSlotId: "self" },
            timing: "application",
            dependsOn: [{ componentId: "damage", condition: "component-applied-positive" }],
            degreeSource: { type: "effect-degree", targetSlotId: "damage-target" },
            valueSource: { type: "degree-table", table: { failure: 0, partial: 1, success: 2, great: 3 } }
          }
        ],
        defenseProcedureIds: ["qa-defense"]
      }]
    }
  },
  allocation: {
    id: "allocation",
    label: "Общий 6d6 → распределение конкретных кубов",
    description: "Recipient-only TargetSlot и rolledPartsToTargets: назначение не меняет выпавшее значение.",
    definition: {
      sourceKind: "spell",
      sourceRef: { name: "QA 0.5.76 — Распределяемый пул", implementationId: "qa-v2-allocation" },
      parts: [{
        partId: "mass-heal",
        label: "Распределяемое лечение",
        targetSlots: [{
          slotId: "recipients",
          label: "Цели исцеления",
          roles: ["recipient"],
          selectionMode: "manual",
          min: 1,
          max: null
        }],
        declaration: { rollMode: "none" },
        outcomeComponents: [{
          componentId: "healing",
          type: "healing",
          label: "Лечение",
          recipient: { type: "targetSlot", targetSlotId: "recipients" },
          timing: "resolution",
          valueSource: { type: "roll", params: { formula: "6d6" } },
          delivery: { mode: "combineByRecipient", key: "qa-shared-healing" }
        }]
      }]
    }
  }
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const escAttr = esc;

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function randomId(prefix = "qa-v2") {
  const id = globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${id}`;
}

function currentControlledTokens() {
  return Array.from(globalThis.canvas?.tokens?.controlled ?? []).filter(Boolean);
}

function currentTargetTokens() {
  return Array.from(globalThis.game?.user?.targets ?? []).filter(Boolean);
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

function contextForQa(scenario) {
  const source = tokenRef(currentControlledTokens()[0]) ?? {};
  return {
    version: 3,
    actionId: randomId("action-v2"),
    source: {
      actorUuid: source.actorUuid ?? null,
      itemUuid: null,
      itemType: "ability",
      name: `QA 0.5.76 — ${scenario.label}`
    },
    initiator: { actorUuid: source.actorUuid ?? null, tokenUuid: source.tokenUuid ?? null },
    targets: [],
    check: { enabled: false },
    traits: {},
    traitIds: ["qa", "actionstate-v2"],
    defenseProcedures: { directed: true, counteraction: false, dodge: true }
  };
}

async function showDice(roll) {
  const dice3d = globalThis.game?.dice3d;
  if (!roll || !dice3d || typeof dice3d.showForRoll !== "function") return false;
  try { return Boolean(await dice3d.showForRoll(roll, game.user, true, null, false)); }
  catch (error) {
    console.warn("Быстрая НРИ | QA 0.5.76: Dice So Nice", error);
    return false;
  }
}

async function evaluatedRoll(formula) {
  const roll = await new Roll(formula).evaluate();
  await showDice(roll);
  return roll;
}

function rollNaturalD20(roll) {
  const die = Array.from(roll?.dice ?? []).find(entry => Number(entry?.faces) === 20);
  const result = Array.from(die?.results ?? []).find(entry => entry?.active !== false && !entry?.discarded);
  return finiteNumberOrNull(result?.result);
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

function rolledDiceParts(roll) {
  const parts = [];
  let index = 0;
  for (const die of Array.from(roll?.dice ?? [])) {
    for (const result of Array.from(die?.results ?? [])) {
      if (result?.active === false || result?.discarded) continue;
      const value = finiteNumberOrNull(result?.result);
      const faces = finiteNumberOrNull(die?.faces);
      if (value === null || faces === null) continue;
      index += 1;
      parts.push({ partId: `d${index}`, kind: "die", faces, value, metadata: { qaV2: true } });
    }
  }
  return parts;
}

function actorForSelection(selection) {
  const placeables = Array.from(globalThis.canvas?.tokens?.placeables ?? []);
  const token = placeables.find(entry => (entry?.document?.uuid ?? entry?.uuid) === selection?.tokenUuid);
  if (token?.actor) return token.actor;
  const match = /^Actor\.([^.]+)$/.exec(String(selection?.actorUuid ?? ""));
  return match ? globalThis.game?.actors?.get?.(match[1]) ?? null : null;
}

function selectionName(selection) {
  return selection?.name || actorForSelection(selection)?.name || "Существо";
}

function degreeVsArmor(total, armor, naturalD20 = null) {
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

function qaDegreeResolver({ selection, declarationRoll }) {
  const actor = actorForSelection(selection);
  const armor = actor?.system?.armor ?? null;
  const normalizedArmor = armor ? {
    partial: finiteNumberOrNull(armor.partial),
    success: finiteNumberOrNull(armor.success),
    great: finiteNumberOrNull(armor.great)
  } : null;
  const degree = degreeVsArmor(declarationRoll.total, normalizedArmor, declarationRoll.naturalD20);
  if (!degree) return { resolverId: "qa-armor-thresholds", input: { armor: normalizedArmor }, error: "missing-target-threshold" };
  return { resolverId: "qa-armor-thresholds", input: { armor: normalizedArmor }, degree };
}

function rootMessageFromElement(element) {
  const id = element?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  return id ? globalThis.game?.messages?.get?.(id) ?? null : null;
}

function stateFromElement(element) {
  const message = rootMessageFromElement(element);
  return { message, state: actionStateFromMessage(message) };
}

function messageKind(message) {
  return message?.getFlag?.("fast-nri", "kind") ?? null;
}

function scenarioFromState(state) {
  return SCENARIOS[state?.metadata?.qaV2Scenario] ?? SCENARIOS.arrows;
}

function registeredDeclarationRoll(state, part) {
  return part.declaration.rollRefs
    .map(id => state.rollRegistry.find(entry => entry.rollId === id))
    .find(Boolean)?.roll ?? null;
}

function partResultFor(part, slotId, selectionId) {
  return part.targetResults.find(result => result.targetSlotId === slotId && result.selectionId === selectionId) ?? null;
}

function degreeHTML(result) {
  const degreeState = result?.degreeState;
  if (degreeState?.status === "resolved") {
    const armor = degreeState.input?.armor;
    const threshold = armor ? `КЗ ${armor.partial ?? "—"}/${armor.success ?? "—"}/${armor.great ?? "—"}` : "КЗ —";
    return `<span class="fast-nri-qa-degree">${esc(threshold)} · <strong>${esc(DEGREE_LABELS[degreeState.baseDegree] ?? degreeState.baseDegree)}</strong>${degreeState.manualAdjusted ? " · ручная правка" : ""}</span>`;
  }
  if (degreeState?.status === "error") return `<span class="fast-nri-qa-degree fast-nri-qa-error">Степень не определена · ${esc(degreeState.error || "ошибка")}</span>`;
  return `<span class="fast-nri-qa-degree">Степень ещё не определена</span>`;
}

function resultDiceHTML(result) {
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  const parts = target?.current?.outcomeViews?.flatMap(view => view.parts) ?? [];
  if (!parts.length) return "";
  return `<div class="fast-nri-qa-pool">${parts.map(part => `<span class="fast-nri-qa-die${part.excluded ? " fast-nri-qa-die-excluded" : ""}">d${esc(part.faces ?? "?")}=${esc(part.value)}</span>`).join("")}</div>`;
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
  return {
    resolverId: "remove-smallest-active-die",
    params: { count: 1, reason: "qa-v2-defense", tieBreakerPartIds: [candidates[0].partId] }
  };
}

function defenseSucceeded(rollState) {
  if (Number(rollState?.naturalD20) === 1) return false;
  if (Number(rollState?.naturalD20) === 20) return true;
  return Number(rollState?.total) >= QA_V2_DEFENSE_DC;
}

function defenseRowsHTML(part, slot, selection, result) {
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  if (!target?.steps?.length) return "";
  return `<div class="fast-nri-qa-defense-list">${target.steps.map(step => {
    const success = step.operation?.resolverId !== "noop";
    return `<div class="fast-nri-qa-defense-row">
      <span><strong>${esc(step.actor?.name || "Защитник")}</strong> → ${esc(selectionName(selection))}</span>
      <span>${esc(step.roll?.formula || "")}: <strong>${esc(step.roll?.total ?? "—")}</strong> · ${success ? "Успех" : "Провал"}${step.wasRerolled ? " · переброшено" : ""}</span>
      <span class="fast-nri-qa-row-actions">
        <button type="button" data-fast-nri-v2-defense-reroll data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}" data-step-id="${escAttr(step.stepId)}"><span>Переброс</span></button>
        <button type="button" data-fast-nri-v2-defense-undo data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}" data-step-id="${escAttr(step.stepId)}"><span>Отмена</span></button>
      </span>
    </div>`;
  }).join("")}</div>`;
}

function slotHTML(state, part, slot, { resolution = false, outcomeReady = false } = {}) {
  const roleText = slot.roles.includes("resolution")
    ? (slot.roles.includes("recipient") ? "цель проверки + получатель" : "цель проверки")
    : "только получатель";
  const defaultHint = slot.selectionMode === "source"
    ? " · по умолчанию: источник"
    : slot.selectionMode === "fixed"
      ? " · по умолчанию: указанная цель"
      : "";
  const targetActions = `<div class="fast-nri-qa-target-actions">
    <button type="button" data-fast-nri-v2-add-targets data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}"><span>Добавить цели</span></button>
    <button type="button" data-fast-nri-v2-add-controlled data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}"><span>Добавить выделенное</span></button>
  </div>`;

  const rows = slot.selections.length ? slot.selections.map(selection => {
    const result = partResultFor(part, slot.slotId, selection.selectionId);
    const degree = resolution && slot.roles.includes("resolution") ? degreeHTML(result) : "";
    const controls = resolution && result?.degreeState?.status === "resolved"
      ? `<span class="fast-nri-qa-degree-actions"><button type="button" data-fast-nri-v2-degree-shift data-delta="-1" data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}">−</button><button type="button" data-fast-nri-v2-degree-shift data-delta="1" data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}">+</button></span>`
      : "";
    const remove = `<button type="button" data-fast-nri-v2-remove-selection data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}" title="Удалить"><i class="fa-solid fa-trash"></i></button>`;
    const defense = resolution && outcomeReady && slot.roles.includes("resolution") && result?.targetResult
      ? `<button type="button" data-fast-nri-v2-defense data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}"><span>Защита</span></button>`
      : "";
    return `<div class="fast-nri-qa-target-row">
      <div class="fast-nri-qa-target-head"><span><strong>${esc(selectionName(selection))}</strong> ${degree} ${controls}</span>${remove}</div>
      ${resolution && outcomeReady ? resultDiceHTML(result) : ""}
      ${resolution && outcomeReady ? defenseRowsHTML(part, slot, selection, result) : ""}
      ${defense}
    </div>`;
  }).join("") : `<div class="fast-nri-roll-empty">${slot.selectionMode === "source" ? "Источник не определён: можно назначить получателя вручную." : "Получатели не выбраны."}</div>`;

  return `<div class="fast-nri-v2-slot">
    <div class="fast-nri-qa-stage-title">${esc(slot.label)} <small>· ${esc(roleText)}${esc(defaultHint)}</small></div>
    ${targetActions}
    <div class="fast-nri-qa-roster">${rows}</div>
  </div>`;
}

function diagnosticsHTML(state) {
  const diagnostics = validateActionStateV2(state);
  if (!diagnostics.length) return "";
  return `<div class="fast-nri-qa-warning">Диагностика v2: ${diagnostics.map(item => esc(`${item.level}: ${item.code}${item.partId ? ` · ${item.partId}` : ""}${item.slotId ? `/${item.slotId}` : ""}`)).join("; ")}</div>`;
}

function partRollOutcomeComponents(part) {
  return part.outcomeComponents.filter(component => component.valueSource?.type === "roll");
}

function componentPool(state, partId, componentId) {
  return state.poolRegistry.find(pool => pool.partId === partId && pool.componentId === componentId) ?? null;
}

function partOutcomesReady(state, part) {
  return partRollOutcomeComponents(part).every(component => Boolean(componentPool(state, part.partId, component.componentId)));
}

function outcomeButtonLabel(component) {
  const explicit = String(component.metadata?.rollButtonLabel ?? component.valueSource?.params?.buttonLabel ?? "").trim();
  if (explicit) return explicit;
  if (component.type === "damage") return "Бросить урон";
  if (component.type === "healing") return "Бросить исцеление";
  if (component.type === "tempHp") return "Бросить временные HP";
  return component.label ? `Бросить: ${component.label}` : "Бросить результат";
}

function outcomePoolEditorHTML(state, part, component) {
  const pool = componentPool(state, part.partId, component.componentId);
  if (!pool) {
    return `<button type="button" data-fast-nri-v2-outcome-roll data-part-id="${escAttr(part.partId)}" data-component-id="${escAttr(component.componentId)}"><i class="fa-solid fa-dice"></i><span>${esc(outcomeButtonLabel(component))}</span></button>`;
  }
  const activeDice = pool.parts.filter(entry => entry.kind === "die" && !entry.excluded);
  return `<div class="fast-nri-qa-reroll-editor" data-pool-id="${escAttr(pool.poolId)}">
    <div class="fast-nri-qa-stage-title">${esc(component.label || component.type || "Результат")} · ${esc(pool.formula || "бросок")}</div>
    ${pool.parts.map(entry => `<div class="fast-nri-qa-final-die-row ${entry.excluded ? "fast-nri-qa-die-excluded" : ""}">
      <span>${entry.kind === "die" ? `d${esc(entry.faces)}` : "фикс."} = <strong>${esc(entry.value)}</strong>${entry.excluded ? " · исключён" : ""}</span>
      <span class="fast-nri-qa-row-actions">
        ${entry.kind === "die" && !entry.excluded ? `<button type="button" data-fast-nri-v2-outcome-reroll data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-faces="${escAttr(entry.faces)}"><span>Переброс</span></button>` : ""}
        ${entry.kind === "die" ? `<button type="button" data-fast-nri-v2-outcome-toggle data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-excluded="${entry.excluded ? "true" : "false"}"><span>${entry.excluded ? "Вернуть" : "Исключить"}</span></button>` : ""}
      </span>
    </div>`).join("")}
    <button type="button" data-fast-nri-v2-outcome-reroll-all data-pool-id="${escAttr(pool.poolId)}" ${activeDice.length ? "" : "disabled"}><i class="fa-solid fa-dice"></i><span>Перебросить всё</span></button>
  </div>`;
}

function partOutcomeSectionHTML(state, part) {
  const rollComponents = partRollOutcomeComponents(part);
  if (!rollComponents.length) return `<section class="fast-nri-qa-stage"><div class="fast-nri-qa-stage-title">Дополнительный бросок</div><div>Для этой части отдельный бросок результата не требуется.</div></section>`;
  return `<section class="fast-nri-qa-stage"><div class="fast-nri-qa-stage-title">Дополнительный результат</div>${rollComponents.map(component => outcomePoolEditorHTML(state, part, component)).join("")}</section>`;
}

function partHTML(state, part, { resolution = false } = {}) {
  const roll = registeredDeclarationRoll(state, part);
  const rollLine = part.declaration.rollMode === "none"
    ? `<div>Атака/проверка: <strong>не требуется</strong></div>`
    : resolution
      ? `<div>Атака/проверка: <strong>${esc(roll?.formula || part.declaration.formula || "—")} = ${esc(roll?.total ?? "—")}</strong>${roll?.naturalD20 ? ` · d20=${esc(roll.naturalD20)}` : ""}</div>`
      : `<div>Атака/проверка: <strong>${esc(part.declaration.formula || "настроенная проверка")}</strong> · будет брошена после заявления действия.</div>`;
  const ready = partOutcomesReady(state, part);
  return `<section class="fast-nri-qa-stage fast-nri-v2-part" data-part-id="${escAttr(part.partId)}">
    <div class="fast-nri-v2-part-title"><strong>${esc(part.label)}</strong> <code>${esc(part.partId)}</code></div>
    ${rollLine}
    ${part.targetSlots.map(slot => slotHTML(state, part, slot, { resolution, outcomeReady: ready })).join("")}
    ${resolution ? partOutcomeSectionHTML(state, part) : ""}
  </section>`;
}

function allocationHTML(state) {
  const pool = state.poolRegistry.find(entry => entry.allocation?.mode === "rolledPartsToTargets");
  if (!pool) return "";
  const part = state.parts.find(entry => entry.partId === pool.partId);
  const slot = part?.targetSlots.find(entry => entry.slotId === "recipients") ?? part?.targetSlots.find(entry => entry.roles.includes("recipient"));
  if (!part || !slot) return "";
  const assignmentByUnit = new Map(pool.allocation.assignments.map(entry => [entry.unitId, entry]));
  return `<section class="fast-nri-qa-stage">
    <div class="fast-nri-qa-stage-title">Распределение сохранённых кубов</div>
    ${pool.parts.map(die => {
      const assignment = assignmentByUnit.get(die.partId);
      const selected = slot.selections.find(entry => entry.selectionId === assignment?.selectionId);
      return `<div class="fast-nri-qa-defense-row"><span><strong>d${esc(die.faces)} = ${esc(die.value)}</strong>${selected ? ` → ${esc(selectionName(selected))}` : " · не назначен"}</span><span class="fast-nri-qa-row-actions">${slot.selections.map(selection => `<button type="button" data-fast-nri-v2-assign data-pool-id="${escAttr(pool.poolId)}" data-unit-id="${escAttr(die.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}">→ ${esc(selectionName(selection))}</button>`).join("")}</span></div>`;
    }).join("")}
    <div class="fast-nri-qa-warning">Назначение меняет только получателя конкретного уже выпавшего куба; значение не перебрасывается.</div>
  </section>`;
}

function dependentPreviewHTML(state) {
  if (state.metadata?.qaV2Scenario !== "drain") return "";
  const part = state.parts.find(entry => entry.partId === "drain");
  const result = part?.targetResults.find(entry => entry.targetSlotId === "damage-target");
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  const activeDice = target?.current?.outcomeViews?.flatMap(view => view.parts).filter(entry => entry.kind === "die" && !entry.excluded) ?? [];
  const largest = activeDice.length ? Math.max(...activeDice.map(entry => Number(entry.value) || 0)) : 0;
  const degree = result?.degreeState?.baseDegree;
  const resource = degree ? ({ failure: 0, partial: 1, success: 2, great: 3 }[degree] ?? 0) : 0;
  const self = part?.targetSlots.find(slot => slot.slotId === "self")?.selections?.[0];
  return `<section class="fast-nri-qa-stage">
    <div class="fast-nri-qa-stage-title">Зависимые OutcomeComponent</div>
    <div>Damage → цель урона.</div>
    <div>Если при Application фактически нанесён положительный Damage: <strong>${esc(self ? selectionName(self) : "источник")}</strong> получает Healing = наибольший оставшийся куб (<strong>${esc(largest)}</strong>) и Resource по степени (<strong>${esc(resource)}</strong>).</div>
    <div class="fast-nri-qa-warning">Это структурированная зависимость компонентов. Recipient-only источник не имеет собственной КЗ/степени.</div>
  </section>`;
}

export function qaV2DeclarationCardHTML(rawState, { resolutionMessageId = null } = {}) {
  const state = normalizeActionState(rawState);
  const scenario = scenarioFromState(state);
  return `<div class="fast-nri-chat-roll fast-nri-qa-action-card fast-nri-v2-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-bullseye"></i><strong>QA 0.5.76 — ${esc(scenario.label)}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Карточка 1 · цели</span><span>сначала цель, потом бросок</span></div>
    <div class="fast-nri-qa-warning">${esc(scenario.description)}</div>
    ${state.parts.map(part => partHTML(state, part)).join("")}
    ${diagnosticsHTML(state)}
    <section class="fast-nri-qa-stage">
      <button type="button" data-fast-nri-v2-declare><i class="fa-solid fa-bullhorn"></i><span>Заявить действие</span></button>
      <div class="fast-nri-qa-warning">Пустой обязательный TargetSlot — предупреждение, а не hard block. После броска цели всё равно можно исправить.</div>
      ${resolutionMessageId ? `<div class="fast-nri-qa-warning">Карточка выбора целей остаётся активной. Последняя обработка: ${esc(resolutionMessageId)}.</div>` : ""}
    </section>
  </div>`;
}

export function qaV2ResolutionCardHTML(rawState) {
  const state = normalizeActionState(rawState);
  const scenario = scenarioFromState(state);
  const anyPendingOutcome = state.parts.some(part => !partOutcomesReady(state, part));
  return `<div class="fast-nri-chat-roll fast-nri-qa-action-card fast-nri-v2-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-gears"></i><strong>QA 0.5.76 — Разрешение · ${esc(scenario.label)}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Карточка 2 · атака, результат и Защиты</span><span>редактируемый snapshot</span></div>
    ${state.parts.map(part => partHTML(state, part, { resolution: true })).join("")}
    ${allocationHTML(state)}
    ${dependentPreviewHTML(state)}
    ${diagnosticsHTML(state)}
    ${anyPendingOutcome ? `<div class="fast-nri-qa-warning">Сначала выполните нужные дополнительные броски. Это не блокирует редактирование целей и исходных степеней.</div>` : ""}
    <section class="fast-nri-qa-stage">
      <button type="button" data-fast-nri-v2-finalize><i class="fa-solid fa-arrow-right-to-bracket"></i><span>Применить результат</span></button>
      <div class="fast-nri-qa-warning">Кнопка создаёт одну общую Final/Application Card. Никакие HP/эффекты на этом шаге ещё не меняются.</div>
    </section>
  </div>`;
}

async function persistDeclaration(message, state, { resolutionMessageId = undefined } = {}) {
  const linked = resolutionMessageId === undefined ? (message.getFlag?.("fast-nri", "qaV2ResolutionMessageId") ?? null) : resolutionMessageId;
  const next = normalizeActionState({ ...state, rootMessageId: state.rootMessageId || message.id });
  await message.update({
    content: qaV2DeclarationCardHTML(next, { resolutionMessageId: linked }),
    ...actionStateFlagUpdate(next),
    "flags.fast-nri.kind": QA_V2_DECLARATION_KIND,
    "flags.fast-nri.qaV2ResolutionMessageId": linked
  });
  return next;
}

async function persistResolution(message, state) {
  const next = normalizeActionState({ ...state, rootMessageId: state.rootMessageId || message.id });
  await message.update({
    content: qaV2ResolutionCardHTML(next),
    ...actionStateFlagUpdate(next),
    "flags.fast-nri.kind": QA_V2_RESOLUTION_KIND
  });
  return next;
}

async function buildInitialState(scenarioId) {
  const scenario = SCENARIOS[scenarioId] ?? SCENARIOS.arrows;
  return createActionState({
    actionContext: contextForQa(scenario),
    definition: scenario.definition,
    metadata: { qaFixture: "0.5.76", qaV2Scenario: scenario.id, lifecycle: "target-first" }
  });
}

export async function startMultiPartQa(scenarioId = "arrows") {
  const state = await buildInitialState(scenarioId);
  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: qaV2DeclarationCardHTML(state),
    flags: { "fast-nri": { kind: QA_V2_DECLARATION_KIND, actionState: state } }
  });
  await persistDeclaration(message, state);
  return message;
}

function newSelectionIds(before, after, partId, slotId) {
  const beforePart = before.parts.find(part => part.partId === partId);
  const afterPart = after.parts.find(part => part.partId === partId);
  const beforeSlot = beforePart?.targetSlots.find(slot => slot.slotId === slotId);
  const afterSlot = afterPart?.targetSlots.find(slot => slot.slotId === slotId);
  const ids = new Set((beforeSlot?.selections ?? []).map(entry => entry.selectionId));
  return (afterSlot?.selections ?? []).filter(entry => !ids.has(entry.selectionId)).map(entry => entry.selectionId);
}

function poolForPart(state, partId) {
  return state.poolRegistry.find(pool => pool.partId === partId) ?? null;
}

function profileSnapshot(state, part, result) {
  const target = normalizeTargetResult(result.targetResult);
  const pool = poolForPart(state, part.partId);
  if (!pool) return target.base;
  const activeCount = PROFILE_ACTIVE_DICE[result.degreeState?.baseDegree] ?? pool.parts.length;
  return {
    degree: result.degreeState?.baseDegree ?? target.base.degree,
    effectDegree: result.degreeState?.baseDegree ?? target.base.effectDegree,
    outcomeViews: [{
      viewId: `view-${part.partId}-${result.selectionId}`,
      sourcePoolId: pool.poolId,
      parts: pool.parts.map((entry, index) => ({
        partId: `${part.partId}-${entry.partId}`,
        sourcePartId: entry.partId,
        kind: entry.kind,
        faces: entry.faces,
        value: entry.value,
        excluded: Boolean(entry.excluded) || index >= activeCount,
        exclusionReason: Boolean(entry.excluded) ? (entry.exclusionReason || "manual") : index >= activeCount ? "profile" : null,
        metadata: { componentId: pool.componentId }
      }))
    }],
    components: [{ componentId: pool.componentId, type: "damage", poolId: pool.poolId }],
    metadata: { qaV2: true }
  };
}

function bindPoolToResult(state, partId, slotId, selectionId) {
  let next = normalizeActionState(state);
  const part = next.parts.find(entry => entry.partId === partId);
  const result = partResultFor(part, slotId, selectionId);
  if (!result?.targetResult || !poolForPart(next, partId)) return next;
  return setPartTargetResultBase(next, partId, slotId, selectionId, profileSnapshot(next, part, result), { preserveSteps: true });
}

async function addSelections(element, tokens, addedFrom) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const partId = element.dataset.partId;
  const slotId = element.dataset.slotId;
  const refs = tokens.map(tokenRef).filter(Boolean);
  const part = state.parts.find(entry => entry.partId === partId);
  const slot = part?.targetSlots.find(entry => entry.slotId === slotId);
  if (!part || !slot) return;

  const duplicateGate = filterDuplicateTargetSelectionsByHardBlock({
    enabled: preventDuplicateTargetSelectionsEnabled(),
    allowDuplicates: slot.allowDuplicates,
    existingSelections: slot.selections,
    candidates: refs
  });
  if (duplicateGate.blocked.length) {
    const names = duplicateGate.blocked
      .map(entry => entry.candidate?.name)
      .filter(Boolean);
    const suffix = names.length ? `: ${names.join(", ")}` : "";
    ui.notifications.info(`HB-05: цель уже добавлена в этот слот${suffix}.`);
  }
  if (!duplicateGate.accepted.length) return;

  let next = addTargetSlotSelections(state, partId, slotId, duplicateGate.accepted, { addedFrom });
  if (messageKind(message) === QA_V2_RESOLUTION_KIND) {
    for (const selectionId of newSelectionIds(state, next, partId, slotId)) {
      const part = next.parts.find(entry => entry.partId === partId);
      const slot = part?.targetSlots.find(entry => entry.slotId === slotId);
      if (slot?.roles.includes("resolution")) {
        next = resolvePartTargetSelectionDegree(next, partId, slotId, selectionId, qaDegreeResolver);
        next = bindPoolToResult(next, partId, slotId, selectionId);
      }
    }
    await persistResolution(message, next);
  } else if (messageKind(message) === QA_V2_DECLARATION_KIND) {
    await persistDeclaration(message, next);
  }
}

async function removeSelection(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const next = removeTargetSlotSelection(state, element.dataset.partId, element.dataset.slotId, element.dataset.selectionId);
  if (messageKind(message) === QA_V2_RESOLUTION_KIND) await persistResolution(message, next);
  else if (messageKind(message) === QA_V2_DECLARATION_KIND) await persistDeclaration(message, next);
}

async function rollDeclarationChecks(rawState) {
  let state = normalizeActionState(rawState);
  for (const part of state.parts) {
    if (part.declaration.rollMode === "none" || !part.declaration.formula) continue;
    const roll = await evaluatedRoll(part.declaration.formula);
    state = registerActionRoll(state, {
      rollId: `declaration-${part.partId}-${randomId("roll")}`,
      partId: part.partId,
      kind: "declaration",
      label: part.declaration.label,
      roll: rollStateFromRoll(roll, part.declaration.formula)
    });
  }
  return state;
}

async function rollOneOutcomeComponent(rawState, partId, componentId) {
  let state = normalizeActionState(rawState);
  const part = state.parts.find(entry => entry.partId === partId);
  const component = part?.outcomeComponents.find(entry => entry.componentId === componentId);
  if (!part || !component || component.valueSource?.type !== "roll") return state;
  const formula = String(component.valueSource.params?.formula ?? "").trim();
  if (!formula) return state;
  const roll = await evaluatedRoll(formula);
  const parts = rolledDiceParts(roll);
  const allocation = state.metadata.qaV2Scenario === "allocation"
    ? { mode: "rolledPartsToTargets" }
    : { mode: "none" };
  state = registerOutcomePool(state, {
    poolId: `pool-${part.partId}-${component.componentId}`,
    partId: part.partId,
    componentId: component.componentId,
    formula,
    parts,
    allocation,
    metadata: { qaV2: true }
  });
  return rebindPartResultsToPools(state, part.partId);
}

function rebindPartResultsToPools(rawState, partId) {
  let state = normalizeActionState(rawState);
  const part = state.parts.find(entry => entry.partId === partId);
  if (!part) return state;
  for (const result of part.targetResults) {
    if (!result.targetResult || result.degreeState?.status !== "resolved") continue;
    state = bindPoolToResult(state, part.partId, result.targetSlotId, result.selectionId);
  }
  return state;
}

async function declareToResolution(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_DECLARATION_KIND) return;
  let resolved = await rollDeclarationChecks(state);
  resolved = resolveAllPartTargetDegrees(resolved, qaDegreeResolver);
  const resolution = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: qaV2ResolutionCardHTML(resolved),
    flags: { "fast-nri": { kind: QA_V2_RESOLUTION_KIND, qaV2DeclarationMessageId: message.id, actionState: resolved } }
  });
  await persistResolution(resolution, resolved);
  await persistDeclaration(message, state, { resolutionMessageId: resolution.id });
}

async function rollOutcomeFromCard(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  const next = await rollOneOutcomeComponent(state, element.dataset.partId, element.dataset.componentId);
  await persistResolution(message, next);
}

async function rerollOutcomePart(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  const faces = Math.max(2, Number(element.dataset.faces) || 2);
  const roll = await evaluatedRoll(`1d${faces}`);
  const value = rolledDiceParts(roll)[0]?.value;
  if (!value) return;
  const poolId = element.dataset.poolId;
  const pool = state.poolRegistry.find(entry => entry.poolId === poolId);
  if (!pool) return;
  let next = rerollRegisteredOutcomePart(state, { poolId, partId: element.dataset.partValueId, value });
  next = rebindPartResultsToPools(next, pool.partId);
  await persistResolution(message, next);
}

async function rerollAllOutcomeParts(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  const pool = state.poolRegistry.find(entry => entry.poolId === element.dataset.poolId);
  if (!pool) return;
  let next = state;
  for (const part of pool.parts.filter(entry => entry.kind === "die" && !entry.excluded)) {
    const roll = await evaluatedRoll(`1d${Math.max(2, Number(part.faces) || 2)}`);
    const value = rolledDiceParts(roll)[0]?.value;
    if (value) next = rerollRegisteredOutcomePart(next, { poolId: pool.poolId, partId: part.partId, value });
  }
  next = rebindPartResultsToPools(next, pool.partId);
  await persistResolution(message, next);
}

async function toggleOutcomePart(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  const pool = state.poolRegistry.find(entry => entry.poolId === element.dataset.poolId);
  if (!pool) return;
  const excluded = element.dataset.excluded === "true";
  let next = setRegisteredOutcomePartExcluded(state, {
    poolId: pool.poolId,
    partId: element.dataset.partValueId,
    excluded: !excluded,
    reason: "manual"
  });
  next = rebindPartResultsToPools(next, pool.partId);
  await persistResolution(message, next);
}

async function shiftDegree(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  let next = shiftPartTargetDegree(state, element.dataset.partId, element.dataset.slotId, element.dataset.selectionId, Number(element.dataset.delta) || 0);
  next = bindPoolToResult(next, element.dataset.partId, element.dataset.slotId, element.dataset.selectionId);
  await persistResolution(message, next);
}

function exactlyOneDefender() {
  const controlled = currentControlledTokens();
  if (controlled.length !== 1) {
    ui.notifications.warn("Для QA-Защиты выдели ровно один токен-защитник.");
    return null;
  }
  return controlled[0];
}

async function addDefense(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const defender = exactlyOneDefender();
  if (!defender) return;
  const part = state.parts.find(entry => entry.partId === element.dataset.partId);
  const result = partResultFor(part, element.dataset.slotId, element.dataset.selectionId);
  if (!result?.targetResult) return;
  const roll = await evaluatedRoll(QA_V2_DEFENSE_FORMULA);
  const rollState = rollStateFromRoll(roll, QA_V2_DEFENSE_FORMULA);
  const ref = tokenRef(defender) ?? {};
  const next = appendPartResolutionStep(state, part.partId, element.dataset.slotId, element.dataset.selectionId, {
    stepId: randomId("def-v2"),
    type: "defense",
    actor: { actorUuid: ref.actorUuid, tokenUuid: ref.tokenUuid, name: ref.name },
    actionRef: { name: "QA-защита", procedureId: "qa-defense" },
    roll: rollState,
    operation: defenseSucceeded(rollState) ? smallestActiveDieOperation(result.targetResult) : { resolverId: "noop", params: {} }
  });
  await persistResolution(message, next);
}

async function rerollDefense(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const roll = await evaluatedRoll(QA_V2_DEFENSE_FORMULA);
  const rollState = rollStateFromRoll(roll, QA_V2_DEFENSE_FORMULA);
  const next = rerollPartResolutionStep(
    state,
    element.dataset.partId,
    element.dataset.slotId,
    element.dataset.selectionId,
    element.dataset.stepId,
    rollState,
    {
      deriveOperation: ({ step, targetResult }) => defenseSucceeded(step.roll)
        ? smallestActiveDieOperation(targetResult, step.stepId)
        : { resolverId: "noop", params: {} }
    }
  );
  await persistResolution(message, next);
}

async function undoDefense(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const next = removePartResolutionStep(state, element.dataset.partId, element.dataset.slotId, element.dataset.selectionId, element.dataset.stepId);
  await persistResolution(message, next);
}

async function assignUnit(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state) return;
  const next = assignOutcomeUnitToTarget(state, {
    poolId: element.dataset.poolId,
    unitId: element.dataset.unitId,
    targetSlotId: element.dataset.slotId,
    selectionId: element.dataset.selectionId
  });
  await persistResolution(message, next);
}



function finalMessagesForBatch(batchId) {
  const id = String(batchId ?? "").trim();
  if (!id) return [];
  return Array.from(globalThis.game?.messages?.contents ?? globalThis.game?.messages ?? []).filter(message =>
    message?.getFlag?.("fast-nri", "kind") === QA_V2_FINAL_KIND
    && message?.getFlag?.("fast-nri", "qaV2FinalBatchId") === id
  );
}

function finalResultsFromMessage(message) {
  const many = message?.getFlag?.("fast-nri", "qaV2FinalResults");
  if (Array.isArray(many)) return many.map(normalizeFinalResultPackage);
  const one = message?.getFlag?.("fast-nri", "qaV2FinalResult");
  return one ? [normalizeFinalResultPackage(one)] : [];
}

function finalResultFromMessage(message, finalResultId = null) {
  const values = finalResultsFromMessage(message);
  if (!finalResultId) return values[0] ?? null;
  return values.find(result => result.finalResultId === String(finalResultId)) ?? null;
}

function currentFinalResultsForBatch(batchId) {
  return finalMessagesForBatch(batchId).flatMap(finalResultsFromMessage);
}

function applicationMessagesForBatch(batchId) {
  const id = String(batchId ?? "").trim();
  if (!id) return [];
  return Array.from(globalThis.game?.messages?.contents ?? globalThis.game?.messages ?? []).filter(message =>
    message?.getFlag?.("fast-nri", "kind") === QA_V2_APPLICATION_KIND
    && message?.getFlag?.("fast-nri", "qaV2FinalBatchId") === id
  );
}

function applicationReceiptsForBatch(batchId) {
  return applicationMessagesForBatch(batchId)
    .map(message => message?.getFlag?.("fast-nri", "qaV2ApplicationReceipt"))
    .filter(Boolean)
    .map(normalizeApplicationReceipt);
}

function finalTypeLabel(type) {
  return ({
    damage: "Урон",
    healing: "Исцеление",
    tempHp: "Временные HP",
    resource: "Ресурс",
    effect: "Эффект",
    periodic: "Периодический эффект",
    maneuver: "Манёвр"
  })[type] ?? type ?? "Результат";
}

function dependencyStatusHTML(finalResult, dependencyState) {
  const result = normalizeFinalResultPackage(finalResult);
  if (!result.dependencies.length) return "";
  return `<div class="fast-nri-qa-warning">${dependencyState.ready ? "✓ Условие зависимого результата выполнено." : "⚠ Условие зависимого результата сейчас не выполнено. Индивидуальное применение остаётся доступным."}</div>`;
}

function finalResultRowHTML(finalResult, allResults, receipts) {
  const result = normalizeFinalResultPackage(finalResult);
  const amount = resolveFinalResultAmount(result, { finalResults: allResults });
  const dependencies = evaluateFinalResultDependencies(result, receipts);
  const recipient = result.provenance.recipient;
  const resolution = result.provenance.resolution;
  const degree = resolution.degree ? ` · ${DEGREE_LABELS[resolution.degree] ?? resolution.degree}` : "";
  return `<section class="fast-nri-qa-stage fast-nri-v2-final-result-row" data-final-result-id="${escAttr(result.finalResultId)}">
    <div class="fast-nri-qa-stage-title"><strong>${esc(result.partLabel || result.partId || "Результат")}</strong> · ${esc(result.componentLabel || finalTypeLabel(result.componentType))}</div>
    <div>Назначено: <strong>${esc(recipient.name || recipient.actorUuid || recipient.tokenUuid || "не назначено")}</strong>${esc(degree)}</div>
    <div class="fast-nri-qa-final-total">${esc(finalTypeLabel(result.componentType))}: <strong>${esc(amount)}</strong></div>
    ${dependencyStatusHTML(result, dependencies)}
    <button type="button" data-fast-nri-v2-final-apply-selected data-final-result-id="${escAttr(result.finalResultId)}"><i class="fa-solid fa-crosshairs"></i><span>Применить по выбранному</span></button>
  </section>`;
}

export function qaV2FinalCardHTML(rawFinalResults, { receipts = [] } = {}) {
  const allResults = (Array.isArray(rawFinalResults) ? rawFinalResults : [rawFinalResults]).filter(Boolean).map(normalizeFinalResultPackage);
  const batchId = allResults[0]?.batchId ?? "";
  return `<div class="fast-nri-chat-roll fast-nri-qa-final-card fast-nri-v2-final-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-list-check"></i><strong>Итог действия</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Одна Final/Application Card</span><span>${esc(allResults.length)} индивидуальн. результатов</span></div>
    ${allResults.map(result => finalResultRowHTML(result, allResults, receipts)).join("")}
    <div class="fast-nri-damage-actions"><button type="button" data-fast-nri-v2-final-apply-assigned data-batch-id="${escAttr(batchId)}"><i class="fa-solid fa-check-double"></i><span>Применить по назначенным целям</span></button></div>
    <div class="fast-nri-qa-warning">Массовая кнопка использует явно назначенных в действии получателей. Индивидуальная кнопка применяет только выбранный result stream к текущим controlled Tokens.</div>
  </div>`;
}

async function refreshFinalBatch(batchId) {
  const messages = finalMessagesForBatch(batchId);
  if (!messages.length) return;
  const receipts = applicationReceiptsForBatch(batchId);
  for (const message of messages) {
    const finalResults = finalResultsFromMessage(message);
    const content = qaV2FinalCardHTML(finalResults, { receipts });
    if (message.content !== content) await message.update({ content });
  }
}

async function finalizeV2Results(element) {
  const { message, state } = stateFromElement(element);
  if (!message || !state || messageKind(message) !== QA_V2_RESOLUTION_KIND) return;
  const batchId = randomId(`final-batch-${state.actionId}`);
  const finalResults = materializeActionFinalResults(state, { batchId });
  if (!finalResults.length) {
    ui.notifications.warn("QA 0.5.76: пока нечего применять. Выполни нужный бросок результата или назначь получателей/кубы.");
    return;
  }
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: qaV2FinalCardHTML(finalResults, { receipts: [] }),
    flags: {
      "fast-nri": {
        kind: QA_V2_FINAL_KIND,
        qaV2ResolutionMessageId: message.id,
        qaV2FinalBatchId: batchId,
        qaV2FinalResults: finalResults
      }
    }
  });
  await message.update({ "flags.fast-nri.qaV2FinalBatchId": batchId });
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

function qaV2ApplicationCardHTML(receipt, { provenanceName = null } = {}) {
  const normalized = normalizeApplicationReceipt(receipt);
  const type = finalTypeLabel(normalized.componentType);
  return `<div class="fast-nri-chat-roll fast-nri-qa-application-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-receipt"></i><strong>${esc(normalized.recipient.name || "Получатель")} · ${esc(type)}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>ApplicationReceipt 0.5.76</span><span>Final provenance: ${esc(provenanceName || "—")}</span></div>
    <div class="fast-nri-qa-final-total">Запрошено: <strong>${esc(normalized.requestedAmount)}</strong> · применено: <strong>${esc(normalized.appliedAmount)}</strong></div>
    ${normalized.dependencyReceiptIds.length ? `<div class="fast-nri-qa-warning">Использованы dependency receipts: ${esc(normalized.dependencyReceiptIds.join(", "))}</div>` : ""}
    ${normalized.undone ? `<div class="fast-nri-qa-warning">Отменено. Это не выполняет каскадный Undo уже применённых зависимых результатов.</div>` : `<button type="button" data-fast-nri-v2-application-undo><i class="fa-solid fa-rotate-left"></i><span>Отмена</span></button>`}
  </div>`;
}

async function applyPackageToActor(finalResult, actor, amount) {
  const requestedAmount = Math.max(0, Number(amount) || 0);
  const type = finalResult.componentType;
  if (type === "damage") {
    const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
    const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
    const tempSpent = Math.min(previousTemp, requestedAmount);
    const hpSpent = Math.min(previousHp, Math.max(0, requestedAmount - tempSpent));
    const afterTemp = previousTemp - tempSpent;
    const afterHp = previousHp - hpSpent;
    await actor.update({ "system.hp.temp": afterTemp, "system.hp.value": afterHp }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
    return {
      appliedAmount: tempSpent + hpSpent,
      before: { hp: previousHp, tempHp: previousTemp },
      after: { hp: afterHp, tempHp: afterTemp },
      undoPatch: { "system.hp.value": previousHp, "system.hp.temp": previousTemp }
    };
  }
  if (type === "healing") {
    const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
    const maxHp = Math.max(0, Number(actor.system?.hp?.max) || 0);
    const afterHp = Math.min(maxHp, previousHp + requestedAmount);
    await actor.update({ "system.hp.value": afterHp }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
    return {
      appliedAmount: Math.max(0, afterHp - previousHp),
      before: { hp: previousHp, maxHp },
      after: { hp: afterHp, maxHp },
      undoPatch: { "system.hp.value": previousHp }
    };
  }
  if (type === "resource") {
    const previousValue = Math.max(0, Number(actor.system?.classResource?.value) || 0);
    const maxValue = Math.max(0, Number(actor.system?.classResource?.max) || 0);
    const afterValue = Math.min(maxValue, previousValue + requestedAmount);
    await actor.update({ "system.classResource.value": afterValue });
    return {
      appliedAmount: Math.max(0, afterValue - previousValue),
      before: { classResource: previousValue, classResourceMax: maxValue },
      after: { classResource: afterValue, classResourceMax: maxValue },
      undoPatch: { "system.classResource.value": previousValue }
    };
  }
  return { appliedAmount: 0, before: {}, after: {}, undoPatch: {} };
}

async function createQaApplicationReceiptMessage(finalResult, token, actor, amount, dependencyState, mode) {
  if (!["damage", "healing", "resource"].includes(finalResult.componentType)) {
    ui.notifications.warn(`QA 0.5.76: Application adapter для ${finalResult.componentType} ещё не подключён.`);
    return null;
  }
  const application = await applyPackageToActor(finalResult, actor, amount);
  const receipt = createApplicationReceipt({
    finalResultId: finalResult.finalResultId,
    batchId: finalResult.batchId,
    componentId: finalResult.componentId,
    componentType: finalResult.componentType,
    recipient: {
      tokenUuid: token?.document?.uuid ?? token?.uuid ?? token?.uuid ?? null,
      actorUuid: actor.uuid,
      name: token?.name || actor.name || "Получатель"
    },
    requestedAmount: amount,
    appliedAmount: application.appliedAmount,
    before: application.before,
    after: application.after,
    dependencyReceiptIds: dependencyState.qualifyingReceiptIds,
    metadata: { undoPatch: application.undoPatch, qaV2: true, applicationMode: mode }
  });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token: token?.document ?? token ?? null }),
    content: qaV2ApplicationCardHTML(receipt, { provenanceName: finalResult.provenance.recipient.name }),
    flags: {
      "fast-nri": {
        kind: QA_V2_APPLICATION_KIND,
        qaV2FinalBatchId: finalResult.batchId,
        qaV2FinalResultId: finalResult.finalResultId,
        qaV2ApplicationReceipt: receipt,
        qaV2ProvenanceName: finalResult.provenance.recipient.name
      }
    }
  });
  return receipt;
}

async function assignedRecipient(finalResult) {
  const ref = finalResult?.provenance?.recipient ?? {};
  if (ref.tokenUuid) {
    try {
      const tokenDocument = await fromUuid(ref.tokenUuid);
      if (tokenDocument?.actor) return { token: tokenDocument.object ?? tokenDocument, actor: tokenDocument.actor };
    } catch (_error) { /* fall through */ }
  }
  if (ref.actorUuid) {
    try {
      const actor = await fromUuid(ref.actorUuid);
      if (actor) return { token: null, actor };
    } catch (_error) { /* fall through */ }
  }
  return null;
}

async function applyV2FinalResultSelected(element) {
  const message = rootMessageFromElement(element);
  const finalResult = finalResultFromMessage(message, element.dataset.finalResultId);
  if (!message || !finalResult) return;
  const finalResults = finalResultsFromMessage(message);
  const receipts = applicationReceiptsForBatch(finalResult.batchId);
  const dependencyState = evaluateFinalResultDependencies(finalResult, receipts);
  if (!dependencyState.ready) ui.notifications.warn("Условие зависимого результата сейчас не выполнено. Soft automation: индивидуальное применение не блокируется.");
  const recipients = uniqueControlledRecipients();
  if (!recipients.length) {
    ui.notifications.warn("Выдели один или несколько токенов для индивидуального Application.");
    return;
  }
  const amount = resolveFinalResultAmount(finalResult, { finalResults });
  for (const token of recipients) {
    const actor = token?.actor;
    if (!actor) continue;
    await createQaApplicationReceiptMessage(finalResult, token, actor, amount, dependencyState, "current-controlled");
  }
  await refreshFinalBatch(finalResult.batchId);
}

async function applyV2FinalResultsAssigned(element) {
  const message = rootMessageFromElement(element);
  const finalResults = finalResultsFromMessage(message);
  if (!message || !finalResults.length) return;
  const batchId = finalResults[0].batchId;
  const receipts = applicationReceiptsForBatch(batchId);

  for (const finalResult of finalResults) {
    const dependencyState = evaluateFinalResultDependencies(finalResult, receipts);
    if (finalResult.dependencies.length && !dependencyState.ready) {
      ui.notifications.warn(`Условие зависимого результата «${finalResult.componentLabel || finalTypeLabel(finalResult.componentType)}» сейчас не выполнено. Soft automation: массовое применение по назначенной цели не блокируется.`);
    }
    const recipient = await assignedRecipient(finalResult);
    if (!recipient?.actor) {
      ui.notifications.warn(`Назначенный получатель «${finalResult.provenance.recipient.name || "—"}» недоступен. Остальные результаты продолжают применяться.`);
      continue;
    }
    const amount = resolveFinalResultAmount(finalResult, { finalResults });
    const receipt = await createQaApplicationReceiptMessage(finalResult, recipient.token, recipient.actor, amount, dependencyState, "assigned-recipient");
    if (receipt) receipts.push(receipt);
  }
  await refreshFinalBatch(batchId);
}

async function actorForApplicationReceipt(receipt) {
  if (receipt?.recipient?.tokenUuid) {
    try {
      const tokenDocument = await fromUuid(receipt.recipient.tokenUuid);
      if (tokenDocument?.actor) return tokenDocument.actor;
    } catch (_error) { /* fall through */ }
  }
  if (receipt?.recipient?.actorUuid) {
    try { return await fromUuid(receipt.recipient.actorUuid); }
    catch (_error) { /* fall through */ }
  }
  return null;
}

async function undoV2Application(element) {
  const message = rootMessageFromElement(element);
  const raw = message?.getFlag?.("fast-nri", "qaV2ApplicationReceipt") ?? null;
  if (!message || !raw) return;
  const receipt = normalizeApplicationReceipt(raw);
  if (receipt.undone) return;
  const actor = await actorForApplicationReceipt(receipt);
  if (!actor) {
    ui.notifications.error("QA 0.5.76: Actor для Undo не найден.");
    return;
  }
  const undoPatch = receipt.metadata?.undoPatch ?? {};
  if (Object.keys(undoPatch).length) await actor.update(undoPatch, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  const next = normalizeApplicationReceipt({ ...receipt, undone: true });
  await message.update({
    content: qaV2ApplicationCardHTML(next, { provenanceName: message.getFlag?.("fast-nri", "qaV2ProvenanceName") }),
    "flags.fast-nri.qaV2ApplicationReceipt": next
  });
  await refreshFinalBatch(receipt.batchId);
}

async function clickHandler(event) {
  const handlers = [
    ["[data-fast-nri-v2-add-targets]", el => addSelections(el, currentTargetTokens(), "target")],
    ["[data-fast-nri-v2-add-controlled]", el => addSelections(el, currentControlledTokens(), "controlled")],
    ["[data-fast-nri-v2-remove-selection]", removeSelection],
    ["[data-fast-nri-v2-declare]", declareToResolution],
    ["[data-fast-nri-v2-outcome-roll]", rollOutcomeFromCard],
    ["[data-fast-nri-v2-outcome-reroll]", rerollOutcomePart],
    ["[data-fast-nri-v2-outcome-reroll-all]", rerollAllOutcomeParts],
    ["[data-fast-nri-v2-outcome-toggle]", toggleOutcomePart],
    ["[data-fast-nri-v2-degree-shift]", shiftDegree],
    ["[data-fast-nri-v2-defense]", addDefense],
    ["[data-fast-nri-v2-defense-reroll]", rerollDefense],
    ["[data-fast-nri-v2-defense-undo]", undoDefense],
    ["[data-fast-nri-v2-assign]", assignUnit],
    ["[data-fast-nri-v2-finalize]", finalizeV2Results],
    ["[data-fast-nri-v2-final-apply-selected]", applyV2FinalResultSelected],
    ["[data-fast-nri-v2-final-apply-assigned]", applyV2FinalResultsAssigned],
    ["[data-fast-nri-v2-application-undo]", undoV2Application]
  ];
  for (const [selector, handler] of handlers) {
    const element = event.target.closest(selector);
    if (!element) continue;
    event.preventDefault();
    event.stopPropagation();
    if (element.dataset.fastNriBusy === "true") return;
    element.dataset.fastNriBusy = "true";
    try { await handler(element); }
    catch (error) {
      console.error("Быстрая НРИ | QA 0.5.76 target-first", error);
      ui.notifications.error(`QA 0.5.76: ${error?.message || "ошибка"}`);
    } finally { delete element.dataset.fastNriBusy; }
    return;
  }
}

export function activateMultiPartActionQa(root = document) {
  root.addEventListener("click", clickHandler);
  game.fastNri = game.fastNri ?? {};
  game.fastNri.qa = {
    ...(game.fastNri.qa ?? {}),
    startMultiPart: startMultiPartQa,
    startMultiAttack: () => startMultiPartQa("arrows"),
    startDependentOutcome: () => startMultiPartQa("drain"),
    startAllocation: () => startMultiPartQa("allocation")
  };
}
