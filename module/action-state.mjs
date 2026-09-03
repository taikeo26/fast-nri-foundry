import { normalizeActionContext } from "./action-context.mjs";

/**
 * Fast NRI 0.5.70 — Unified ActionState v2 foundation.
 *
 * This module is deliberately UI-agnostic and Foundry-light. It defines the
 * serializable state contract and pure state transitions for the future
 * Weapon / Ability / Spell / Maneuver / Skill unified pipeline.
 *
 * Legacy workflows are NOT switched to ActionState v2 in 0.5.70. The 0.5.69 QA slice continues through the v1-root compatibility fields until the multi-part UI is proven.
 */

export const ACTION_STATE_SCHEMA_VERSION = 2;
export const ACTION_DEFINITION_SCHEMA_VERSION = 2;
export const ACTION_STATE_FLAG_SCOPE = "fast-nri";
export const ACTION_STATE_FLAG_KEY = "actionState";

export const ACTION_DEGREES = Object.freeze(["failure", "partial", "success", "great"]);
export const ACTION_SOURCE_KINDS = Object.freeze(["weapon", "ability", "spell", "maneuver", "skill"]);
export const ACTION_DECLARATION_ROLL_MODES = Object.freeze(["none", "attack", "check"]);
export const ACTION_OUTCOME_ROLL_MODES = Object.freeze(["none", "shared", "perAffected"]);
export const ACTION_OUTCOME_PROJECTION_STAGES = Object.freeze(["beforeDefense", "afterDefense"]);
export const RESOLUTION_STEP_STATUSES = Object.freeze(["active", "invalidated", "needs-reresolution"]);

// ActionState v2: one application may contain several independently resolved
// parts, several named recipient/target slots, and several outcome components.
// These are data contracts, not rule-name-specific workflows.
export const ACTION_TARGET_SLOT_ROLES = Object.freeze(["resolution", "recipient"]);
export const ACTION_TARGET_SLOT_SELECTION_MODES = Object.freeze(["manual", "source", "fixed"]);
export const ACTION_OUTCOME_COMPONENT_TIMINGS = Object.freeze([
  "beforeDefense",
  "resolution",
  "afterDefense",
  "application"
]);
export const ACTION_OUTCOME_RECIPIENT_TYPES = Object.freeze(["targetSlot", "source", "fixed", "none"]);
export const ACTION_OUTCOME_ALLOCATION_MODES = Object.freeze([
  "none",
  "unitsToTargets",
  "rolledPartsToTargets"
]);
export const ACTION_OUTCOME_DELIVERY_MODES = Object.freeze(["independent", "combineByRecipient"]);
export const ACTION_REGISTERED_ROLL_KINDS = Object.freeze(["declaration", "outcome", "auxiliary"]);

function text(value) {
  return String(value ?? "").trim();
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeDegree(value) {
  return ACTION_DEGREES.includes(value) ? value : null;
}

function uniqueTextList(value = []) {
  const result = [];
  const seen = new Set();
  for (const entry of Array.from(value ?? [])) {
    const normalized = text(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function jsonClone(value, fallback = null) {
  if (value === undefined) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return fallback;
  }
}

function randomId(prefix = "id") {
  try {
    const id = globalThis.foundry?.utils?.randomID?.();
    if (id) return `${prefix}-${id}`;
  } catch (_error) {
    // Tests and tooling intentionally use the dependency-free fallback.
  }

  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return `${prefix}-${id}`;
  } catch (_error) {
    // Ignore and use the fallback below.
  }

  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function normalizeRevision(value = {}) {
  return {
    state: Math.max(0, integerOr(value?.state, 0)),
    roster: Math.max(0, integerOr(value?.roster, 0)),
    declaration: Math.max(0, integerOr(value?.declaration, 0)),
    degrees: Math.max(0, integerOr(value?.degrees, 0)),
    outcome: Math.max(0, integerOr(value?.outcome, 0)),
    resolution: Math.max(0, integerOr(value?.resolution, 0)),
    finalization: Math.max(0, integerOr(value?.finalization, 0))
  };
}

function bump(state, keys = []) {
  state.revisions = normalizeRevision(state.revisions);
  state.revisions.state += 1;
  for (const key of keys) {
    if (Object.hasOwn(state.revisions, key)) state.revisions[key] += 1;
  }
}

function staleFinalization(state) {
  const previous = state.finalization ?? {};
  state.finalization = {
    status: Array.isArray(previous.results) && previous.results.length ? "stale" : "empty",
    basedOnResolutionRevision: previous.basedOnResolutionRevision ?? null,
    results: Array.from(previous.results ?? []).map(normalizeFinalTargetResult)
  };
}

function staleDegrees(state) {
  const status = state.degreeResolution?.status;
  state.degreeResolution = {
    status: status === "empty" || !status ? "empty" : "stale",
    basedOnDeclarationRevision: state.degreeResolution?.basedOnDeclarationRevision ?? null,
    basedOnRosterRevision: state.degreeResolution?.basedOnRosterRevision ?? null,
    resolvedCount: Math.max(0, integerOr(state.degreeResolution?.resolvedCount, 0)),
    errorCount: Math.max(0, integerOr(state.degreeResolution?.errorCount, 0))
  };
}

function invalidateDownstreamFromDegrees(state) {
  state.outcome = {
    ...normalizeOutcomeState(state.outcome),
    status: state.outcome?.status === "resolved" ? "stale" : normalizeOutcomeState(state.outcome).status
  };
  for (const affected of state.affected ?? []) {
    affected.targetResult = affected.targetResult
      ? { ...normalizeTargetResult(affected.targetResult), stale: true }
      : null;
  }
  staleFinalization(state);
}

function normalizeTargetSlotSelection(value = {}, index = 0) {
  const ref = affectedRef(value) ?? {
    tokenUuid: text(value?.tokenUuid) || null,
    actorUuid: text(value?.actorUuid) || null,
    name: text(value?.name) || null
  };

  return {
    selectionId: text(value?.selectionId) || randomId(`selection-${index}`),
    tokenUuid: ref.tokenUuid,
    actorUuid: ref.actorUuid,
    name: ref.name,
    addedFrom: ["target", "controlled", "manual", "system", "source", "fixed"].includes(value?.addedFrom)
      ? value.addedFrom
      : "manual",
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function targetSlotSelectionIdentity(value = {}) {
  return text(value?.tokenUuid) || text(value?.actorUuid) || text(value?.selectionId);
}

export function normalizeTargetSlot(value = {}, index = 0) {
  const roles = uniqueTextList(value?.roles ?? ["resolution", "recipient"])
    .filter(role => ACTION_TARGET_SLOT_ROLES.includes(role));
  const selectionMode = enumValue(value?.selectionMode, ACTION_TARGET_SLOT_SELECTION_MODES, "manual");
  const min = Math.max(0, integerOr(value?.min, 0));
  const rawMax = value?.max === null || value?.max === undefined || value?.max === ""
    ? null
    : Math.max(0, integerOr(value.max, min));
  const max = rawMax === null ? null : Math.max(min, rawMax);
  const selections = [];
  const seen = new Set();

  for (const raw of Array.from(value?.selections ?? [])) {
    const selection = normalizeTargetSlotSelection(raw, selections.length);
    const key = targetSlotSelectionIdentity(selection);
    if (!selection.actorUuid && !selection.tokenUuid) continue;
    if (!Boolean(value?.allowDuplicates) && key && seen.has(key)) continue;
    if (key) seen.add(key);
    selections.push(selection);
  }

  return {
    slotId: text(value?.slotId ?? value?.id) || `slot-${index}`,
    label: text(value?.label) || `Цель ${index + 1}`,
    roles: roles.length ? roles : ["recipient"],
    selectionMode,
    min,
    max,
    allowDuplicates: Boolean(value?.allowDuplicates),
    selections,
    fixedRef: selectionMode === "fixed" ? affectedRef(value?.fixedRef ?? {}) : null,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeOutcomeDependency(value = {}) {
  return {
    componentId: text(value?.componentId) || null,
    condition: text(value?.condition) || "component-resolved",
    params: jsonClone(value?.params ?? {}, {})
  };
}

function normalizeOutcomeRecipient(value = {}) {
  const type = enumValue(value?.type, ACTION_OUTCOME_RECIPIENT_TYPES, "none");
  return {
    type,
    targetSlotId: type === "targetSlot" ? (text(value?.targetSlotId) || null) : null,
    fixedRef: type === "fixed" ? affectedRef(value?.fixedRef ?? value?.ref ?? {}) : null
  };
}

function normalizeOutcomeValueSource(value = {}) {
  return {
    type: text(value?.type) || "none",
    componentId: text(value?.componentId) || null,
    rollId: text(value?.rollId) || null,
    poolId: text(value?.poolId) || null,
    partId: text(value?.partId) || null,
    value: finiteNumberOrNull(value?.value),
    table: jsonClone(value?.table ?? null, null),
    params: jsonClone(value?.params ?? {}, {})
  };
}

function normalizeOutcomeDegreeSource(value = {}) {
  return {
    type: text(value?.type) || "none",
    targetSlotId: text(value?.targetSlotId) || null,
    resolverId: text(value?.resolverId) || null,
    params: jsonClone(value?.params ?? {}, {})
  };
}

function normalizeOutcomeDelivery(value = {}) {
  return {
    mode: enumValue(value?.mode, ACTION_OUTCOME_DELIVERY_MODES, "independent"),
    key: text(value?.key) || null
  };
}

export function normalizeOutcomeComponent(value = {}, index = 0) {
  return {
    componentId: text(value?.componentId ?? value?.id) || `component-${index}`,
    type: text(value?.type ?? value?.kind) || "manual",
    label: text(value?.label) || null,
    recipient: normalizeOutcomeRecipient(value?.recipient ?? {}),
    timing: enumValue(value?.timing, ACTION_OUTCOME_COMPONENT_TIMINGS, "resolution"),
    degreeSource: normalizeOutcomeDegreeSource(value?.degreeSource ?? {}),
    valueSource: normalizeOutcomeValueSource(value?.valueSource ?? {}),
    dependsOn: Array.from(value?.dependsOn ?? []).map(normalizeOutcomeDependency),
    poolRefs: uniqueTextList(value?.poolRefs ?? []),
    delivery: normalizeOutcomeDelivery(value?.delivery ?? {}),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizePartTargetResult(value = {}, index = 0) {
  return {
    resultId: text(value?.resultId) || `part-result-${index}`,
    targetSlotId: text(value?.targetSlotId) || null,
    selectionId: text(value?.selectionId) || null,
    tokenUuid: text(value?.tokenUuid) || null,
    actorUuid: text(value?.actorUuid) || null,
    name: text(value?.name) || null,
    degreeState: normalizeDegreeState(value?.degreeState ?? {}),
    targetResult: value?.targetResult ? normalizeTargetResult(value.targetResult) : null,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeActionPart(value = {}, index = 0) {
  const targetSlots = [];
  const slotIds = new Set();
  for (const raw of Array.from(value?.targetSlots ?? [])) {
    const slot = normalizeTargetSlot(raw, targetSlots.length);
    if (slotIds.has(slot.slotId)) continue;
    slotIds.add(slot.slotId);
    targetSlots.push(slot);
  }

  const outcomeComponents = [];
  const componentIds = new Set();
  for (const raw of Array.from(value?.outcomeComponents ?? value?.components ?? [])) {
    const component = normalizeOutcomeComponent(raw, outcomeComponents.length);
    if (componentIds.has(component.componentId)) continue;
    componentIds.add(component.componentId);
    outcomeComponents.push(component);
  }

  const declaration = value?.declaration ?? {};
  return {
    partId: text(value?.partId ?? value?.id) || `part-${index}`,
    templateId: text(value?.templateId) || text(value?.partId ?? value?.id) || `part-${index}`,
    label: text(value?.label) || `Часть ${index + 1}`,
    order: Math.max(0, integerOr(value?.order, index)),
    repeatIndex: Math.max(1, integerOr(value?.repeatIndex, 1)),
    targetSlots,
    declaration: {
      rollMode: enumValue(declaration?.rollMode, ACTION_DECLARATION_ROLL_MODES, "none"),
      formula: text(declaration?.formula) || null,
      label: text(declaration?.label) || null,
      degreeResolverId: text(declaration?.degreeResolverId) || null,
      targetCharacteristic: text(declaration?.targetCharacteristic) || null,
      rollRefs: uniqueTextList(declaration?.rollRefs ?? [])
    },
    outcomeComponents,
    defenseProcedureIds: uniqueTextList(value?.defenseProcedureIds ?? []),
    targetResults: Array.from(value?.targetResults ?? []).map(normalizePartTargetResult),
    revision: Math.max(0, integerOr(value?.revision, 0)),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeActionPartTemplate(value = {}, index = 0) {
  const part = normalizeActionPart(value, index);
  return {
    ...part,
    repeat: {
      count: Math.max(1, integerOr(value?.repeat?.count ?? value?.repeat, 1))
    },
    targetSlots: part.targetSlots.map(slot => ({ ...slot, selections: [] })),
    targetResults: []
  };
}

export function expandActionPartTemplates(templates = []) {
  const result = [];
  for (const [templateIndex, raw] of Array.from(templates ?? []).entries()) {
    const template = normalizeActionPartTemplate(raw, templateIndex);
    const count = template.repeat.count;
    for (let repeatIndex = 1; repeatIndex <= count; repeatIndex += 1) {
      const suffix = count > 1 ? `-${repeatIndex}` : "";
      const label = count > 1 ? `${template.label} ${repeatIndex}` : template.label;
      result.push(normalizeActionPart({
        ...template,
        partId: `${template.partId}${suffix}`,
        templateId: template.templateId || template.partId,
        label,
        order: result.length,
        repeatIndex,
        repeat: undefined
      }, result.length));
    }
  }
  return result;
}

function sourceSelectionFromContext(actionContext = {}) {
  const context = normalizeActionContext(actionContext);
  const tokenUuid = text(context?.initiator?.tokenUuid);
  const actorUuid = text(context?.initiator?.actorUuid ?? context?.source?.actorUuid);
  if (!tokenUuid && !actorUuid) return null;
  return normalizeTargetSlotSelection({
    selectionId: "source",
    tokenUuid: tokenUuid || null,
    actorUuid: actorUuid || null,
    name: null,
    addedFrom: "source"
  });
}

function bindAutomaticTargetSlots(parts = [], actionContext = {}) {
  const sourceSelection = sourceSelectionFromContext(actionContext);
  return Array.from(parts ?? []).map(rawPart => {
    const part = normalizeActionPart(rawPart);
    part.targetSlots = part.targetSlots.map(slot => {
      if (slot.selectionMode === "source") {
        return { ...slot, selections: sourceSelection ? [sourceSelection] : [] };
      }
      if (slot.selectionMode === "fixed") {
        const fixed = slot.fixedRef ? normalizeTargetSlotSelection({ ...slot.fixedRef, selectionId: "fixed", addedFrom: "fixed" }) : null;
        return { ...slot, selections: fixed ? [fixed] : [] };
      }
      return slot;
    });
    return part;
  });
}

export function normalizeRegisteredRoll(value = {}, index = 0) {
  return {
    rollId: text(value?.rollId ?? value?.id) || `roll-${index}`,
    partId: text(value?.partId) || null,
    kind: enumValue(value?.kind, ACTION_REGISTERED_ROLL_KINDS, "auxiliary"),
    label: text(value?.label) || null,
    roll: normalizeRollState(value?.roll ?? value),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeOutcomeUnit(value = {}, index = 0) {
  return {
    unitId: text(value?.unitId ?? value?.id) || `unit-${index}`,
    label: text(value?.label) || null,
    parts: Array.from(value?.parts ?? []).map(normalizeOutcomePart),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeAllocationAssignment(value = {}, index = 0) {
  return {
    assignmentId: text(value?.assignmentId) || `assignment-${index}`,
    unitId: text(value?.unitId ?? value?.partId) || null,
    targetSlotId: text(value?.targetSlotId) || null,
    selectionId: text(value?.selectionId) || null,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeOutcomeAllocation(value = {}) {
  return {
    mode: enumValue(value?.mode, ACTION_OUTCOME_ALLOCATION_MODES, "none"),
    assignments: Array.from(value?.assignments ?? []).map(normalizeAllocationAssignment)
  };
}

export function normalizeRegisteredPool(value = {}, index = 0) {
  return {
    poolId: text(value?.poolId ?? value?.id) || `registered-pool-${index}`,
    partId: text(value?.partId) || null,
    componentId: text(value?.componentId) || null,
    formula: text(value?.formula) || null,
    parts: Array.from(value?.parts ?? []).map(normalizeOutcomePart),
    units: Array.from(value?.units ?? []).map(normalizeOutcomeUnit),
    allocation: normalizeOutcomeAllocation(value?.allocation ?? {}),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeActionDefinitionSnapshot(value = {}) {
  const declaration = value?.declaration ?? {};
  const outcome = value?.outcome ?? {};
  const sourceKind = enumValue(value?.sourceKind, ACTION_SOURCE_KINDS, "ability");

  return {
    schemaVersion: ACTION_DEFINITION_SCHEMA_VERSION,
    sourceKind,
    sourceRef: {
      actorUuid: text(value?.sourceRef?.actorUuid) || null,
      itemUuid: text(value?.sourceRef?.itemUuid) || null,
      name: text(value?.sourceRef?.name) || null,
      implementationId: text(value?.sourceRef?.implementationId) || null
    },
    traits: uniqueTextList(value?.traits ?? []),
    declaration: {
      rollMode: enumValue(declaration?.rollMode, ACTION_DECLARATION_ROLL_MODES, "none"),
      formula: text(declaration?.formula) || null,
      label: text(declaration?.label) || null,
      degreeResolverId: text(declaration?.degreeResolverId) || null,
      targetCharacteristic: text(declaration?.targetCharacteristic) || null
    },
    outcome: {
      resolverId: text(outcome?.resolverId) || null,
      rollMode: enumValue(outcome?.rollMode, ACTION_OUTCOME_ROLL_MODES, "none"),
      projectionStage: enumValue(
        outcome?.projectionStage,
        ACTION_OUTCOME_PROJECTION_STAGES,
        "beforeDefense"
      ),
      buttonLabel: text(outcome?.buttonLabel) || null,
      componentKinds: uniqueTextList(outcome?.componentKinds ?? [])
    },
    defenseProcedureIds: uniqueTextList(value?.defenseProcedureIds ?? []),
    parts: Array.from(value?.parts ?? value?.partTemplates ?? []).map(normalizeActionPartTemplate),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeRollState(value = {}) {
  const total = finiteNumberOrNull(value?.total);
  const naturalD20 = finiteNumberOrNull(value?.naturalD20);
  const formula = text(value?.formula) || null;
  const explicitStatus = text(value?.status);
  let status = ["empty", "rolled", "error"].includes(explicitStatus)
    ? explicitStatus
    : total !== null
      ? "rolled"
      : "empty";

  if (status === "rolled" && total === null) status = "error";

  return {
    status,
    formula,
    total,
    naturalD20,
    data: jsonClone(value?.data ?? value?.rollData ?? null, null),
    error: status === "error" ? (text(value?.error) || "invalid-roll") : null
  };
}

function normalizeDegreeState(value = {}) {
  const status = ["empty", "resolved", "error", "stale"].includes(value?.status)
    ? value.status
    : normalizeDegree(value?.baseDegree)
      ? "resolved"
      : "empty";
  const baseDegree = normalizeDegree(value?.baseDegree ?? value?.degree);

  const calculatedDegree = normalizeDegree(value?.calculatedDegree ?? value?.baseDegree ?? value?.degree);
  const manualAdjusted = Boolean(value?.manualAdjusted) && Boolean(baseDegree);

  return {
    status: status === "resolved" && !baseDegree ? "error" : status,
    resolverId: text(value?.resolverId) || null,
    baseDegree,
    calculatedDegree,
    manualAdjusted,
    input: jsonClone(value?.input ?? null, null),
    declarationTotal: finiteNumberOrNull(value?.declarationTotal),
    naturalD20: finiteNumberOrNull(value?.naturalD20),
    basedOnDeclarationRevision: finiteNumberOrNull(value?.basedOnDeclarationRevision),
    basedOnRosterRevision: finiteNumberOrNull(value?.basedOnRosterRevision),
    error: text(value?.error) || null
  };
}

function affectedRef(value = {}) {
  const token = value?.document?.documentName === "Token"
    ? value.document
    : value?.documentName === "Token"
      ? value
      : value?.document ?? null;
  const actor = value?.actor ?? token?.actor ?? null;

  const tokenUuid = text(value?.tokenUuid ?? token?.uuid);
  const actorUuid = text(value?.actorUuid ?? actor?.uuid);
  if (!tokenUuid && !actorUuid) return null;

  return {
    tokenUuid: tokenUuid || null,
    actorUuid: actorUuid || null,
    name: text(value?.name ?? token?.name ?? actor?.name) || null
  };
}

function affectedIdentity(value = {}) {
  return text(value?.tokenUuid) || text(value?.actorUuid) || text(value?.affectedId);
}

export function normalizeAffectedEntry(value = {}) {
  const ref = affectedRef(value) ?? {
    tokenUuid: text(value?.tokenUuid) || null,
    actorUuid: text(value?.actorUuid) || null,
    name: text(value?.name) || null
  };

  return {
    affectedId: text(value?.affectedId) || randomId("affected"),
    tokenUuid: ref.tokenUuid,
    actorUuid: ref.actorUuid,
    name: ref.name,
    addedFrom: ["target", "controlled", "manual", "system"].includes(value?.addedFrom)
      ? value.addedFrom
      : "manual",
    degreeState: normalizeDegreeState(value?.degreeState ?? {}),
    targetResult: value?.targetResult ? normalizeTargetResult(value.targetResult) : null
  };
}

export function normalizeOutcomePart(value = {}, index = 0) {
  const kind = value?.kind === "fixed" ? "fixed" : "die";
  const rolled = finiteNumberOrNull(value?.value ?? value?.rolledValue ?? value?.currentValue);
  return {
    partId: text(value?.partId ?? value?.id) || `part-${index}`,
    kind,
    faces: kind === "die" ? finiteNumberOrNull(value?.faces) : null,
    value: rolled ?? 0,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeOutcomePool(value = {}, index = 0) {
  const scope = value?.scope === "affected" ? "affected" : "shared";
  return {
    poolId: text(value?.poolId) || `pool-${index}`,
    scope,
    affectedId: scope === "affected" ? (text(value?.affectedId) || null) : null,
    formula: text(value?.formula) || null,
    parts: Array.from(value?.parts ?? []).map(normalizeOutcomePart),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeOutcomeState(value = {}) {
  const pools = Array.from(value?.pools ?? []).map(normalizeOutcomePool);
  const status = ["empty", "resolved", "stale", "error"].includes(value?.status)
    ? value.status
    : pools.length
      ? "resolved"
      : "empty";

  return {
    status,
    resolverId: text(value?.resolverId) || null,
    rollMode: enumValue(value?.rollMode, ACTION_OUTCOME_ROLL_MODES, "none"),
    projectionStage: enumValue(
      value?.projectionStage,
      ACTION_OUTCOME_PROJECTION_STAGES,
      "beforeDefense"
    ),
    pools,
    components: jsonClone(value?.components ?? [], []),
    error: text(value?.error) || null
  };
}

function normalizeResultPart(value = {}, index = 0) {
  const kind = value?.kind === "fixed" ? "fixed" : "die";
  const numeric = finiteNumberOrNull(value?.value ?? value?.currentValue);
  return {
    partId: text(value?.partId ?? value?.id) || `view-part-${index}`,
    sourcePartId: text(value?.sourcePartId) || null,
    kind,
    faces: kind === "die" ? finiteNumberOrNull(value?.faces) : null,
    value: numeric ?? 0,
    excluded: Boolean(value?.excluded),
    exclusionReason: Boolean(value?.excluded) ? (text(value?.exclusionReason) || "resolution") : null,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeOutcomeView(value = {}, index = 0) {
  return {
    viewId: text(value?.viewId) || `view-${index}`,
    sourcePoolId: text(value?.sourcePoolId) || null,
    parts: Array.from(value?.parts ?? []).map(normalizeResultPart),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeResultSnapshot(value = {}) {
  return {
    degree: normalizeDegree(value?.degree),
    effectDegree: normalizeDegree(value?.effectDegree),
    outcomeViews: Array.from(value?.outcomeViews ?? []).map(normalizeOutcomeView),
    components: jsonClone(value?.components ?? [], []),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeResolutionOperation(value = {}) {
  return {
    resolverId: text(value?.resolverId) || "noop",
    params: jsonClone(value?.params ?? {}, {})
  };
}

export function normalizeResolutionStep(value = {}) {
  const status = enumValue(value?.status, RESOLUTION_STEP_STATUSES, "active");
  return {
    stepId: text(value?.stepId) || randomId("step"),
    type: text(value?.type) || "defense",
    actor: {
      actorUuid: text(value?.actor?.actorUuid ?? value?.actorUuid) || null,
      tokenUuid: text(value?.actor?.tokenUuid ?? value?.tokenUuid) || null,
      name: text(value?.actor?.name ?? value?.actorName) || null
    },
    affectedId: text(value?.affectedId) || null,
    actionRef: {
      itemUuid: text(value?.actionRef?.itemUuid ?? value?.itemUuid) || null,
      name: text(value?.actionRef?.name ?? value?.actionName) || null,
      procedureId: text(value?.actionRef?.procedureId ?? value?.procedureId) || null
    },
    actionContext: value?.actionContext ? normalizeActionContext(value.actionContext) : null,
    roll: normalizeRollState(value?.roll ?? value),
    operation: normalizeResolutionOperation(value?.operation ?? {}),
    dependencyIds: uniqueTextList(value?.dependencyIds ?? []),
    status,
    wasRerolled: Boolean(value?.wasRerolled)
  };
}

export function normalizeTargetResult(value = {}) {
  const base = normalizeResultSnapshot(value?.base ?? {});
  const current = value?.current
    ? normalizeResultSnapshot(value.current)
    : normalizeResultSnapshot(base);

  return {
    affectedId: text(value?.affectedId) || null,
    base,
    steps: Array.from(value?.steps ?? []).map(normalizeResolutionStep),
    current,
    revision: Math.max(0, integerOr(value?.revision, 0)),
    stale: Boolean(value?.stale),
    error: text(value?.error) || null
  };
}

export function normalizeFinalTargetResult(value = {}) {
  return {
    finalResultId: text(value?.finalResultId) || randomId("final"),
    affectedId: text(value?.affectedId) || null,
    actionId: text(value?.actionId) || null,
    provenance: {
      tokenUuid: text(value?.provenance?.tokenUuid) || null,
      actorUuid: text(value?.provenance?.actorUuid) || null,
      name: text(value?.provenance?.name) || null
    },
    result: normalizeResultSnapshot(value?.result ?? {}),
    basedOnResolutionRevision: Math.max(0, integerOr(value?.basedOnResolutionRevision, 0)),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeDegreeResolution(value = {}) {
  return {
    status: ["empty", "resolved", "resolved-with-errors", "stale"].includes(value?.status)
      ? value.status
      : "empty",
    basedOnDeclarationRevision: finiteNumberOrNull(value?.basedOnDeclarationRevision),
    basedOnRosterRevision: finiteNumberOrNull(value?.basedOnRosterRevision),
    resolvedCount: Math.max(0, integerOr(value?.resolvedCount, 0)),
    errorCount: Math.max(0, integerOr(value?.errorCount, 0))
  };
}

function normalizeFinalization(value = {}) {
  const results = Array.from(value?.results ?? []).map(normalizeFinalTargetResult);
  return {
    status: ["empty", "resolved", "stale"].includes(value?.status)
      ? value.status
      : results.length
        ? "resolved"
        : "empty",
    basedOnResolutionRevision: finiteNumberOrNull(value?.basedOnResolutionRevision),
    results
  };
}

export function normalizeActionState(value = {}) {
  const actionContext = normalizeActionContext(value?.actionContext ?? {});
  const definition = normalizeActionDefinitionSnapshot(value?.definition ?? value?.actionDefinition ?? {});
  const affected = [];
  const seen = new Set();

  for (const rawEntry of Array.from(value?.affected ?? [])) {
    const entry = normalizeAffectedEntry(rawEntry);
    const key = affectedIdentity(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    affected.push(entry);
  }

  return {
    schemaVersion: ACTION_STATE_SCHEMA_VERSION,
    actionId: text(value?.actionId) || actionContext.actionId || randomId("action"),
    rootMessageId: text(value?.rootMessageId ?? actionContext.rootMessageId) || null,
    actionContext,
    definition,
    parts: Array.from(value?.parts ?? []).map(normalizeActionPart),
    rollRegistry: Array.from(value?.rollRegistry ?? []).map(normalizeRegisteredRoll),
    poolRegistry: Array.from(value?.poolRegistry ?? []).map(normalizeRegisteredPool),
    // v1-root compatibility fields remain until the 0.5.69 QA UI is replaced.
    declarationRoll: normalizeRollState(value?.declarationRoll ?? {}),
    affected,
    degreeResolution: normalizeDegreeResolution(value?.degreeResolution ?? {}),
    outcome: normalizeOutcomeState(value?.outcome ?? {}),
    finalization: normalizeFinalization(value?.finalization ?? {}),
    revisions: normalizeRevision(value?.revisions ?? {}),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function createActionState({
  actionContext = {},
  definition = {},
  rootMessageId = null,
  metadata = {}
} = {}) {
  const context = normalizeActionContext(actionContext);
  const definitionSnapshot = normalizeActionDefinitionSnapshot(definition);
  const parts = bindAutomaticTargetSlots(expandActionPartTemplates(definitionSnapshot.parts), context);
  return normalizeActionState({
    actionId: context.actionId,
    rootMessageId,
    actionContext: context,
    definition: definitionSnapshot,
    parts,
    rollRegistry: [],
    poolRegistry: [],
    declarationRoll: { status: "empty" },
    affected: [],
    degreeResolution: { status: "empty" },
    outcome: {
      status: "empty",
      resolverId: definition?.outcome?.resolverId,
      rollMode: definition?.outcome?.rollMode,
      projectionStage: definition?.outcome?.projectionStage
    },
    finalization: { status: "empty", results: [] },
    revisions: {},
    metadata
  });
}

function requireActionPart(state, partId) {
  const part = state.parts.find(entry => entry.partId === text(partId));
  if (!part) throw new Error(`unknown-action-part:${text(partId) || "missing"}`);
  return part;
}

function requireTargetSlot(part, slotId) {
  const slot = part.targetSlots.find(entry => entry.slotId === text(slotId));
  if (!slot) throw new Error(`unknown-target-slot:${part.partId}:${text(slotId) || "missing"}`);
  return slot;
}

export function addTargetSlotSelections(
  actionState,
  partId,
  slotId,
  entries,
  { addedFrom = "manual" } = {}
) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const slot = requireTargetSlot(part, slotId);
  const source = Array.isArray(entries) ? entries : [entries];
  const existing = new Set(slot.selections.map(targetSlotSelectionIdentity).filter(Boolean));
  let changed = false;

  for (const raw of source) {
    const ref = affectedRef(raw);
    if (!ref) continue;
    const identity = targetSlotSelectionIdentity(ref);
    if (!slot.allowDuplicates && identity && existing.has(identity)) continue;
    const selection = normalizeTargetSlotSelection({ ...ref, addedFrom });
    slot.selections.push(selection);
    if (identity) existing.add(identity);
    changed = true;
  }

  if (changed) {
    part.revision += 1;
    bump(next, ["roster"]);
    staleFinalization(next);
  }
  return normalizeActionState(next);
}

export function removeTargetSlotSelection(actionState, partId, slotId, selectionIdOrRef) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const slot = requireTargetSlot(part, slotId);
  const key = typeof selectionIdOrRef === "string"
    ? text(selectionIdOrRef)
    : targetSlotSelectionIdentity(selectionIdOrRef ?? {});
  const before = slot.selections.length;
  slot.selections = slot.selections.filter(selection => {
    if (selection.selectionId === key) return false;
    if (selection.tokenUuid && selection.tokenUuid === key) return false;
    if (selection.actorUuid && selection.actorUuid === key) return false;
    return true;
  });
  if (slot.selections.length !== before) {
    // A TargetSlot selection is the identity anchor for its per-target result
    // and for allocation assignments. Removing the selection must not leave
    // hidden resolution/application state behind.
    part.targetResults = part.targetResults.filter(result => !(
      result.targetSlotId === slot.slotId && (
        result.selectionId === key
        || result.tokenUuid === key
        || result.actorUuid === key
      )
    ));
    for (const pool of next.poolRegistry) {
      if (pool.partId !== part.partId) continue;
      pool.allocation.assignments = pool.allocation.assignments.filter(assignment => !(
        assignment.targetSlotId === slot.slotId && assignment.selectionId === key
      ));
    }
    part.revision += 1;
    bump(next, ["roster", "resolution"]);
    staleFinalization(next);
  }
  return normalizeActionState(next);
}

export function registerActionRoll(actionState, rollEntry, { attach = true } = {}) {
  const next = normalizeActionState(actionState);
  const entry = normalizeRegisteredRoll(rollEntry, next.rollRegistry.length);
  if (!entry.rollId) throw new Error("registered-roll-id-required");
  if (entry.partId) requireActionPart(next, entry.partId);

  const index = next.rollRegistry.findIndex(existing => existing.rollId === entry.rollId);
  if (index >= 0) next.rollRegistry[index] = entry;
  else next.rollRegistry.push(entry);

  if (attach && entry.kind === "declaration" && entry.partId) {
    const part = requireActionPart(next, entry.partId);
    part.declaration.rollRefs = uniqueTextList([...part.declaration.rollRefs, entry.rollId]);
    part.revision += 1;
    bump(next, ["declaration"]);
  } else {
    bump(next, entry.kind === "outcome" ? ["outcome"] : []);
  }
  staleFinalization(next);
  return normalizeActionState(next);
}

export function registerOutcomePool(actionState, poolEntry, { attach = true } = {}) {
  const next = normalizeActionState(actionState);
  const entry = normalizeRegisteredPool(poolEntry, next.poolRegistry.length);
  if (entry.partId) requireActionPart(next, entry.partId);

  const index = next.poolRegistry.findIndex(existing => existing.poolId === entry.poolId);
  if (index >= 0) next.poolRegistry[index] = entry;
  else next.poolRegistry.push(entry);

  if (attach && entry.partId && entry.componentId) {
    const part = requireActionPart(next, entry.partId);
    const component = part.outcomeComponents.find(item => item.componentId === entry.componentId);
    if (!component) throw new Error(`unknown-outcome-component:${entry.partId}:${entry.componentId}`);
    component.poolRefs = uniqueTextList([...component.poolRefs, entry.poolId]);
    part.revision += 1;
  }

  bump(next, ["outcome"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function assignOutcomeUnitToTarget(actionState, {
  poolId,
  unitId,
  targetSlotId,
  selectionId
} = {}) {
  const next = normalizeActionState(actionState);
  const pool = next.poolRegistry.find(entry => entry.poolId === text(poolId));
  if (!pool) throw new Error(`unknown-outcome-pool:${text(poolId) || "missing"}`);
  const part = requireActionPart(next, pool.partId);
  const slot = requireTargetSlot(part, targetSlotId);
  const selection = slot.selections.find(entry => entry.selectionId === text(selectionId));
  if (!selection) throw new Error(`unknown-target-selection:${part.partId}:${slot.slotId}:${text(selectionId) || "missing"}`);
  const normalizedUnitId = text(unitId);
  if (!normalizedUnitId) throw new Error("allocation-unit-id-required");
  if (pool.allocation.mode === "rolledPartsToTargets" && !pool.parts.some(entry => entry.partId === normalizedUnitId)) {
    throw new Error(`unknown-allocation-part:${pool.poolId}:${normalizedUnitId}`);
  }
  if (pool.allocation.mode === "unitsToTargets" && !pool.units.some(entry => entry.unitId === normalizedUnitId)) {
    throw new Error(`unknown-allocation-unit:${pool.poolId}:${normalizedUnitId}`);
  }
  if (pool.allocation.mode === "none") {
    throw new Error(`outcome-pool-not-allocatable:${pool.poolId}`);
  }

  // One concrete rolled part/charge can be assigned to only one recipient at a time.
  pool.allocation.assignments = pool.allocation.assignments
    .filter(assignment => assignment.unitId !== normalizedUnitId);
  pool.allocation.assignments.push(normalizeAllocationAssignment({
    unitId: normalizedUnitId,
    targetSlotId: slot.slotId,
    selectionId: selection.selectionId
  }, pool.allocation.assignments.length));
  bump(next, ["outcome"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function upsertPartTargetResult(actionState, partId, value = {}) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const normalized = normalizePartTargetResult(value, part.targetResults.length);
  if (!normalized.targetSlotId || !normalized.selectionId) {
    throw new Error("part-target-result-needs-slot-and-selection");
  }
  requireTargetSlot(part, normalized.targetSlotId);
  const key = `${normalized.targetSlotId}:${normalized.selectionId}`;
  const index = part.targetResults.findIndex(result => `${result.targetSlotId}:${result.selectionId}` === key);
  if (index >= 0) part.targetResults[index] = normalized;
  else part.targetResults.push(normalized);
  part.revision += 1;
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}


/** Resolve one concrete resolution TargetSlot selection from the declaration
 * roll already registered on its ActionPart. The resolver is pure and MUST NOT
 * roll dice. This is the v2 equivalent of resolveAffectedDegree(). */
export function resolvePartTargetSelectionDegree(
  actionState,
  partId,
  slotId,
  selectionId,
  resolver
) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const slot = requireTargetSlot(part, slotId);
  if (!slot.roles.includes("resolution")) return next;
  const selection = slot.selections.find(entry => entry.selectionId === text(selectionId));
  if (!selection) throw new Error(`unknown-target-selection:${part.partId}:${slot.slotId}:${text(selectionId) || "missing"}`);

  const rollEntry = part.declaration.rollRefs
    .map(rollId => next.rollRegistry.find(entry => entry.rollId === rollId))
    .find(Boolean) ?? null;
  const declarationRoll = rollEntry?.roll ?? normalizeRollState({ status: "empty", formula: part.declaration.formula });
  let resolved;
  try {
    resolved = typeof resolver === "function"
      ? resolver({
          part: jsonClone(part, {}),
          targetSlot: jsonClone(slot, {}),
          selection: jsonClone(selection, {}),
          declarationRoll: jsonClone(declarationRoll, {}),
          definition: jsonClone(next.definition, {}),
          actionContext: jsonClone(next.actionContext, {}),
          actionState: jsonClone(next, {})
        })
      : { error: "missing-degree-resolver" };
  } catch (error) {
    resolved = { error: error?.message || "degree-resolver-threw" };
  }

  const degree = normalizeDegree(resolved?.degree ?? resolved?.baseDegree);
  const key = `${slot.slotId}:${selection.selectionId}`;
  const resultIndex = part.targetResults.findIndex(result => `${result.targetSlotId}:${result.selectionId}` === key);
  const previous = resultIndex >= 0 ? part.targetResults[resultIndex] : null;
  const resultId = previous?.resultId || randomId(`part-result-${part.partId}`);

  let partResult;
  if (!degree) {
    partResult = normalizePartTargetResult({
      resultId,
      targetSlotId: slot.slotId,
      selectionId: selection.selectionId,
      tokenUuid: selection.tokenUuid,
      actorUuid: selection.actorUuid,
      name: selection.name,
      degreeState: {
        status: "error",
        resolverId: text(resolved?.resolverId) || part.declaration.degreeResolverId,
        input: resolved?.input ?? null,
        declarationTotal: declarationRoll.total,
        naturalD20: declarationRoll.naturalD20,
        basedOnDeclarationRevision: next.revisions.declaration,
        basedOnRosterRevision: next.revisions.roster,
        error: resolved?.error || "missing-or-invalid-target-threshold"
      },
      targetResult: null,
      metadata: previous?.metadata ?? {}
    });
  } else {
    const degreeState = normalizeDegreeState({
      status: "resolved",
      resolverId: text(resolved?.resolverId) || part.declaration.degreeResolverId,
      baseDegree: degree,
      calculatedDegree: degree,
      manualAdjusted: false,
      input: resolved?.input ?? null,
      declarationTotal: declarationRoll.total,
      naturalD20: declarationRoll.naturalD20,
      basedOnDeclarationRevision: next.revisions.declaration,
      basedOnRosterRevision: next.revisions.roster
    });
    const oldTarget = previous?.targetResult ? normalizeTargetResult(previous.targetResult) : null;
    const targetResult = normalizeTargetResult({
      affectedId: resultId,
      base: oldTarget?.base ?? { degree, effectDegree: degree, outcomeViews: [], components: [] },
      steps: oldTarget?.steps ?? [],
      current: oldTarget?.current ?? { degree, effectDegree: degree, outcomeViews: [], components: [] },
      revision: oldTarget?.revision ?? 0,
      stale: false
    });
    targetResult.base.degree = degree;
    targetResult.base.effectDegree = degree;
    partResult = normalizePartTargetResult({
      resultId,
      targetSlotId: slot.slotId,
      selectionId: selection.selectionId,
      tokenUuid: selection.tokenUuid,
      actorUuid: selection.actorUuid,
      name: selection.name,
      degreeState,
      targetResult: recalculateTargetResult(targetResult),
      metadata: previous?.metadata ?? {}
    });
  }

  if (resultIndex >= 0) part.targetResults[resultIndex] = partResult;
  else part.targetResults.push(partResult);
  part.revision += 1;
  bump(next, ["degrees", "resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

/** Resolve all current selections in all resolution-role TargetSlots. */
export function resolveAllPartTargetDegrees(actionState, resolver) {
  let next = normalizeActionState(actionState);
  const identities = [];
  for (const part of next.parts) {
    for (const slot of part.targetSlots) {
      if (!slot.roles.includes("resolution")) continue;
      for (const selection of slot.selections) {
        identities.push([part.partId, slot.slotId, selection.selectionId]);
      }
    }
  }
  for (const [partId, slotId, selectionId] of identities) {
    next = resolvePartTargetSelectionDegree(next, partId, slotId, selectionId, resolver);
  }
  return normalizeActionState(next);
}

export function setPartTargetDegree(actionState, partId, slotId, selectionId, degree) {
  const normalizedDegree = normalizeDegree(degree);
  const next = normalizeActionState(actionState);
  if (!normalizedDegree) return next;
  const part = requireActionPart(next, partId);
  requireTargetSlot(part, slotId);
  const result = part.targetResults.find(entry => entry.targetSlotId === text(slotId) && entry.selectionId === text(selectionId));
  if (!result || result.degreeState?.status !== "resolved" || !result.targetResult) return next;

  const calculatedDegree = normalizeDegree(result.degreeState.calculatedDegree ?? result.degreeState.baseDegree) ?? normalizedDegree;
  result.degreeState = normalizeDegreeState({
    ...result.degreeState,
    baseDegree: normalizedDegree,
    calculatedDegree,
    manualAdjusted: normalizedDegree !== calculatedDegree,
    error: null
  });
  const target = normalizeTargetResult(result.targetResult);
  target.base.degree = normalizedDegree;
  target.base.effectDegree = normalizedDegree;
  result.targetResult = recalculateTargetResult(target);
  part.revision += 1;
  bump(next, ["degrees", "resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function shiftPartTargetDegree(actionState, partId, slotId, selectionId, delta = 0) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const result = part.targetResults.find(entry => entry.targetSlotId === text(slotId) && entry.selectionId === text(selectionId));
  const current = normalizeDegree(result?.degreeState?.baseDegree);
  if (!current) return next;
  const index = ACTION_DEGREES.indexOf(current);
  const targetIndex = Math.max(0, Math.min(ACTION_DEGREES.length - 1, index + integerOr(delta, 0)));
  if (targetIndex === index) return next;
  return setPartTargetDegree(next, partId, slotId, selectionId, ACTION_DEGREES[targetIndex]);
}

export function setPartTargetResultBase(actionState, partId, slotId, selectionId, snapshot, { preserveSteps = true } = {}) {
  const next = normalizeActionState(actionState);
  const part = requireActionPart(next, partId);
  const result = part.targetResults.find(entry => entry.targetSlotId === text(slotId) && entry.selectionId === text(selectionId));
  if (!result?.targetResult) return next;
  const target = normalizeTargetResult(result.targetResult);
  target.base = normalizeResultSnapshot(snapshot);
  if (!preserveSteps) target.steps = [];
  target.stale = false;
  result.targetResult = recalculateTargetResult(target);
  part.revision += 1;
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

function requirePartTargetResult(state, partId, slotId, selectionId) {
  const part = requireActionPart(state, partId);
  requireTargetSlot(part, slotId);
  const result = part.targetResults.find(entry => entry.targetSlotId === text(slotId) && entry.selectionId === text(selectionId));
  if (!result?.targetResult) throw new Error(`unknown-part-target-result:${part.partId}:${text(slotId)}:${text(selectionId)}`);
  return { part, result };
}

export function appendPartResolutionStep(actionState, partId, slotId, selectionId, step, options = {}) {
  const next = normalizeActionState(actionState);
  const { part, result } = requirePartTargetResult(next, partId, slotId, selectionId);
  const target = normalizeTargetResult(result.targetResult);
  target.steps.push(normalizeResolutionStep({ ...step, affectedId: target.affectedId }));
  target.revision += 1;
  target.stale = false;
  result.targetResult = recalculateTargetResult(target, options);
  part.revision += 1;
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function rerollPartResolutionStep(actionState, partId, slotId, selectionId, stepId, rollState, {
  deriveOperation = null,
  operationResolvers = {}
} = {}) {
  const next = normalizeActionState(actionState);
  const { part, result } = requirePartTargetResult(next, partId, slotId, selectionId);
  const target = normalizeTargetResult(result.targetResult);
  const index = target.steps.findIndex(step => step.stepId === text(stepId));
  if (index < 0) return next;
  const previous = target.steps[index];
  const rerolled = normalizeResolutionStep({ ...previous, roll: normalizeRollState(rollState), wasRerolled: true });
  target.steps[index] = rerolled;
  if (typeof deriveOperation === "function") {
    const before = recalculateTargetResult({ ...target, steps: target.steps.slice(0, index) }, { operationResolvers });
    const operation = deriveOperation({
      step: jsonClone(rerolled, {}),
      targetResult: jsonClone(target, {}),
      before: jsonClone(before, {})
    });
    target.steps[index] = normalizeResolutionStep({ ...rerolled, operation });
  }
  target.revision += 1;
  target.stale = false;
  result.targetResult = recalculateTargetResult(target, { operationResolvers });
  part.revision += 1;
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function removePartResolutionStep(actionState, partId, slotId, selectionId, stepId, options = {}) {
  const next = normalizeActionState(actionState);
  const { part, result } = requirePartTargetResult(next, partId, slotId, selectionId);
  const target = normalizeTargetResult(result.targetResult);
  const before = target.steps.length;
  target.steps = target.steps.filter(step => step.stepId !== text(stepId));
  if (target.steps.length === before) return next;
  target.revision += 1;
  target.stale = false;
  result.targetResult = recalculateTargetResult(target, options);
  part.revision += 1;
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function validateActionStateV2(actionState) {
  const state = normalizeActionState(actionState);
  const diagnostics = [];
  const partIds = new Set(state.parts.map(part => part.partId));
  const rollIds = new Set(state.rollRegistry.map(entry => entry.rollId));
  const poolIds = new Set(state.poolRegistry.map(entry => entry.poolId));

  const push = (level, code, detail = {}) => diagnostics.push({ level, code, ...detail });

  for (const roll of state.rollRegistry) {
    if (roll.partId && !partIds.has(roll.partId)) {
      push("error", "roll-unknown-part", { rollId: roll.rollId, partId: roll.partId });
    }
  }

  for (const part of state.parts) {
    const slots = new Map(part.targetSlots.map(slot => [slot.slotId, slot]));
    const components = new Map(part.outcomeComponents.map(component => [component.componentId, component]));

    for (const slot of part.targetSlots) {
      if (slot.selections.length < slot.min) {
        push("warning", "target-slot-below-min", { partId: part.partId, slotId: slot.slotId, min: slot.min, count: slot.selections.length });
      }
      if (slot.max !== null && slot.selections.length > slot.max) {
        // Soft automation: limits are diagnostics, not state mutation/hard blocks.
        push("warning", "target-slot-above-max", { partId: part.partId, slotId: slot.slotId, max: slot.max, count: slot.selections.length });
      }
      if ((slot.selectionMode === "source" || slot.selectionMode === "fixed") && !slot.selections.length) {
        push("warning", "automatic-target-slot-unresolved", { partId: part.partId, slotId: slot.slotId });
      }
    }

    for (const rollRef of part.declaration.rollRefs) {
      if (!rollIds.has(rollRef)) {
        push("error", "part-missing-roll-ref", { partId: part.partId, rollId: rollRef });
      }
    }

    for (const component of part.outcomeComponents) {
      if (component.recipient.type === "targetSlot" && !slots.has(component.recipient.targetSlotId)) {
        push("error", "component-unknown-target-slot", {
          partId: part.partId,
          componentId: component.componentId,
          slotId: component.recipient.targetSlotId
        });
      }
      for (const dependency of component.dependsOn) {
        if (dependency.componentId && !components.has(dependency.componentId)) {
          push("error", "component-unknown-dependency", {
            partId: part.partId,
            componentId: component.componentId,
            dependencyId: dependency.componentId
          });
        }
      }
      for (const poolRef of component.poolRefs) {
        if (!poolIds.has(poolRef)) {
          push("error", "component-missing-pool-ref", {
            partId: part.partId,
            componentId: component.componentId,
            poolId: poolRef
          });
        }
      }
    }
  }

  for (const pool of state.poolRegistry) {
    if (pool.partId && !partIds.has(pool.partId)) {
      push("error", "pool-unknown-part", { poolId: pool.poolId, partId: pool.partId });
      continue;
    }
    if (!pool.partId) continue;
    const part = state.parts.find(entry => entry.partId === pool.partId);
    const component = pool.componentId
      ? part.outcomeComponents.find(entry => entry.componentId === pool.componentId)
      : null;
    if (pool.componentId && !component) {
      push("error", "pool-unknown-component", { poolId: pool.poolId, partId: pool.partId, componentId: pool.componentId });
    }

    const slots = new Map(part.targetSlots.map(slot => [slot.slotId, slot]));
    const validRolledParts = new Set(pool.parts.map(entry => entry.partId));
    const validUnits = new Set(pool.units.map(entry => entry.unitId));
    for (const assignment of pool.allocation.assignments) {
      const slot = slots.get(assignment.targetSlotId);
      if (!slot) {
        push("error", "allocation-unknown-target-slot", { poolId: pool.poolId, targetSlotId: assignment.targetSlotId });
        continue;
      }
      if (!slot.selections.some(entry => entry.selectionId === assignment.selectionId)) {
        push("error", "allocation-unknown-selection", { poolId: pool.poolId, targetSlotId: assignment.targetSlotId, selectionId: assignment.selectionId });
      }
      if (pool.allocation.mode === "rolledPartsToTargets" && !validRolledParts.has(assignment.unitId)) {
        push("error", "allocation-unknown-rolled-part", { poolId: pool.poolId, unitId: assignment.unitId });
      }
      if (pool.allocation.mode === "unitsToTargets" && !validUnits.has(assignment.unitId)) {
        push("error", "allocation-unknown-unit", { poolId: pool.poolId, unitId: assignment.unitId });
      }
    }
  }

  return diagnostics;
}

export function setDeclarationRoll(actionState, rollState) {
  const next = normalizeActionState(actionState);
  next.declarationRoll = normalizeRollState(rollState);
  bump(next, ["declaration"]);
  staleDegrees(next);
  invalidateDownstreamFromDegrees(next);
  return normalizeActionState(next);
}

function markRosterChanged(state) {
  bump(state, ["roster"]);
  staleDegrees(state);
  invalidateDownstreamFromDegrees(state);
}

export function addAffected(actionState, entries, { addedFrom = "manual", preserveResolved = false } = {}) {
  const next = normalizeActionState(actionState);
  const source = Array.isArray(entries) ? entries : [entries];
  const existing = new Set(next.affected.map(affectedIdentity).filter(Boolean));
  let changed = false;

  for (const raw of source) {
    const ref = affectedRef(raw);
    if (!ref) continue;
    const key = affectedIdentity(ref);
    if (!key || existing.has(key)) continue;
    existing.add(key);
    next.affected.push(normalizeAffectedEntry({
      ...ref,
      affectedId: text(raw?.affectedId) || randomId("affected"),
      addedFrom
    }));
    changed = true;
  }

  if (changed) {
    if (preserveResolved) {
      bump(next, ["roster"]);
      next.degreeResolution = {
        ...next.degreeResolution,
        status: "stale",
        basedOnRosterRevision: next.degreeResolution?.basedOnRosterRevision ?? null
      };
      staleFinalization(next);
    } else {
      markRosterChanged(next);
    }
  }
  return normalizeActionState(next);
}

export function removeAffected(actionState, affectedIdOrRef, { preserveResolved = false } = {}) {
  const next = normalizeActionState(actionState);
  const lookup = typeof affectedIdOrRef === "string"
    ? text(affectedIdOrRef)
    : affectedIdentity(affectedIdOrRef ?? {});
  if (!lookup) return next;

  const before = next.affected.length;
  const removedIds = new Set(
    next.affected
      .filter(entry => entry.affectedId === lookup || affectedIdentity(entry) === lookup)
      .map(entry => entry.affectedId)
  );
  next.affected = next.affected.filter(entry => !removedIds.has(entry.affectedId));
  if (next.affected.length === before) return next;

  next.outcome.pools = next.outcome.pools.filter(pool =>
    pool.scope !== "affected" || !removedIds.has(pool.affectedId)
  );
  next.finalization.results = next.finalization.results.filter(result => !removedIds.has(result.affectedId));
  if (preserveResolved) {
    bump(next, ["roster"]);
    const resolvedCount = next.affected.filter(entry => entry.degreeState?.status === "resolved").length;
    const errorCount = next.affected.filter(entry => entry.degreeState?.status === "error").length;
    const unresolvedCount = next.affected.length - resolvedCount - errorCount;
    next.degreeResolution = {
      status: unresolvedCount ? "stale" : errorCount ? "resolved-with-errors" : next.affected.length ? "resolved" : "empty",
      basedOnDeclarationRevision: next.revisions.declaration,
      basedOnRosterRevision: unresolvedCount ? next.degreeResolution?.basedOnRosterRevision ?? null : next.revisions.roster,
      resolvedCount,
      errorCount
    };
    staleFinalization(next);
  } else {
    markRosterChanged(next);
  }
  return normalizeActionState(next);
}

function degreeErrorState({ resolverId, declarationRoll, revisions, error, input = null }) {
  return normalizeDegreeState({
    status: "error",
    resolverId,
    baseDegree: null,
    input,
    declarationTotal: declarationRoll.total,
    naturalD20: declarationRoll.naturalD20,
    basedOnDeclarationRevision: revisions.declaration,
    basedOnRosterRevision: revisions.roster,
    error: text(error) || "degree-resolution-error"
  });
}

/**
 * Resolve degrees for the current roster from the already stored declaration
 * roll. resolver receives plain data and MUST NOT roll dice.
 *
 * resolver({ affected, declarationRoll, definition, actionContext, actionState })
 * -> { degree, input?, resolverId? } OR { error, input?, resolverId? }
 */
export function resolveDegrees(actionState, resolver) {
  const next = normalizeActionState(actionState);
  const declaration = next.declarationRoll;
  const resolverId = next.definition.declaration.degreeResolverId;
  let resolvedCount = 0;
  let errorCount = 0;

  for (const affected of next.affected) {
    let resolved;
    try {
      resolved = typeof resolver === "function"
        ? resolver({
            affected: jsonClone(affected, {}),
            declarationRoll: jsonClone(declaration, {}),
            definition: jsonClone(next.definition, {}),
            actionContext: jsonClone(next.actionContext, {}),
            actionState: jsonClone(next, {})
          })
        : { error: "missing-degree-resolver" };
    } catch (error) {
      resolved = { error: error?.message || "degree-resolver-threw" };
    }

    const degree = normalizeDegree(resolved?.degree ?? resolved?.baseDegree);
    if (!degree) {
      affected.degreeState = degreeErrorState({
        resolverId: text(resolved?.resolverId) || resolverId,
        declarationRoll: declaration,
        revisions: next.revisions,
        error: resolved?.error || "missing-or-invalid-target-threshold",
        input: resolved?.input ?? null
      });
      affected.targetResult = null;
      errorCount += 1;
      continue;
    }

    affected.degreeState = normalizeDegreeState({
      status: "resolved",
      resolverId: text(resolved?.resolverId) || resolverId,
      baseDegree: degree,
      calculatedDegree: degree,
      manualAdjusted: false,
      input: resolved?.input ?? null,
      declarationTotal: declaration.total,
      naturalD20: declaration.naturalD20,
      basedOnDeclarationRevision: next.revisions.declaration,
      basedOnRosterRevision: next.revisions.roster
    });
    affected.targetResult = normalizeTargetResult({
      affectedId: affected.affectedId,
      base: {
        degree,
        effectDegree: degree,
        outcomeViews: [],
        components: []
      },
      steps: [],
      current: {
        degree,
        effectDegree: degree,
        outcomeViews: [],
        components: []
      },
      revision: 0,
      stale: false
    });
    resolvedCount += 1;
  }

  bump(next, ["degrees", "resolution"]);
  next.degreeResolution = {
    status: errorCount ? "resolved-with-errors" : "resolved",
    basedOnDeclarationRevision: next.revisions.declaration,
    basedOnRosterRevision: next.revisions.roster,
    resolvedCount,
    errorCount
  };
  next.outcome = {
    ...normalizeOutcomeState(next.outcome),
    status: "empty",
    pools: [],
    components: []
  };
  staleFinalization(next);
  return normalizeActionState(next);
}


/** Resolve or refresh exactly one affected entry from the stored declaration roll. */
export function resolveAffectedDegree(actionState, affectedId, resolver) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === text(affectedId));
  if (!affected) return next;
  const declaration = next.declarationRoll;
  const resolverId = next.definition.declaration.degreeResolverId;
  let resolved;
  try {
    resolved = typeof resolver === "function"
      ? resolver({
          affected: jsonClone(affected, {}),
          declarationRoll: jsonClone(declaration, {}),
          definition: jsonClone(next.definition, {}),
          actionContext: jsonClone(next.actionContext, {}),
          actionState: jsonClone(next, {})
        })
      : { error: "missing-degree-resolver" };
  } catch (error) {
    resolved = { error: error?.message || "degree-resolver-threw" };
  }

  const degree = normalizeDegree(resolved?.degree ?? resolved?.baseDegree);
  if (!degree) {
    affected.degreeState = degreeErrorState({
      resolverId: text(resolved?.resolverId) || resolverId,
      declarationRoll: declaration,
      revisions: next.revisions,
      error: resolved?.error || "missing-or-invalid-target-threshold",
      input: resolved?.input ?? null
    });
    affected.targetResult = null;
  } else {
    affected.degreeState = normalizeDegreeState({
      status: "resolved",
      resolverId: text(resolved?.resolverId) || resolverId,
      baseDegree: degree,
      calculatedDegree: degree,
      manualAdjusted: false,
      input: resolved?.input ?? null,
      declarationTotal: declaration.total,
      naturalD20: declaration.naturalD20,
      basedOnDeclarationRevision: next.revisions.declaration,
      basedOnRosterRevision: next.revisions.roster
    });
    affected.targetResult = normalizeTargetResult({
      affectedId: affected.affectedId,
      base: { degree, effectDegree: degree, outcomeViews: [], components: [] },
      steps: [],
      current: { degree, effectDegree: degree, outcomeViews: [], components: [] },
      revision: 0,
      stale: false
    });
  }

  bump(next, ["degrees", "resolution"]);
  const resolvedCount = next.affected.filter(entry => entry.degreeState?.status === "resolved").length;
  const errorCount = next.affected.filter(entry => entry.degreeState?.status === "error").length;
  const unresolvedCount = next.affected.length - resolvedCount - errorCount;
  next.degreeResolution = {
    status: unresolvedCount ? "stale" : errorCount ? "resolved-with-errors" : next.affected.length ? "resolved" : "empty",
    basedOnDeclarationRevision: next.revisions.declaration,
    basedOnRosterRevision: unresolvedCount ? next.degreeResolution?.basedOnRosterRevision ?? null : next.revisions.roster,
    resolvedCount,
    errorCount
  };
  staleFinalization(next);
  return normalizeActionState(next);
}

/** Manually replace the working degree of one affected entry without rerolling declaration dice. */
export function setAffectedDegree(actionState, affectedId, degree) {
  const normalizedDegree = normalizeDegree(degree);
  const next = normalizeActionState(actionState);
  if (!normalizedDegree) return next;
  const affected = next.affected.find(entry => entry.affectedId === text(affectedId));
  if (!affected || affected.degreeState?.status !== "resolved" || !affected.targetResult) return next;

  const calculatedDegree = normalizeDegree(affected.degreeState.calculatedDegree ?? affected.degreeState.baseDegree) ?? normalizedDegree;
  affected.degreeState = normalizeDegreeState({
    ...affected.degreeState,
    status: "resolved",
    baseDegree: normalizedDegree,
    calculatedDegree,
    manualAdjusted: normalizedDegree !== calculatedDegree,
    error: null
  });

  const target = normalizeTargetResult(affected.targetResult);
  target.base.degree = normalizedDegree;
  target.base.effectDegree = normalizedDegree;
  affected.targetResult = recalculateTargetResult(target);
  bump(next, ["degrees", "resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function shiftAffectedDegree(actionState, affectedId, delta = 0) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === text(affectedId));
  const current = normalizeDegree(affected?.degreeState?.baseDegree);
  if (!current) return next;
  const index = ACTION_DEGREES.indexOf(current);
  const shift = integerOr(delta, 0);
  const targetIndex = Math.max(0, Math.min(ACTION_DEGREES.length - 1, index + shift));
  if (targetIndex === index) return next;
  return setAffectedDegree(next, affectedId, ACTION_DEGREES[targetIndex]);
}

/** Set a resolved outcome without coupling it to legacy damageState. */
export function setOutcomeResolution(actionState, outcomeState) {
  const next = normalizeActionState(actionState);
  next.outcome = normalizeOutcomeState({
    ...outcomeState,
    status: outcomeState?.status ?? "resolved"
  });
  bump(next, ["outcome", "resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

function resultViewFromPool(pool, { viewId = null, metadata = {} } = {}) {
  return normalizeOutcomeView({
    viewId: viewId || `${pool.poolId}-view`,
    sourcePoolId: pool.poolId,
    parts: pool.parts.map(part => ({
      partId: `${pool.poolId}:${part.partId}`,
      sourcePartId: part.partId,
      kind: part.kind,
      faces: part.faces,
      value: part.value,
      excluded: false,
      metadata: part.metadata
    })),
    metadata
  });
}

function poolForAffected(outcome, affectedId, poolId = null) {
  return outcome.pools.find(pool => {
    if (poolId && pool.poolId !== poolId) return false;
    if (pool.scope === "shared") return true;
    return pool.affectedId === affectedId;
  }) ?? null;
}

/**
 * Bind a stored outcome pool to one affected creature. The pool is rolled only
 * once; TargetResult gets a derived view whose parts retain sourcePartId links.
 */
export function bindOutcomePoolToAffected(actionState, affectedId, {
  poolId = null,
  viewId = null,
  components = null,
  metadata = {}
} = {}) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return next;
  const pool = poolForAffected(next.outcome, affectedId, poolId);
  if (!pool) return next;

  const target = normalizeTargetResult(affected.targetResult);
  target.base.outcomeViews = [
    ...target.base.outcomeViews.filter(view => view.sourcePoolId !== pool.poolId),
    resultViewFromPool(pool, { viewId, metadata })
  ];
  if (components !== null) target.base.components = jsonClone(components, []);
  target.stale = false;
  affected.targetResult = recalculateTargetResult(target);
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

function activeResultParts(snapshot, viewId = null) {
  const views = viewId
    ? snapshot.outcomeViews.filter(view => view.viewId === viewId)
    : snapshot.outcomeViews;
  return views.flatMap(view => view.parts.filter(part => !part.excluded));
}

function excludeRankedDice(snapshot, {
  direction = "smallest",
  count = 1,
  viewId = null,
  reason = "defense",
  tieBreakerPartIds = []
} = {}) {
  const next = normalizeResultSnapshot(snapshot);
  const candidates = activeResultParts(next, viewId).filter(part => part.kind === "die");
  const wanted = Math.min(candidates.length, Math.max(0, integerOr(count, 1)));
  if (!wanted) return next;

  const ordered = [...candidates].sort((a, b) => {
    const delta = direction === "largest" ? b.value - a.value : a.value - b.value;
    if (delta !== 0) return delta;
    return String(a.partId).localeCompare(String(b.partId));
  });

  const cutoffValue = ordered[wanted - 1].value;
  const strictlyRanked = ordered.filter(part =>
    direction === "largest" ? part.value > cutoffValue : part.value < cutoffValue
  );
  const cutoffTies = ordered.filter(part => part.value === cutoffValue);
  const remaining = wanted - strictlyRanked.length;
  let selected = [...strictlyRanked];

  if (cutoffTies.length <= remaining) {
    selected.push(...cutoffTies);
  } else {
    const requested = new Set(uniqueTextList(tieBreakerPartIds));
    const tieSelection = cutoffTies.filter(part => requested.has(part.partId)).slice(0, remaining);
    if (tieSelection.length !== remaining) {
      // Different equal-value dice may carry different traits. Choosing one is
      // a player/GM decision, so the generic state layer refuses to invent a
      // tactical tie-break. A rule/UI resolver can pass explicit part IDs.
      throw new Error("ambiguous-ranked-die");
    }
    selected.push(...tieSelection);
  }

  const ids = new Set(selected.map(part => part.partId));
  for (const view of next.outcomeViews) {
    for (const part of view.parts) {
      if (!ids.has(part.partId)) continue;
      part.excluded = true;
      part.exclusionReason = reason;
    }
  }
  return next;
}

export function lowerActionDegree(degree, steps = 1) {
  const index = ACTION_DEGREES.indexOf(normalizeDegree(degree));
  if (index < 0) return null;
  return ACTION_DEGREES[Math.max(0, index - Math.max(0, integerOr(steps, 1)))];
}

/** Built-in generic operations. Rule-specific resolvers can be injected later. */
export const ACTION_STATE_OPERATION_RESOLVERS = Object.freeze({
  noop(snapshot) {
    return normalizeResultSnapshot(snapshot);
  },
  sequence(snapshot, params = {}, resolveOperation) {
    let next = normalizeResultSnapshot(snapshot);
    for (const operation of Array.from(params?.operations ?? [])) {
      next = resolveOperation(next, normalizeResolutionOperation(operation));
    }
    return next;
  },
  "remove-smallest-active-die"(snapshot, params = {}) {
    return excludeRankedDice(snapshot, {
      direction: "smallest",
      count: params?.count ?? 1,
      viewId: text(params?.viewId) || null,
      reason: text(params?.reason) || "defense",
      tieBreakerPartIds: params?.tieBreakerPartIds ?? []
    });
  },
  "remove-largest-active-die"(snapshot, params = {}) {
    return excludeRankedDice(snapshot, {
      direction: "largest",
      count: params?.count ?? 1,
      viewId: text(params?.viewId) || null,
      reason: text(params?.reason) || "defense",
      tieBreakerPartIds: params?.tieBreakerPartIds ?? []
    });
  },
  "lower-degree"(snapshot, params = {}) {
    const next = normalizeResultSnapshot(snapshot);
    next.degree = lowerActionDegree(next.degree, params?.steps ?? 1);
    return next;
  },
  "lower-effect-degree"(snapshot, params = {}) {
    const next = normalizeResultSnapshot(snapshot);
    next.effectDegree = lowerActionDegree(next.effectDegree, params?.steps ?? 1);
    return next;
  }
});

function applyResolutionOperation(snapshot, operation, resolverRegistry = {}) {
  const normalized = normalizeResolutionOperation(operation);
  const registry = {
    ...ACTION_STATE_OPERATION_RESOLVERS,
    ...(resolverRegistry ?? {})
  };
  const resolver = registry[normalized.resolverId];
  if (typeof resolver !== "function") return normalizeResultSnapshot(snapshot);
  const recurse = (current, child) => applyResolutionOperation(current, child, resolverRegistry);
  return normalizeResultSnapshot(resolver(normalizeResultSnapshot(snapshot), normalized.params, recurse));
}

export function recalculateTargetResult(targetResult, { operationResolvers = {} } = {}) {
  const next = normalizeTargetResult(targetResult);
  let current = normalizeResultSnapshot(next.base);
  let error = null;

  for (const step of next.steps) {
    if (step.status !== "active") continue;
    try {
      current = applyResolutionOperation(current, step.operation, operationResolvers);
    } catch (caught) {
      error = caught?.message || "resolution-step-error";
      break;
    }
  }

  next.current = normalizeResultSnapshot(current);
  next.error = error;
  next.stale = false;
  next.revision += 1;
  return normalizeTargetResult(next);
}

export function appendResolutionStep(actionState, affectedId, step, options = {}) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return next;

  const normalizedStep = normalizeResolutionStep({ ...step, affectedId });
  affected.targetResult = normalizeTargetResult(affected.targetResult);
  affected.targetResult.steps.push(normalizedStep);
  affected.targetResult = recalculateTargetResult(affected.targetResult, options);
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

/** Replace only the current roll of one defense step; old roll values are not retained. */
export function rerollResolutionStep(actionState, affectedId, stepId, rollState, {
  deriveOperation = null,
  operationResolvers = {}
} = {}) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return next;
  const target = normalizeTargetResult(affected.targetResult);
  const step = target.steps.find(entry => entry.stepId === stepId);
  if (!step) return next;

  step.roll = normalizeRollState(rollState);
  step.wasRerolled = true;

  // A defense reroll may change success/failure and therefore the semantic
  // operation of this same step. The caller's rule resolver may replace the
  // operation, while ActionState itself remains rule-agnostic. Old roll values
  // and old operations are deliberately not retained.
  if (typeof deriveOperation === "function") {
    const derived = deriveOperation({
      step: jsonClone(step, {}),
      targetResult: jsonClone(target, {}),
      actionState: jsonClone(next, {})
    });
    if (derived) step.operation = normalizeResolutionOperation(derived);
  }

  affected.targetResult = recalculateTargetResult(target, { operationResolvers });
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

/** Physically remove a defense step; no hidden status=undone record is kept. */
export function removeResolutionStep(actionState, affectedId, stepId, options = {}) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return next;
  const target = normalizeTargetResult(affected.targetResult);
  const before = target.steps.length;
  target.steps = target.steps.filter(step => step.stepId !== stepId);
  if (target.steps.length === before) return next;

  affected.targetResult = recalculateTargetResult(target, options);
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

/**
 * Reroll one source outcome die, then rebuild every TargetResult view linked to
 * that source part and replay stored ResolutionSteps without rolling them.
 */
export function rerollOutcomeDie(actionState, { poolId, partId, value }, options = {}) {
  const next = normalizeActionState(actionState);
  const pool = next.outcome.pools.find(entry => entry.poolId === poolId);
  const part = pool?.parts?.find(entry => entry.partId === partId);
  const nextValue = finiteNumberOrNull(value);
  if (!pool || !part || part.kind !== "die" || nextValue === null || nextValue <= 0) return next;

  part.value = nextValue;
  for (const affected of next.affected) {
    if (!affected.targetResult) continue;
    const target = normalizeTargetResult(affected.targetResult);
    let touched = false;
    for (const view of target.base.outcomeViews) {
      if (view.sourcePoolId !== poolId) continue;
      for (const viewPart of view.parts) {
        if (viewPart.sourcePartId !== partId) continue;
        viewPart.value = nextValue;
        touched = true;
      }
    }
    if (touched) affected.targetResult = recalculateTargetResult(target, options);
  }

  bump(next, ["outcome", "resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

export function finalizeTargetResult(actionState, affectedId) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult || affected.targetResult.stale) return next;

  const finalResult = normalizeFinalTargetResult({
    finalResultId: randomId("final"),
    affectedId,
    actionId: next.actionId,
    provenance: {
      tokenUuid: affected.tokenUuid,
      actorUuid: affected.actorUuid,
      name: affected.name
    },
    result: jsonClone(affected.targetResult.current, {}),
    basedOnResolutionRevision: next.revisions.resolution
  });

  next.finalization.results = [
    ...next.finalization.results.filter(entry => entry.affectedId !== affectedId),
    finalResult
  ];
  bump(next, ["finalization"]);
  next.finalization.status = "resolved";
  next.finalization.basedOnResolutionRevision = next.revisions.resolution;
  return normalizeActionState(next);
}

export function finalizeAllTargetResults(actionState) {
  let next = normalizeActionState(actionState);
  for (const affected of next.affected) {
    if (!affected.targetResult || affected.targetResult.stale) continue;
    next = finalizeTargetResult(next, affected.affectedId);
  }
  return next;
}

/** Replace the base snapshot of one TargetResult and replay its stored steps. */
export function setTargetResultBase(actionState, affectedId, snapshot, {
  preserveSteps = true,
  operationResolvers = {}
} = {}) {
  const next = normalizeActionState(actionState);
  const affected = next.affected.find(entry => entry.affectedId === affectedId);
  if (!affected?.targetResult) return next;

  const target = normalizeTargetResult(affected.targetResult);
  target.base = normalizeResultSnapshot(snapshot);
  if (!preserveSteps) target.steps = [];
  affected.targetResult = recalculateTargetResult(target, { operationResolvers });
  bump(next, ["resolution"]);
  staleFinalization(next);
  return normalizeActionState(next);
}

/** Reroll exactly one active die inside an already materialized FinalTargetResult. */
export function rerollFinalResultDie(finalTargetResult, { viewId = null, partId, value } = {}) {
  const next = normalizeFinalTargetResult(finalTargetResult);
  const numeric = finiteNumberOrNull(value);
  const wantedPartId = text(partId);
  if (!wantedPartId || numeric === null || numeric <= 0) return next;

  let changed = false;
  for (const view of next.result.outcomeViews) {
    if (viewId && view.viewId !== viewId) continue;
    const part = view.parts.find(entry => entry.partId === wantedPartId);
    if (!part || part.kind !== "die" || part.excluded) continue;
    part.value = numeric;
    changed = true;
    break;
  }

  if (changed) {
    next.metadata = { ...next.metadata, edited: true };
  }
  return normalizeFinalTargetResult(next);
}

/**
 * Reroll all ACTIVE random dice in a materialized FinalTargetResult.
 * Excluded dice and fixed parts are intentionally untouched. valuesByPartId is
 * supplied by the UI/runtime after the physical Roll has already happened.
 */
export function rerollAllFinalResultDice(finalTargetResult, valuesByPartId = {}) {
  const next = normalizeFinalTargetResult(finalTargetResult);
  let changed = false;

  for (const view of next.result.outcomeViews) {
    for (const part of view.parts) {
      if (part.kind !== "die" || part.excluded) continue;
      const numeric = finiteNumberOrNull(valuesByPartId?.[part.partId]);
      if (numeric === null || numeric <= 0) continue;
      part.value = numeric;
      changed = true;
    }
  }

  if (changed) {
    next.metadata = { ...next.metadata, edited: true, allDiceRerolled: true };
  }
  return normalizeFinalTargetResult(next);
}

export function serializeActionState(actionState) {
  return jsonClone(normalizeActionState(actionState), null);
}

export function actionStateFlagUpdate(actionState) {
  return {
    [`flags.${ACTION_STATE_FLAG_SCOPE}.${ACTION_STATE_FLAG_KEY}`]: serializeActionState(actionState)
  };
}

export function actionStateFromMessage(message) {
  const value = message?.getFlag?.(ACTION_STATE_FLAG_SCOPE, ACTION_STATE_FLAG_KEY);
  return value ? normalizeActionState(value) : null;
}

export async function setActionStateOnMessage(message, actionState) {
  if (!message?.setFlag) throw new Error("ChatMessage does not support setFlag");
  const serialized = serializeActionState(actionState);
  await message.setFlag(ACTION_STATE_FLAG_SCOPE, ACTION_STATE_FLAG_KEY, serialized);
  return serialized;
}
