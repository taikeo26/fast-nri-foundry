import {
  abilityConfiguredOutcomeKinds,
  abilityCostLabel,
  abilityCosts,
  abilityHasDegreeProfiles,
  abilityImplementationRepeat,
  abilityImplementationRuntime,
  abilityIsSpell,
  abilityOutcomeChannelForDegree,
  abilityTargeting,
  abilityTraitIds
} from "./ability-authoring.mjs";
import { abilityCheckConfig } from "./check-system.mjs";
import { actionContextFromAbility } from "./action-context.mjs";
import {
  actionStateFlagUpdate,
  actionStateFromMessage,
  addTargetSlotSelections,
  createActionState,
  normalizeActionState,
  registerOutcomePool,
  rerollRegisteredOutcomePart,
  setRegisteredOutcomePartExcluded,
  removeTargetSlotSelection
} from "./action-state.mjs";
import {
  createApplicationReceipt,
  materializeActionFinalResults,
  normalizeApplicationReceipt,
  normalizeFinalResultPackage,
  resolveFinalResultAmount
} from "./action-final-results.mjs";
import { filterDuplicateTargetSelectionsByHardBlock } from "./hard-blocks.mjs";
import { preventDuplicateTargetSelectionsEnabled } from "./settings.mjs";
import { resolveHpGainAgainstActor, resolveTemporaryHp } from "./health-actions.mjs";
import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";

/**
 * Fast NRI 0.5.76 — target-first production Ability/Spell → ActionState v2 adapter.
 *
 * Scope of this first production slice is deliberately narrow: implementations
 * without a Check and without degree profiles whose structured outcome is
 * Healing and/or Temp HP. Checked / defensive / profile-driven implementations
 * stay on the legacy adapter until their v2 resolver is connected. This avoids
 * silently losing defenses or Rulebook profile logic while the migration is in
 * progress.
 *
 * Implementation selection is phase 0 and exists before ActionState. If an
 * Ability has one implementation, phase 0 is skipped entirely.
 */

export const ABILITY_V2_DECLARATION_KIND = "ability-v2-declaration";
export const ABILITY_V2_RESOLUTION_KIND = "ability-v2-resolution";
export const ABILITY_V2_FINAL_KIND = "ability-v2-final";
export const ABILITY_V2_APPLICATION_KIND = "ability-v2-application";

function esc(value) {
  const source = String(value ?? "");
  const escape = globalThis.foundry?.utils?.escapeHTML;
  if (typeof escape === "function") return escape(source);
  return source
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

function randomId(prefix = "ability-v2") {
  const id = globalThis.foundry?.utils?.randomID?.()
    ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

function messageFromElement(element) {
  const id = element?.closest?.(".chat-message, .message")?.dataset?.messageId ?? null;
  return id ? globalThis.game?.messages?.get?.(id) ?? null : null;
}

function currentTargetTokens() {
  return Array.from(globalThis.game?.user?.targets ?? []).filter(Boolean);
}

function currentControlledTokens() {
  return Array.from(globalThis.canvas?.tokens?.controlled ?? []).filter(Boolean);
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

function sourceTokenForActor(actor) {
  const controlled = currentControlledTokens().find(token => token?.actor?.uuid === actor?.uuid);
  if (controlled) return controlled;
  return Array.from(globalThis.canvas?.tokens?.placeables ?? []).find(token => token?.actor?.uuid === actor?.uuid) ?? null;
}

function actionContextForImplementation(actor, item, runtime) {
  const base = actionContextFromAbility(actor, item, { implementationId: runtime.implementationId });
  const sourceToken = sourceTokenForActor(actor);
  return {
    ...base,
    actionId: base.actionId || randomId("action"),
    initiator: {
      ...(base.initiator ?? {}),
      actorUuid: actor.uuid,
      tokenUuid: sourceToken?.document?.uuid ?? sourceToken?.uuid ?? base.initiator?.tokenUuid ?? null
    },
    source: {
      ...(base.source ?? {}),
      actorUuid: actor.uuid,
      itemUuid: item.uuid,
      itemType: "ability",
      name: item.name,
      implementationId: runtime.implementationId,
      implementationName: runtime.implementationName
    }
  };
}

function targetSlotFromRuntime(runtime) {
  const target = abilityTargeting(runtime);
  if (["none", "location", "area"].includes(target.mode)) return null;
  const self = target.mode === "self";
  const single = target.mode === "single" || self;
  const min = self ? 1 : Math.max(0, Number(target.countMin) || (single ? 1 : 0));
  const rawMax = self || single ? 1 : Math.max(0, Number(target.countMax) || 0);
  return {
    slotId: "recipient",
    label: self ? "Получатель" : target.mode === "multiple" ? "Получатели" : "Цель",
    roles: ["recipient"],
    selectionMode: self ? "source" : "manual",
    min,
    max: rawMax > 0 ? rawMax : null,
    allowDuplicates: false,
    metadata: {
      relation: target.relation,
      rangeMode: target.rangeMode,
      rangeCells: target.rangeCells,
      requiresVisibility: target.requiresVisibility
    }
  };
}

function channelComponents(runtime, kind) {
  return abilityOutcomeChannelForDegree(runtime, kind, null).components.map((component, index) => ({
    index,
    formula: String(component?.formula ?? "").trim(),
    traitIds: Array.from(component?.traitIds ?? []).map(String).filter(Boolean),
    damageType: String(component?.damageType ?? "physical")
  })).filter(component => component.formula);
}

export function abilityV2AdapterEligibility(itemOrRuntime) {
  const runtime = itemOrRuntime?.implementationId
    ? itemOrRuntime
    : abilityImplementationRuntime(itemOrRuntime, null);
  const check = abilityCheckConfig(runtime);
  const kinds = abilityConfiguredOutcomeKinds(runtime);
  const unsupportedKinds = kinds.filter(kind => !["healing", "tempHp"].includes(kind));
  const target = abilityTargeting(runtime);
  const reasons = [];

  if (check.enabled) reasons.push("check-enabled");
  if (abilityHasDegreeProfiles(runtime)) reasons.push("degree-profiles");
  if (unsupportedKinds.length) reasons.push(`unsupported-outcome:${unsupportedKinds.join(",")}`);
  if (!kinds.length) reasons.push("no-health-outcome");
  if (Array.from(runtime.system?.effectUuids ?? []).length) reasons.push("linked-effects");
  if (!["self", "single", "multiple"].includes(target.mode)) reasons.push(`target-mode:${target.mode}`);

  return { eligible: reasons.length === 0, reasons, kinds };
}

export function abilityActionDefinitionV2(actor, item, runtime) {
  const eligibility = abilityV2AdapterEligibility(runtime);
  if (!eligibility.eligible) throw new Error(`ability-v2-not-eligible:${eligibility.reasons.join("|")}`);
  const repeat = abilityImplementationRepeat(runtime);
  const slot = targetSlotFromRuntime(runtime);
  const outcomes = eligibility.kinds.map(kind => ({
    componentId: kind,
    type: kind,
    label: kind === "healing" ? "Исцеление" : "Временные HP",
    recipient: slot ? { type: "targetSlot", targetSlotId: slot.slotId } : { type: "source" },
    timing: "resolution",
    valueSource: { type: "roll" },
    delivery: { mode: "independent" },
    metadata: {
      abilityOutcomeKind: kind,
      components: channelComponents(runtime, kind)
    }
  }));

  return {
    sourceKind: abilityIsSpell(runtime) ? "spell" : "ability",
    sourceRef: {
      actorUuid: actor.uuid,
      itemUuid: item.uuid,
      name: item.name,
      implementationId: runtime.implementationId
    },
    traits: abilityTraitIds(runtime),
    parts: [{
      partId: "result",
      label: repeat.count > 1 ? repeat.label : (runtime.implementationName || item.name),
      repeat: { count: repeat.count },
      targetSlots: slot ? [slot] : [],
      declaration: { rollMode: "none" },
      outcomeComponents: outcomes,
      metadata: { implementationId: runtime.implementationId }
    }],
    metadata: {
      adapterId: "ability-v2-health",
      implementationId: runtime.implementationId
    }
  };
}

async function spendResource(actor, runtime) {
  const costs = abilityCosts(runtime);
  const cost = Math.max(0, Number(costs.classResource) || 0);
  const source = actor.system?.classResource ?? {};
  const before = Math.max(0, Number(source.value) || 0);
  const shortage = Math.max(0, cost - before);
  if (shortage > 0) {
    globalThis.ui?.notifications?.warn?.(`${actor.name}: недостаточно ресурса «${source.label || "Классовый ресурс"}». Нужно ${cost}, доступно ${before}. Использование не блокируется.`);
  }
  const after = Math.max(0, before - cost);
  const spent = before - after;
  if (cost > 0) await actor.update({ "system.classResource.value": after });
  return { cost, before, after, spent, shortage, label: source.label || "Классовый ресурс" };
}

function resourceHTML(resource, undone = false) {
  if (!(resource?.cost > 0)) return "";
  return `<div class="fast-nri-resource-use ${undone ? "undone" : ""}">
    <div class="fast-nri-resource-use-text"><span class="fast-nri-resource-label">${esc(resource.label)}</span><strong>−${esc(resource.cost)}</strong><small>${esc(resource.before)} → ${esc(resource.after)}</small>${resource.shortage > 0 ? `<small class="fast-nri-resource-shortage">не хватает ${esc(resource.shortage)}</small>` : ""}</div>
    ${undone || resource.spent <= 0 ? "" : `<button type="button" class="fast-nri-undo-resource-button" data-fast-nri-v2-resource-undo><i class="fa-solid fa-rotate-left"></i><span>Вернуть</span></button>`}
  </div>`;
}

function selectionName(selection) {
  return selection?.name || selection?.actorUuid || selection?.tokenUuid || "Существо";
}

function slotHTML(part, slot) {
  const rows = slot.selections.length
    ? slot.selections.map(selection => `<div class="fast-nri-qa-target-row"><div class="fast-nri-qa-target-head"><span><strong>${esc(selectionName(selection))}</strong></span><button type="button" data-fast-nri-ability-v2-remove data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}" title="Удалить"><i class="fa-solid fa-trash"></i></button></div></div>`).join("")
    : `<div class="fast-nri-roll-empty">Получатели не выбраны.</div>`;
  const defaultHint = slot.selectionMode === "source" ? " · по умолчанию: источник" : "";
  return `<div class="fast-nri-v2-slot">
    <div class="fast-nri-qa-stage-title">${esc(slot.label)} <small>· получатель${esc(defaultHint)}</small></div>
    <div class="fast-nri-qa-target-actions">
      <button type="button" data-fast-nri-ability-v2-add-targets data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}"><span>Добавить цели</span></button>
      <button type="button" data-fast-nri-ability-v2-add-controlled data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}"><span>Добавить выделенное</span></button>
    </div>
    <div class="fast-nri-qa-roster">${rows}</div>
  </div>`;
}

function poolForPartComponent(state, partId, componentId) {
  return state.poolRegistry.find(pool => pool.partId === partId && pool.componentId === componentId) ?? null;
}

function outcomeButtonLabel(component) {
  if (component.type === "healing") return "Бросить исцеление";
  if (component.type === "tempHp") return "Бросить временные HP";
  return component.label ? `Бросить: ${component.label}` : "Бросить результат";
}

function poolEditorHTML(state, part, component) {
  const pool = poolForPartComponent(state, part.partId, component.componentId);
  if (!pool) {
    return `<button type="button" data-fast-nri-ability-v2-outcome-roll data-part-id="${escAttr(part.partId)}" data-component-id="${escAttr(component.componentId)}"><i class="fa-solid fa-dice"></i><span>${esc(outcomeButtonLabel(component))}</span></button>`;
  }
  const activeDice = pool.parts.filter(entry => entry.kind === "die" && !entry.excluded);
  return `<div class="fast-nri-qa-reroll-editor" data-pool-id="${escAttr(pool.poolId)}">
    <div class="fast-nri-qa-stage-title">${esc(component.label || component.type)} · ${esc(pool.formula || "бросок")}</div>
    ${pool.parts.map(entry => `<div class="fast-nri-qa-final-die-row ${entry.excluded ? "fast-nri-qa-die-excluded" : ""}">
      <span>${entry.kind === "die" ? `d${esc(entry.faces)}` : "фикс."} = <strong>${esc(entry.value)}</strong>${entry.excluded ? " · исключён" : ""}</span>
      <span class="fast-nri-qa-row-actions">
        ${entry.kind === "die" && !entry.excluded ? `<button type="button" data-fast-nri-ability-v2-outcome-reroll data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-faces="${escAttr(entry.faces)}"><span>Переброс</span></button>` : ""}
        ${entry.kind === "die" ? `<button type="button" data-fast-nri-ability-v2-outcome-toggle data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-excluded="${entry.excluded ? "true" : "false"}"><span>${entry.excluded ? "Вернуть" : "Исключить"}</span></button>` : ""}
      </span>
    </div>`).join("")}
    <button type="button" data-fast-nri-ability-v2-outcome-reroll-all data-pool-id="${escAttr(pool.poolId)}" ${activeDice.length ? "" : "disabled"}><i class="fa-solid fa-dice"></i><span>Перебросить всё</span></button>
  </div>`;
}

function partHTML(state, part, { resolution = false } = {}) {
  return `<section class="fast-nri-qa-stage fast-nri-v2-part" data-part-id="${escAttr(part.partId)}">
    <div class="fast-nri-v2-part-title"><strong>${esc(part.label)}</strong></div>
    <div>Атака/проверка: <strong>не требуется</strong></div>
    ${part.targetSlots.map(slot => slotHTML(part, slot)).join("")}
    ${resolution ? `<section class="fast-nri-qa-stage"><div class="fast-nri-qa-stage-title">Дополнительный результат</div>${part.outcomeComponents.map(component => poolEditorHTML(state, part, component)).join("")}</section>` : ""}
  </section>`;
}

function cardHeader(item, runtime, phase) {
  const icon = abilityIsSpell(runtime) ? "fa-wand-magic-sparkles" : "fa-bolt";
  return `<div class="fast-nri-chat-roll-title"><i class="fa-solid ${icon}"></i><strong>${esc(item.name)} — ${esc(runtime.implementationName || "Основная реализация")}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>${abilityIsSpell(runtime) ? "Заклинание" : "Способность"}</span><span>${esc(phase)}</span></div>`;
}

export function abilityV2DeclarationCardHTML(state, { item, runtime, resource, resourceUndone = false, resolutionMessageId = null } = {}) {
  const normalized = normalizeActionState(state);
  return `<div class="fast-nri-chat-roll fast-nri-v2-card fast-nri-ability-v2-card">
    ${cardHeader(item, runtime, "Карточка 1 · выбор целей")}
    ${runtime.system?.description ? `<div class="fast-nri-ability-description">${runtime.system.description}</div>` : ""}
    <div class="fast-nri-ability-rule-summary"><div class="fast-nri-ability-rule-row"><strong>Требуется:</strong><span>${esc(abilityCostLabel(runtime, item.parent ?? null))}</span></div></div>
    ${normalized.parts.map(part => partHTML(normalized, part)).join("")}
    <section class="fast-nri-qa-stage"><button type="button" data-fast-nri-ability-v2-declare><i class="fa-solid fa-bullhorn"></i><span>Заявить действие</span></button><div class="fast-nri-qa-warning">Пустая обязательная цель предупреждает, но не блокирует заявление. Цель можно исправить и после броска.</div>${resolutionMessageId ? `<div class="fast-nri-qa-warning">Карточка выбора целей остаётся активной. Последняя обработка: ${esc(resolutionMessageId)}.</div>` : ""}</section>
    ${resourceHTML(resource, resourceUndone)}
  </div>`;
}

export function abilityV2ResolutionCardHTML(state, { item, runtime } = {}) {
  const normalized = normalizeActionState(state);
  return `<div class="fast-nri-chat-roll fast-nri-v2-card fast-nri-ability-v2-card">
    ${cardHeader(item, runtime, "Карточка 2 · результат и обработка")}
    ${normalized.parts.map(part => partHTML(normalized, part, { resolution: true })).join("")}
    <section class="fast-nri-qa-stage"><button type="button" data-fast-nri-ability-v2-finalize><i class="fa-solid fa-arrow-right-to-bracket"></i><span>Применить результат</span></button><div class="fast-nri-qa-warning">На этом шаге создаётся одна общая Final/Application Card; HP ещё не изменяются.</div></section>
  </div>`;
}

function rollParts(roll, metadata = {}) {
  const parts = [];
  let sign = 1;
  let sequence = 0;
  for (const term of Array.from(roll?.terms ?? [])) {
    const operator = String(term?.operator ?? "").trim();
    if (operator) {
      if (operator === "+") sign = 1;
      else if (operator === "-") sign = -1;
      continue;
    }
    const results = Array.isArray(term?.results)
      ? term.results.filter(result => result?.active !== false && !result?.discarded)
      : null;
    if (results?.length && Number.isFinite(Number(term?.faces))) {
      for (const result of results) {
        const value = finiteNumberOrNull(result?.result);
        if (value === null || sign < 0) continue;
        parts.push({ partId: `part-${sequence++}`, kind: "die", faces: Number(term.faces), value, metadata });
      }
      continue;
    }
    const numeric = finiteNumberOrNull(term?.number ?? term?.total);
    if (numeric !== null && numeric > 0 && sign >= 0) {
      parts.push({ partId: `part-${sequence++}`, kind: "fixed", value: numeric, metadata });
    }
  }
  return parts;
}

async function evaluatedRoll(formula) {
  const RollClass = globalThis.Roll;
  if (!RollClass) throw new Error("Foundry Roll API unavailable");
  const roll = new RollClass(formula);
  await roll.evaluate();
  try { await globalThis.game?.dice3d?.showForRoll?.(roll, globalThis.game?.user, true); }
  catch (_error) { /* Dice So Nice is optional. */ }
  return roll;
}

async function rollOutcomeComponent(rawState, partId, componentId) {
  let next = normalizeActionState(rawState);
  const part = next.parts.find(entry => entry.partId === partId);
  const component = part?.outcomeComponents.find(entry => entry.componentId === componentId);
  if (!part || !component) return next;
  const sources = Array.from(component.metadata?.components ?? []);
  const parts = [];
  const formulas = [];
  for (const source of sources) {
    if (!source.formula) continue;
    const roll = await evaluatedRoll(source.formula);
    formulas.push(source.formula);
    parts.push(...rollParts(roll, {
      componentId: component.componentId,
      traitIds: source.traitIds,
      damageType: source.damageType,
      formulaComponentIndex: source.index
    }).map((value, index) => ({ ...value, partId: `${component.componentId}-${source.index}-${index}` })));
  }
  return registerOutcomePool(next, {
    poolId: `pool-${part.partId}-${component.componentId}`,
    partId: part.partId,
    componentId: component.componentId,
    formula: formulas.join(" + "),
    parts,
    allocation: { mode: "none" },
    metadata: { adapterId: "ability-v2-health" }
  });
}

async function persistDeclaration(message, state, { item, runtime, resource, resolutionMessageId = undefined } = {}) {
  const linked = resolutionMessageId === undefined ? (message.getFlag?.("fast-nri", "abilityV2ResolutionMessageId") ?? null) : resolutionMessageId;
  const next = normalizeActionState({ ...state, rootMessageId: state.rootMessageId || message.id });
  const resourceUndone = Boolean(message.getFlag?.("fast-nri", "resourceUndone"));
  await message.update({
    content: abilityV2DeclarationCardHTML(next, { item, runtime, resource, resourceUndone, resolutionMessageId: linked }),
    ...actionStateFlagUpdate(next),
    "flags.fast-nri.kind": ABILITY_V2_DECLARATION_KIND,
    "flags.fast-nri.abilityV2ResolutionMessageId": linked
  });
  return next;
}

async function persistResolution(message, state, { item, runtime } = {}) {
  const next = normalizeActionState({ ...state, rootMessageId: state.rootMessageId || message.id });
  await message.update({
    content: abilityV2ResolutionCardHTML(next, { item, runtime }),
    ...actionStateFlagUpdate(next),
    "flags.fast-nri.kind": ABILITY_V2_RESOLUTION_KIND
  });
  return next;
}

function flagsResource(message) {
  return {
    cost: Math.max(0, Number(message?.getFlag?.("fast-nri", "cost")) || 0),
    before: Math.max(0, Number(message?.getFlag?.("fast-nri", "before")) || 0),
    after: Math.max(0, Number(message?.getFlag?.("fast-nri", "after")) || 0),
    spent: Math.max(0, Number(message?.getFlag?.("fast-nri", "spent")) || 0),
    shortage: Math.max(0, Number(message?.getFlag?.("fast-nri", "shortage")) || 0),
    label: String(message?.getFlag?.("fast-nri", "label") ?? "Классовый ресурс")
  };
}

async function itemRuntimeFromMessage(message) {
  const actor = await globalThis.fromUuid?.(message?.getFlag?.("fast-nri", "actorUuid"));
  const item = await globalThis.fromUuid?.(message?.getFlag?.("fast-nri", "itemUuid"));
  if (!actor || !item || item.type !== "ability") return {};
  const runtime = abilityImplementationRuntime(item, message.getFlag?.("fast-nri", "implementationId") ?? null);
  return { actor, item, runtime };
}

export async function startAbilityV2Implementation(actor, item, implementationId, { parentMessageId = null } = {}) {
  const runtime = abilityImplementationRuntime(item, implementationId);
  const eligibility = abilityV2AdapterEligibility(runtime);
  if (!eligibility.eligible) return null;
  const resource = await spendResource(actor, runtime);
  const definition = abilityActionDefinitionV2(actor, item, runtime);
  let state = createActionState({
    actionContext: actionContextForImplementation(actor, item, runtime),
    definition,
    metadata: {
      adapterId: "ability-v2-health",
      itemUuid: item.uuid,
      implementationId: runtime.implementationId,
      parentMessageId
    }
  });

  // Preserve the familiar "target first, then use" convenience for a single
  // manual Part/Slot. Repeated Parts are intentionally left unfilled so a
  // current target is not silently copied into every independent result.
  if (state.parts.length === 1 && state.parts[0].targetSlots.length === 1 && state.parts[0].targetSlots[0].selectionMode === "manual") {
    const refs = currentTargetTokens().map(tokenRef).filter(Boolean);
    if (refs.length) {
      const gate = filterDuplicateTargetSelectionsByHardBlock({
        enabled: preventDuplicateTargetSelectionsEnabled(),
        allowDuplicates: state.parts[0].targetSlots[0].allowDuplicates,
        existingSelections: state.parts[0].targetSlots[0].selections,
        candidates: refs
      });
      state = addTargetSlotSelections(state, state.parts[0].partId, state.parts[0].targetSlots[0].slotId, gate.accepted, { addedFrom: "target" });
    }
  }

  const message = await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker({ actor }),
    content: abilityV2DeclarationCardHTML(state, { item, runtime, resource }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_DECLARATION_KIND,
        actorUuid: actor.uuid,
        itemUuid: item.uuid,
        implementationId: runtime.implementationId,
        parentMessageId,
        resourceUndone: false,
        ...resource,
        actionState: state
      }
    }
  });
  await persistDeclaration(message, state, { item, runtime, resource });
  return { message, actor, item, runtime, resource, actionState: state, adapter: "v2" };
}

async function addSelections(element, tokens, addedFrom) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || ![ABILITY_V2_DECLARATION_KIND, ABILITY_V2_RESOLUTION_KIND].includes(message.getFlag?.("fast-nri", "kind"))) return;
  const partId = element.dataset.partId;
  const slotId = element.dataset.slotId;
  const part = state.parts.find(entry => entry.partId === partId);
  const slot = part?.targetSlots.find(entry => entry.slotId === slotId);
  if (!part || !slot) return;
  const candidates = tokens.map(tokenRef).filter(Boolean);
  const gate = filterDuplicateTargetSelectionsByHardBlock({
    enabled: preventDuplicateTargetSelectionsEnabled(),
    allowDuplicates: slot.allowDuplicates,
    existingSelections: slot.selections,
    candidates: candidates
  });
  if (gate.blocked.length) globalThis.ui?.notifications?.info?.(`HB-05: ${gate.blocked.length} повторн. цель не добавлена в этот слот.`);
  const next = addTargetSlotSelections(state, partId, slotId, gate.accepted, { addedFrom });
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  if (message.getFlag("fast-nri", "kind") === ABILITY_V2_DECLARATION_KIND) {
    await persistDeclaration(message, next, { item, runtime, resource: flagsResource(message) });
  } else {
    await persistResolution(message, next, { item, runtime });
  }
}

async function removeSelection(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state) return;
  const next = removeTargetSlotSelection(state, element.dataset.partId, element.dataset.slotId, element.dataset.selectionId);
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  if (message.getFlag("fast-nri", "kind") === ABILITY_V2_DECLARATION_KIND) {
    await persistDeclaration(message, next, { item, runtime, resource: flagsResource(message) });
  } else if (message.getFlag("fast-nri", "kind") === ABILITY_V2_RESOLUTION_KIND) {
    await persistResolution(message, next, { item, runtime });
  }
}

async function resolveDeclaration(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_DECLARATION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const resolution = await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker({ actor: item.parent ?? null }),
    content: abilityV2ResolutionCardHTML(state, { item, runtime }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_RESOLUTION_KIND,
        actorUuid: message.getFlag("fast-nri", "actorUuid"),
        itemUuid: item.uuid,
        implementationId: runtime.implementationId,
        abilityV2DeclarationMessageId: message.id,
        actionState: state
      }
    }
  });
  await persistResolution(resolution, state, { item, runtime });
  await persistDeclaration(message, state, { item, runtime, resource: flagsResource(message), resolutionMessageId: resolution.id });
}

async function rollOutcomeFromResolution(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const next = await rollOutcomeComponent(state, element.dataset.partId, element.dataset.componentId);
  await persistResolution(message, next, { item, runtime });
}

async function rerollOutcomeDie(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const faces = Math.max(2, Number(element.dataset.faces) || 2);
  const roll = await evaluatedRoll(`1d${faces}`);
  const value = rollParts(roll)[0]?.value;
  if (!value) return;
  const next = rerollRegisteredOutcomePart(state, { poolId: element.dataset.poolId, partId: element.dataset.partValueId, value });
  await persistResolution(message, next, { item, runtime });
}

async function rerollAllOutcomeDice(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const pool = state.poolRegistry.find(entry => entry.poolId === element.dataset.poolId);
  if (!pool) return;
  let next = state;
  for (const die of pool.parts.filter(entry => entry.kind === "die" && !entry.excluded)) {
    const roll = await evaluatedRoll(`1d${Math.max(2, Number(die.faces) || 2)}`);
    const value = rollParts(roll)[0]?.value;
    if (value) next = rerollRegisteredOutcomePart(next, { poolId: pool.poolId, partId: die.partId, value });
  }
  await persistResolution(message, next, { item, runtime });
}

async function toggleOutcomeDie(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const next = setRegisteredOutcomePartExcluded(state, {
    poolId: element.dataset.poolId,
    partId: element.dataset.partValueId,
    excluded: element.dataset.excluded !== "true",
    reason: "manual"
  });
  await persistResolution(message, next, { item, runtime });
}

function finalLabel(type) {
  return type === "healing" ? "Исцеление" : type === "tempHp" ? "Временные HP" : type;
}

function finalMessagesForBatch(batchId) {
  return Array.from(globalThis.game?.messages?.contents ?? globalThis.game?.messages ?? []).filter(message =>
    message?.getFlag?.("fast-nri", "kind") === ABILITY_V2_FINAL_KIND
    && message?.getFlag?.("fast-nri", "abilityV2FinalBatchId") === batchId
  );
}

function finalResultsFromMessage(message) {
  const many = message?.getFlag?.("fast-nri", "abilityV2FinalResults");
  if (Array.isArray(many)) return many.map(normalizeFinalResultPackage);
  const one = message?.getFlag?.("fast-nri", "abilityV2FinalResult");
  return one ? [normalizeFinalResultPackage(one)] : [];
}

function finalFromMessage(message, finalResultId = null) {
  const finals = finalResultsFromMessage(message);
  if (!finalResultId) return finals[0] ?? null;
  return finals.find(result => result.finalResultId === String(finalResultId)) ?? null;
}

export function abilityV2FinalCardHTML(rawFinalResults, { finalResults = [] } = {}) {
  const values = (Array.isArray(rawFinalResults) ? rawFinalResults : [rawFinalResults]).filter(Boolean).map(normalizeFinalResultPackage);
  const allResults = finalResults.length ? finalResults.map(normalizeFinalResultPackage) : values;
  const batchId = values[0]?.batchId ?? "";
  return `<div class="fast-nri-chat-roll fast-nri-v2-final-card fast-nri-ability-v2-final-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-list-check"></i><strong>Итог способности</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Одна Final/Application Card</span><span>${esc(values.length)} индивидуальн. результатов</span></div>
    ${values.map(result => {
      const amount = resolveFinalResultAmount(result, { finalResults: allResults });
      const recipient = result.provenance.recipient;
      return `<section class="fast-nri-qa-stage fast-nri-v2-final-result-row" data-final-result-id="${escAttr(result.finalResultId)}">
        <div class="fast-nri-qa-stage-title"><strong>${esc(result.partLabel || "Результат")}</strong> · ${esc(result.componentLabel || finalLabel(result.componentType))}</div>
        <div>Назначено: <strong>${esc(recipient.name || recipient.actorUuid || recipient.tokenUuid || "не назначено")}</strong></div>
        <div class="fast-nri-qa-final-total">${esc(finalLabel(result.componentType))}: <strong>${esc(amount)}</strong></div>
        <button type="button" data-fast-nri-ability-v2-final-apply-selected data-final-result-id="${escAttr(result.finalResultId)}"><i class="fa-solid fa-crosshairs"></i><span>Применить по выбранному</span></button>
      </section>`;
    }).join("")}
    <div class="fast-nri-damage-actions"><button type="button" data-fast-nri-ability-v2-final-apply-assigned data-batch-id="${escAttr(batchId)}"><i class="fa-solid fa-check-double"></i><span>Применить по назначенным целям</span></button></div>
  </div>`;
}

async function refreshFinalBatch(batchId) {
  const messages = finalMessagesForBatch(batchId);
  for (const message of messages) {
    const finals = finalResultsFromMessage(message);
    const content = abilityV2FinalCardHTML(finals, { finalResults: finals });
    if (message.content !== content) await message.update({ content });
  }
}

async function finalizeResolution(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const batchId = randomId(`ability-final-${state.actionId}`);
  const finalResults = materializeActionFinalResults(state, { batchId });
  if (!finalResults.length) {
    globalThis.ui?.notifications?.warn?.("Пока нечего применять. Выполни нужный бросок результата или назначь получателя.");
    return;
  }
  await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker(),
    content: abilityV2FinalCardHTML(finalResults, { finalResults }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_FINAL_KIND,
        abilityV2ResolutionMessageId: message.id,
        abilityV2FinalBatchId: batchId,
        abilityV2FinalResults: finalResults
      }
    }
  });
  await message.update({ "flags.fast-nri.abilityV2FinalBatchId": batchId });
}

function controlledRecipients() {
  const seen = new Set();
  return currentControlledTokens().filter(token => {
    const key = token?.document?.uuid ?? token?.uuid ?? token?.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hpGainStateFromFinal(finalResult) {
  const result = normalizeFinalResultPackage(finalResult);
  return {
    supported: true,
    parts: result.value.parts.filter(part => !part.excluded).map(part => ({
      id: part.partId,
      kind: part.kind,
      faces: part.faces,
      value: part.value,
      currentValue: part.value,
      traitIds: Array.from(part.metadata?.traitIds ?? []),
      immuneRemoved: false
    })),
    penalties: []
  };
}

async function applyHealthFinalToActor(finalResult, actor, amount) {
  const state = hpGainStateFromFinal(finalResult);
  // Derived/numeric results have no roll parts; use one fixed part so HP-gain
  // resistance/bonus infrastructure still receives the requested amount.
  if (!state.parts.length && amount > 0) state.parts.push({ id: "derived", kind: "fixed", value: amount, currentValue: amount, traitIds: [], immuneRemoved: false });
  const resolution = resolveHpGainAgainstActor(state, actor);
  const resolvedAmount = Math.max(0, Number(resolution.finalAmount) || 0);
  const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
  const maxHp = Math.max(0, Number(actor.system?.hp?.max) || 0);
  const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
  let afterHp = previousHp;
  let afterTemp = previousTemp;
  let appliedAmount = 0;
  if (finalResult.componentType === "healing") {
    afterHp = Math.min(maxHp, previousHp + resolvedAmount);
    appliedAmount = afterHp - previousHp;
    await actor.update({ "system.hp.value": afterHp }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  } else {
    afterTemp = resolveTemporaryHp(previousTemp, resolvedAmount);
    appliedAmount = afterTemp - previousTemp;
    await actor.update({ "system.hp.temp": afterTemp }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  }
  return {
    requestedAmount: amount,
    appliedAmount,
    before: { hp: previousHp, maxHp, tempHp: previousTemp },
    after: { hp: afterHp, maxHp, tempHp: afterTemp },
    resolution
  };
}

function applicationCardHTML(receipt, { provenanceName = null } = {}) {
  const value = normalizeApplicationReceipt(receipt);
  return `<div class="fast-nri-chat-roll fast-nri-ability-v2-application-card"><div class="fast-nri-chat-roll-title"><i class="fa-solid fa-receipt"></i><strong>${esc(value.recipient.name || "Получатель")} · ${esc(finalLabel(value.componentType))}</strong></div><div class="fast-nri-chat-roll-meta"><span>ApplicationReceipt</span><span>Final provenance: ${esc(provenanceName || "—")}</span></div><div class="fast-nri-qa-final-total">Запрошено: <strong>${esc(value.requestedAmount)}</strong> · применено: <strong>${esc(value.appliedAmount)}</strong></div>${value.undone ? `<div class="fast-nri-qa-warning">Отменено.</div>` : `<button type="button" data-fast-nri-ability-v2-application-undo><i class="fa-solid fa-rotate-left"></i><span>Отмена</span></button>`}</div>`;
}

async function createHealthApplicationReceiptMessage(finalResult, token, actor, amount, mode) {
  if (!["healing", "tempHp"].includes(finalResult.componentType)) return null;
  const application = await applyHealthFinalToActor(finalResult, actor, amount);
  const receipt = createApplicationReceipt({
    finalResultId: finalResult.finalResultId,
    batchId: finalResult.batchId,
    componentId: finalResult.componentId,
    componentType: finalResult.componentType,
    recipient: {
      tokenUuid: token?.document?.uuid ?? token?.uuid ?? null,
      actorUuid: actor.uuid,
      name: token?.name ?? actor.name
    },
    requestedAmount: amount,
    appliedAmount: application.appliedAmount,
    before: application.before,
    after: application.after,
    metadata: { resolution: application.resolution, adapterId: "ability-v2-health", applicationMode: mode }
  });
  await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker({ actor, token: token?.document ?? token ?? null }),
    content: applicationCardHTML(receipt, { provenanceName: finalResult.provenance.recipient.name }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_APPLICATION_KIND,
        abilityV2ApplicationReceipt: receipt,
        abilityV2FinalBatchId: finalResult.batchId,
        abilityV2ProvenanceName: finalResult.provenance.recipient.name
      }
    }
  });
  return receipt;
}

async function assignedRecipient(finalResult) {
  const ref = finalResult?.provenance?.recipient ?? {};
  if (ref.tokenUuid) {
    try {
      const tokenDocument = await globalThis.fromUuid?.(ref.tokenUuid);
      if (tokenDocument?.actor) return { token: tokenDocument.object ?? tokenDocument, actor: tokenDocument.actor };
    } catch (_error) { /* fall through */ }
  }
  if (ref.actorUuid) {
    try {
      const actor = await globalThis.fromUuid?.(ref.actorUuid);
      if (actor) return { token: null, actor };
    } catch (_error) { /* fall through */ }
  }
  return null;
}

async function applyFinalSelected(element) {
  const message = messageFromElement(element);
  const finalResult = finalFromMessage(message, element.dataset.finalResultId);
  if (!message || !finalResult) return;
  const recipients = controlledRecipients();
  if (!recipients.length) {
    globalThis.ui?.notifications?.warn?.("Выдели один или несколько токенов для индивидуального Application.");
    return;
  }
  const finals = finalResultsFromMessage(message);
  const amount = resolveFinalResultAmount(finalResult, { finalResults: finals });
  for (const token of recipients) {
    const actor = token?.actor;
    if (!actor) continue;
    await createHealthApplicationReceiptMessage(finalResult, token, actor, amount, "current-controlled");
  }
}

async function applyFinalAssigned(element) {
  const message = messageFromElement(element);
  const finals = finalResultsFromMessage(message);
  if (!message || !finals.length) return;
  for (const finalResult of finals) {
    const recipient = await assignedRecipient(finalResult);
    if (!recipient?.actor) {
      globalThis.ui?.notifications?.warn?.(`Назначенный получатель «${finalResult.provenance.recipient.name || "—"}» недоступен. Остальные результаты продолжают применяться.`);
      continue;
    }
    const amount = resolveFinalResultAmount(finalResult, { finalResults: finals });
    await createHealthApplicationReceiptMessage(finalResult, recipient.token, recipient.actor, amount, "assigned-recipient");
  }
}

async function actorFromReceipt(receipt) {
  if (receipt?.recipient?.tokenUuid) {
    try {
      const tokenDocument = await globalThis.fromUuid?.(receipt.recipient.tokenUuid);
      if (tokenDocument?.actor) return tokenDocument.actor;
    } catch (_error) { /* fall through */ }
  }
  if (receipt?.recipient?.actorUuid) {
    try { return await globalThis.fromUuid?.(receipt.recipient.actorUuid); }
    catch (_error) { /* fall through */ }
  }
  return null;
}

async function undoApplication(element) {
  const message = messageFromElement(element);
  const receipt = normalizeApplicationReceipt(message?.getFlag?.("fast-nri", "abilityV2ApplicationReceipt") ?? {});
  if (!message || receipt.undone) return;
  const actor = await actorFromReceipt(receipt);
  if (!actor) return;
  if (receipt.componentType === "healing") {
    const current = Math.max(0, Number(actor.system?.hp?.value) || 0);
    const after = Math.max(0, current - Math.max(0, Number(receipt.appliedAmount) || 0));
    await actor.update({ "system.hp.value": after }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  } else if (receipt.componentType === "tempHp") {
    const current = Math.max(0, Number(actor.system?.hp?.temp) || 0);
    const expected = Math.max(0, Number(receipt.after?.tempHp) || 0);
    if (current !== expected) {
      globalThis.ui?.notifications?.warn?.("Временные HP уже изменились после этой карточки. Undo не выполнен, чтобы не стереть более новый результат.");
      return;
    }
    await actor.update({ "system.hp.temp": Math.max(0, Number(receipt.before?.tempHp) || 0) }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  }
  const next = normalizeApplicationReceipt({ ...receipt, undone: true });
  await message.update({
    content: applicationCardHTML(next, { provenanceName: message.getFlag?.("fast-nri", "abilityV2ProvenanceName") }),
    "flags.fast-nri.abilityV2ApplicationReceipt": next
  });
}

async function undoResource(element) {
  const message = messageFromElement(element);
  if (!message || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_DECLARATION_KIND) return;
  if (message.getFlag?.("fast-nri", "resourceUndone")) return;
  const actor = await globalThis.fromUuid?.(message.getFlag?.("fast-nri", "actorUuid"));
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!actor || !item || !runtime) return;
  const resource = flagsResource(message);
  if (!(resource.spent > 0)) return;
  const restored = Math.max(0, Number(actor.system?.classResource?.value) || 0) + resource.spent;
  await actor.update({ "system.classResource.value": restored });
  await message.update({ "flags.fast-nri.resourceUndone": true });
  const state = actionStateFromMessage(message);
  await persistDeclaration(message, state, { item, runtime, resource });
}

export function activateAbilityActionV2Interactions(root = document) {
  root.addEventListener("click", async event => {
    const routes = [
      ["[data-fast-nri-ability-v2-add-targets]", element => addSelections(element, currentTargetTokens(), "target")],
      ["[data-fast-nri-ability-v2-add-controlled]", element => addSelections(element, currentControlledTokens(), "controlled")],
      ["[data-fast-nri-ability-v2-remove]", removeSelection],
      ["[data-fast-nri-ability-v2-declare]", resolveDeclaration],
      ["[data-fast-nri-ability-v2-outcome-roll]", rollOutcomeFromResolution],
      ["[data-fast-nri-ability-v2-outcome-reroll]", rerollOutcomeDie],
      ["[data-fast-nri-ability-v2-outcome-reroll-all]", rerollAllOutcomeDice],
      ["[data-fast-nri-ability-v2-outcome-toggle]", toggleOutcomeDie],
      ["[data-fast-nri-ability-v2-finalize]", finalizeResolution],
      ["[data-fast-nri-ability-v2-final-apply-selected]", applyFinalSelected],
      ["[data-fast-nri-ability-v2-final-apply-assigned]", applyFinalAssigned],
      ["[data-fast-nri-ability-v2-application-undo]", undoApplication],
      ["[data-fast-nri-v2-resource-undo]", undoResource]
    ];
    for (const [selector, handler] of routes) {
      const element = event.target.closest(selector);
      if (!element) continue;
      event.preventDefault();
      event.stopPropagation();
      if (element.dataset.fastNriBusy === "true") return;
      element.dataset.fastNriBusy = "true";
      try { await handler(element); }
      catch (error) {
        console.error("Быстрая НРИ | Ability ActionState v2", error);
        globalThis.ui?.notifications?.error?.(`Ошибка Ability v2: ${error.message}`);
      } finally { delete element.dataset.fastNriBusy; }
      return;
    }
  });
}
