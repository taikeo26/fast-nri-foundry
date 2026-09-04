import {
  normalizeActionState,
  normalizeTargetResult
} from "./action-state.mjs";

/**
 * Fast NRI 0.5.72 — ActionState v2 FinalResult/Application foundation.
 *
 * This module is intentionally Foundry-light. It materializes independent
 * recipient streams from ActionPart + TargetSlot + OutcomeComponent and
 * defines a generic ApplicationReceipt/dependency contract. Concrete Actor
 * mutation remains the responsibility of the application adapter.
 */

export const FINAL_RESULT_PACKAGE_SCHEMA_VERSION = 1;
export const APPLICATION_RECEIPT_SCHEMA_VERSION = 1;
export const FINAL_RESULT_APPLICATION_POLICY = "explicit-assigned-or-current-controlled";

export const FINAL_RESULT_VALUE_KINDS = Object.freeze([
  "parts",
  "number",
  "derived",
  "manual"
]);

export const FINAL_RESULT_DEPENDENCY_CONDITIONS = Object.freeze([
  "component-resolved",
  "component-applied",
  "component-applied-positive"
]);

function text(value) {
  return typeof value === "string" ? value.trim() : "";
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

function jsonClone(value, fallback = null) {
  if (value === undefined) return fallback;
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_error) { return fallback; }
}

function stableSegment(value, fallback = "x") {
  const normalized = text(value).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function randomId(prefix = "id") {
  const native = globalThis.foundry?.utils?.randomID?.();
  if (native) return `${prefix}-${native}`;
  const cryptoId = globalThis.crypto?.randomUUID?.();
  if (cryptoId) return `${prefix}-${cryptoId}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeRecipientRef(value = {}) {
  return {
    targetSlotId: text(value?.targetSlotId) || null,
    selectionId: text(value?.selectionId) || null,
    tokenUuid: text(value?.tokenUuid) || null,
    actorUuid: text(value?.actorUuid) || null,
    name: text(value?.name) || null,
    kind: ["targetSlot", "source", "fixed", "none"].includes(value?.kind) ? value.kind : "none",
    roles: Array.from(value?.roles ?? []).map(text).filter(Boolean)
  };
}

function normalizeResolutionRef(value = {}) {
  return {
    targetSlotId: text(value?.targetSlotId) || null,
    selectionId: text(value?.selectionId) || null,
    tokenUuid: text(value?.tokenUuid) || null,
    actorUuid: text(value?.actorUuid) || null,
    name: text(value?.name) || null,
    degree: text(value?.degree) || null,
    effectDegree: text(value?.effectDegree) || null
  };
}

function normalizeFinalPart(value = {}, index = 0) {
  const kind = value?.kind === "fixed" ? "fixed" : "die";
  return {
    partId: text(value?.partId ?? value?.id) || `part-${index}`,
    sourcePartId: text(value?.sourcePartId) || null,
    sourcePoolId: text(value?.sourcePoolId) || null,
    sourceUnitId: text(value?.sourceUnitId) || null,
    kind,
    faces: kind === "die" ? Math.max(2, integerOr(value?.faces, 2)) : null,
    value: finiteNumberOrNull(value?.value) ?? 0,
    excluded: Boolean(value?.excluded),
    exclusionReason: text(value?.exclusionReason) || null,
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

function normalizeDependencyRef(value = {}, index = 0) {
  const condition = FINAL_RESULT_DEPENDENCY_CONDITIONS.includes(value?.condition)
    ? value.condition
    : "component-resolved";
  return {
    dependencyId: text(value?.dependencyId) || `dependency-${index}`,
    componentId: text(value?.componentId) || null,
    condition,
    sourceFinalResultIds: Array.from(value?.sourceFinalResultIds ?? []).map(text).filter(Boolean),
    params: jsonClone(value?.params ?? {}, {})
  };
}

function normalizeValueSource(value = {}) {
  return {
    type: text(value?.type) || "none",
    componentId: text(value?.componentId) || null,
    sourceFinalResultIds: Array.from(value?.sourceFinalResultIds ?? []).map(text).filter(Boolean),
    rollId: text(value?.rollId) || null,
    poolId: text(value?.poolId) || null,
    partId: text(value?.partId) || null,
    value: finiteNumberOrNull(value?.value),
    table: jsonClone(value?.table ?? null, null),
    degree: text(value?.degree) || null,
    params: jsonClone(value?.params ?? {}, {})
  };
}

function normalizeFinalValue(value = {}) {
  const kind = FINAL_RESULT_VALUE_KINDS.includes(value?.kind) ? value.kind : "manual";
  return {
    kind,
    amount: finiteNumberOrNull(value?.amount),
    parts: Array.from(value?.parts ?? []).map(normalizeFinalPart),
    source: normalizeValueSource(value?.source ?? value?.valueSource ?? {}),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeFinalResultPackage(value = {}) {
  return {
    schemaVersion: FINAL_RESULT_PACKAGE_SCHEMA_VERSION,
    finalResultId: text(value?.finalResultId) || randomId("final-v2"),
    batchId: text(value?.batchId) || null,
    actionId: text(value?.actionId) || null,
    partId: text(value?.partId) || null,
    partLabel: text(value?.partLabel) || null,
    componentId: text(value?.componentId) || null,
    componentType: text(value?.componentType) || "manual",
    componentLabel: text(value?.componentLabel) || null,
    timing: text(value?.timing) || "resolution",
    delivery: {
      mode: value?.delivery?.mode === "combineByRecipient" ? "combineByRecipient" : "independent",
      key: text(value?.delivery?.key) || null
    },
    provenance: {
      source: normalizeRecipientRef(value?.provenance?.source ?? {}),
      recipient: normalizeRecipientRef(value?.provenance?.recipient ?? {}),
      resolution: normalizeResolutionRef(value?.provenance?.resolution ?? {})
    },
    value: normalizeFinalValue(value?.value ?? {}),
    dependencies: Array.from(value?.dependencies ?? []).map(normalizeDependencyRef),
    application: {
      policy: FINAL_RESULT_APPLICATION_POLICY,
      supported: value?.application?.supported !== false,
      adapterId: text(value?.application?.adapterId) || null,
      metadata: jsonClone(value?.application?.metadata ?? {}, {})
    },
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function normalizeApplicationReceipt(value = {}) {
  return {
    schemaVersion: APPLICATION_RECEIPT_SCHEMA_VERSION,
    receiptId: text(value?.receiptId) || randomId("receipt"),
    transactionId: text(value?.transactionId) || randomId("tx"),
    finalResultId: text(value?.finalResultId) || null,
    batchId: text(value?.batchId) || null,
    componentId: text(value?.componentId) || null,
    componentType: text(value?.componentType) || null,
    recipient: {
      tokenUuid: text(value?.recipient?.tokenUuid ?? value?.tokenUuid) || null,
      actorUuid: text(value?.recipient?.actorUuid ?? value?.actorUuid) || null,
      name: text(value?.recipient?.name ?? value?.recipientName) || null
    },
    requestedAmount: Math.max(0, finiteNumberOrNull(value?.requestedAmount) ?? 0),
    appliedAmount: Math.max(0, finiteNumberOrNull(value?.appliedAmount) ?? 0),
    before: jsonClone(value?.before ?? {}, {}),
    after: jsonClone(value?.after ?? {}, {}),
    dependencyReceiptIds: Array.from(value?.dependencyReceiptIds ?? []).map(text).filter(Boolean),
    undone: Boolean(value?.undone),
    metadata: jsonClone(value?.metadata ?? {}, {})
  };
}

export function createApplicationReceipt(value = {}) {
  return normalizeApplicationReceipt(value);
}

function sourceRefFromState(state) {
  const initiator = state?.actionContext?.initiator ?? {};
  const source = state?.actionContext?.source ?? {};
  return normalizeRecipientRef({
    kind: "source",
    selectionId: "source",
    tokenUuid: initiator?.tokenUuid,
    actorUuid: initiator?.actorUuid ?? source?.actorUuid,
    name: source?.name
  });
}

function recipientIdentity(recipient = {}) {
  return text(recipient?.selectionId)
    || text(recipient?.tokenUuid)
    || text(recipient?.actorUuid)
    || text(recipient?.kind)
    || "none";
}

function sourcePoolIds(state, part, component) {
  const explicit = new Set(component.poolRefs ?? []);
  for (const pool of state.poolRegistry ?? []) {
    if (pool.partId === part.partId && pool.componentId === component.componentId) explicit.add(pool.poolId);
  }
  return explicit;
}

function componentPools(state, part, component) {
  const ids = sourcePoolIds(state, part, component);
  return Array.from(state.poolRegistry ?? []).filter(pool => ids.has(pool.poolId));
}

function targetSlotFor(part, slotId) {
  return part.targetSlots.find(slot => slot.slotId === slotId) ?? null;
}

function partResultFor(part, slotId, selectionId) {
  return part.targetResults.find(result => result.targetSlotId === slotId && result.selectionId === selectionId) ?? null;
}

function resolutionRefFromPartResult(result) {
  if (!result) return normalizeResolutionRef({});
  const current = result.targetResult ? normalizeTargetResult(result.targetResult).current : null;
  return normalizeResolutionRef({
    targetSlotId: result.targetSlotId,
    selectionId: result.selectionId,
    tokenUuid: result.tokenUuid,
    actorUuid: result.actorUuid,
    name: result.name,
    degree: current?.degree ?? result.degreeState?.baseDegree,
    effectDegree: current?.effectDegree ?? result.degreeState?.baseDegree
  });
}

function componentRecipients(state, part, component) {
  const recipient = component.recipient ?? { type: "none" };
  if (recipient.type === "source") return [sourceRefFromState(state)];
  if (recipient.type === "fixed") {
    const ref = recipient.fixedRef ?? {};
    return [normalizeRecipientRef({ ...ref, kind: "fixed", selectionId: "fixed" })];
  }
  if (recipient.type !== "targetSlot") return [normalizeRecipientRef({ kind: "none" })];

  const slot = targetSlotFor(part, recipient.targetSlotId);
  if (!slot) return [];
  return slot.selections.map(selection => normalizeRecipientRef({
    ...selection,
    kind: "targetSlot",
    targetSlotId: slot.slotId,
    roles: slot.roles
  }));
}

function finalPartsFromTargetResult(result, componentId, poolIds) {
  if (!result?.targetResult) return [];
  const current = normalizeTargetResult(result.targetResult).current;
  const parts = [];
  for (const view of current.outcomeViews ?? []) {
    const poolMatch = view.sourcePoolId && poolIds.has(view.sourcePoolId);
    for (const rawPart of view.parts ?? []) {
      const metadataComponent = text(rawPart?.metadata?.componentId);
      if (!poolMatch && metadataComponent && metadataComponent !== componentId) continue;
      if (!poolMatch && !metadataComponent && poolIds.size) continue;
      parts.push(normalizeFinalPart({
        ...rawPart,
        sourcePoolId: view.sourcePoolId ?? rawPart?.sourcePoolId,
        metadata: { ...(rawPart?.metadata ?? {}), componentId }
      }, parts.length));
    }
  }
  return parts;
}

function finalPartsFromPool(pool) {
  return Array.from(pool?.parts ?? []).map((part, index) => normalizeFinalPart({
    ...part,
    sourcePartId: part.partId,
    sourcePoolId: pool.poolId,
    metadata: { ...(part.metadata ?? {}), componentId: pool.componentId }
  }, index));
}

function finalPartsFromUnit(pool, unit) {
  return Array.from(unit?.parts ?? []).map((part, index) => normalizeFinalPart({
    ...part,
    partId: `${unit.unitId}:${part.partId || `part-${index}`}`,
    sourcePartId: part.partId,
    sourcePoolId: pool.poolId,
    sourceUnitId: unit.unitId,
    metadata: { ...(part.metadata ?? {}), componentId: pool.componentId }
  }, index));
}

function sumActiveParts(parts = []) {
  return Array.from(parts ?? []).reduce((sum, part) => sum + (part.excluded ? 0 : Math.max(0, Number(part.value) || 0)), 0);
}

function degreeForComponent(part, component, recipient) {
  const slotId = text(component?.degreeSource?.targetSlotId)
    || (recipient?.roles?.includes("resolution") ? recipient.targetSlotId : null);
  if (!slotId) return null;
  const candidates = part.targetResults.filter(result => result.targetSlotId === slotId);
  const preferred = recipient?.selectionId
    ? candidates.find(result => result.selectionId === recipient.selectionId)
    : null;
  const result = preferred ?? (candidates.length === 1 ? candidates[0] : null);
  if (!result) return null;
  const target = result.targetResult ? normalizeTargetResult(result.targetResult) : null;
  const type = text(component?.degreeSource?.type);
  if (type === "effect-degree") return target?.current?.effectDegree ?? result.degreeState?.baseDegree ?? null;
  return target?.current?.degree ?? result.degreeState?.baseDegree ?? null;
}

function initialValueForComponent(part, component, recipient, parts) {
  const source = {
    ...component.valueSource,
    degree: degreeForComponent(part, component, recipient)
  };

  if (parts.length) {
    return normalizeFinalValue({
      kind: "parts",
      amount: sumActiveParts(parts),
      parts,
      source
    });
  }

  if (source.type === "degree-table") {
    const amount = finiteNumberOrNull(source.table?.[source.degree]) ?? 0;
    return normalizeFinalValue({ kind: "number", amount, source });
  }

  if (["fixed", "constant", "number"].includes(source.type)) {
    return normalizeFinalValue({ kind: "number", amount: source.value ?? 0, source });
  }

  if (["largest-die", "sum", "component-value"].includes(source.type) && source.componentId) {
    return normalizeFinalValue({ kind: "derived", amount: null, source });
  }

  return normalizeFinalValue({ kind: "manual", amount: source.value, source });
}

function finalResultIdFor({ actionId, partId, componentId, recipient, suffix = null }) {
  return [
    "final-v2",
    stableSegment(actionId, "action"),
    stableSegment(partId, "part"),
    stableSegment(componentId, "component"),
    stableSegment(recipientIdentity(recipient), "recipient"),
    suffix ? stableSegment(suffix, "stream") : null
  ].filter(Boolean).join("--");
}

function basePackage(state, part, component, recipient, resolution, value, { suffix = null, metadata = {} } = {}) {
  return normalizeFinalResultPackage({
    finalResultId: finalResultIdFor({
      actionId: state.actionId,
      partId: part.partId,
      componentId: component.componentId,
      recipient,
      suffix
    }),
    actionId: state.actionId,
    partId: part.partId,
    partLabel: part.label,
    componentId: component.componentId,
    componentType: component.type,
    componentLabel: component.label,
    timing: component.timing,
    delivery: component.delivery,
    provenance: {
      source: sourceRefFromState(state),
      recipient,
      resolution
    },
    value,
    dependencies: (component.dependsOn ?? []).map((dependency, index) => ({
      dependencyId: `${part.partId}:${component.componentId}:dependency:${index}`,
      componentId: dependency.componentId,
      condition: dependency.condition,
      params: dependency.params
    })),
    application: {
      policy: FINAL_RESULT_APPLICATION_POLICY,
      supported: true,
      adapterId: text(state.metadata?.adapterId) || component.type
    },
    metadata: {
      qaV2: Boolean(state.metadata?.qaV2Scenario),
      sourceAdapterId: text(state.metadata?.adapterId) || null,
      componentMetadata: jsonClone(component.metadata ?? {}, {}),
      ...metadata
    }
  });
}

function allocatedCandidates(state, part, component, pools, recipients) {
  const recipientById = new Map(recipients.map(recipient => [recipient.selectionId, recipient]));
  const candidates = [];

  for (const pool of pools) {
    const mode = pool.allocation?.mode ?? "none";
    if (mode === "none") continue;
    const assignmentByUnit = new Map((pool.allocation.assignments ?? []).map(assignment => [assignment.unitId, assignment]));

    if (mode === "rolledPartsToTargets") {
      for (const rawPart of pool.parts ?? []) {
        const assignment = assignmentByUnit.get(rawPart.partId);
        if (!assignment) continue;
        if (component.recipient?.targetSlotId && assignment.targetSlotId !== component.recipient.targetSlotId) continue;
        const recipient = recipientById.get(assignment.selectionId);
        if (!recipient) continue;
        candidates.push({
          recipient,
          resolution: resolutionRefFromPartResult(partResultFor(part, recipient.targetSlotId, recipient.selectionId)),
          parts: finalPartsFromPool({ ...pool, parts: [rawPart] }),
          suffix: rawPart.partId,
          allocation: { poolId: pool.poolId, unitId: rawPart.partId, mode }
        });
      }
    }

    if (mode === "unitsToTargets") {
      for (const unit of pool.units ?? []) {
        const assignment = assignmentByUnit.get(unit.unitId);
        if (!assignment) continue;
        if (component.recipient?.targetSlotId && assignment.targetSlotId !== component.recipient.targetSlotId) continue;
        const recipient = recipientById.get(assignment.selectionId);
        if (!recipient) continue;
        candidates.push({
          recipient,
          resolution: resolutionRefFromPartResult(partResultFor(part, recipient.targetSlotId, recipient.selectionId)),
          parts: finalPartsFromUnit(pool, unit),
          suffix: unit.unitId,
          allocation: { poolId: pool.poolId, unitId: unit.unitId, mode }
        });
      }
    }
  }

  return candidates;
}

function unallocatedCandidates(state, part, component, pools, recipients) {
  const poolIds = sourcePoolIds(state, part, component);
  return recipients.map(recipient => {
    const result = recipient.targetSlotId && recipient.selectionId
      ? partResultFor(part, recipient.targetSlotId, recipient.selectionId)
      : null;
    let parts = finalPartsFromTargetResult(result, component.componentId, poolIds);
    if (!parts.length) parts = pools.flatMap(finalPartsFromPool);
    return {
      recipient,
      resolution: resolutionRefFromPartResult(result),
      parts,
      suffix: null,
      allocation: null
    };
  });
}

function combineCandidates(candidates = [], component) {
  if (component.delivery?.mode !== "combineByRecipient") return candidates;
  const grouped = new Map();
  for (const candidate of candidates) {
    const key = recipientIdentity(candidate.recipient);
    if (!grouped.has(key)) grouped.set(key, { ...candidate, parts: [], allocations: [], suffix: component.delivery?.key || "combined" });
    const group = grouped.get(key);
    group.parts.push(...candidate.parts);
    if (candidate.allocation) group.allocations.push(candidate.allocation);
    if (!group.resolution?.selectionId && candidate.resolution?.selectionId) group.resolution = candidate.resolution;
  }
  return Array.from(grouped.values()).map(group => ({
    ...group,
    allocation: group.allocations.length ? group.allocations : null
  }));
}

function packagesForComponent(state, part, component) {
  const recipients = componentRecipients(state, part, component);
  if (!recipients.length) return [];
  const pools = componentPools(state, part, component);
  const hasAllocation = pools.some(pool => pool.allocation?.mode && pool.allocation.mode !== "none");
  let candidates = hasAllocation
    ? allocatedCandidates(state, part, component, pools, recipients)
    : unallocatedCandidates(state, part, component, pools, recipients);
  candidates = combineCandidates(candidates, component);

  return candidates.map(candidate => basePackage(
    state,
    part,
    component,
    candidate.recipient,
    candidate.resolution,
    initialValueForComponent(part, component, candidate.recipient, candidate.parts),
    {
      suffix: candidate.suffix,
      metadata: {
        allocation: jsonClone(candidate.allocation ?? null, null)
      }
    }
  ));
}

function dependencyMatchesPackage(dependency, source, dependent) {
  const params = dependency.params ?? {};
  const sourcePartId = text(params.partId) || dependent.partId;
  if (source.partId !== sourcePartId) return false;
  if (source.componentId !== dependency.componentId) return false;
  if (params.targetSlotId && source.provenance.recipient.targetSlotId !== params.targetSlotId) return false;
  if (params.selectionId && source.provenance.recipient.selectionId !== params.selectionId) return false;
  if (params.actorUuid && source.provenance.recipient.actorUuid !== params.actorUuid) return false;
  return true;
}

function bindPackageReferences(packages = []) {
  const normalized = packages.map(normalizeFinalResultPackage);
  return normalized.map(packageValue => {
    const result = normalizeFinalResultPackage(packageValue);
    result.dependencies = result.dependencies.map(dependency => ({
      ...dependency,
      sourceFinalResultIds: normalized
        .filter(source => dependencyMatchesPackage(dependency, source, result))
        .map(source => source.finalResultId)
    }));

    if (result.value.source.componentId) {
      const pseudoDependency = { componentId: result.value.source.componentId, params: result.value.source.params ?? {} };
      result.value.source.sourceFinalResultIds = normalized
        .filter(source => dependencyMatchesPackage(pseudoDependency, source, result))
        .map(source => source.finalResultId);
    }
    return result;
  });
}

export function materializeActionFinalResults(rawState, { batchId = null } = {}) {
  const state = normalizeActionState(rawState);
  const packages = [];
  for (const part of state.parts) {
    for (const component of part.outcomeComponents) {
      packages.push(...packagesForComponent(state, part, component));
    }
  }
  const linked = bindPackageReferences(packages);
  const resolvedBatchId = text(batchId) || randomId(`final-batch-${stableSegment(state.actionId, "action")}`);
  return linked.map(result => normalizeFinalResultPackage({ ...result, batchId: resolvedBatchId }));
}

function finalResultMap(finalResults = []) {
  return new Map(Array.from(finalResults ?? []).map(result => {
    const normalized = normalizeFinalResultPackage(result);
    return [normalized.finalResultId, normalized];
  }));
}

export function activeFinalResultParts(finalResult) {
  return normalizeFinalResultPackage(finalResult).value.parts.filter(part => !part.excluded);
}

function sourceResultsForValue(finalResult, finalResults = []) {
  const result = normalizeFinalResultPackage(finalResult);
  const byId = finalResultMap(finalResults);
  return result.value.source.sourceFinalResultIds.map(id => byId.get(id)).filter(Boolean);
}

export function resolveFinalResultAmount(finalResult, { finalResults = [] } = {}) {
  const result = normalizeFinalResultPackage(finalResult);
  if (result.value.kind === "parts") return sumActiveParts(result.value.parts);
  if (result.value.kind === "number") return Math.max(0, result.value.amount ?? 0);

  const source = result.value.source;
  const sources = sourceResultsForValue(result, finalResults);
  if (source.type === "largest-die") {
    const dice = sources.flatMap(activeFinalResultParts).filter(part => part.kind === "die");
    return dice.length ? Math.max(...dice.map(part => Math.max(0, Number(part.value) || 0))) : 0;
  }
  if (source.type === "sum" || source.type === "component-value") {
    return sources.reduce((sum, packageValue) => sum + resolveFinalResultAmount(packageValue, { finalResults }), 0);
  }
  if (source.type === "degree-table") {
    return Math.max(0, finiteNumberOrNull(source.table?.[source.degree]) ?? 0);
  }
  if (["fixed", "constant", "number"].includes(source.type)) return Math.max(0, source.value ?? 0);
  return Math.max(0, result.value.amount ?? 0);
}

export function evaluateFinalResultDependencies(finalResult, receipts = []) {
  const result = normalizeFinalResultPackage(finalResult);
  const normalizedReceipts = Array.from(receipts ?? []).map(normalizeApplicationReceipt);
  const details = result.dependencies.map(dependency => {
    const sourceIds = new Set(dependency.sourceFinalResultIds);
    const matching = normalizedReceipts.filter(receipt => !receipt.undone && sourceIds.has(receipt.finalResultId));
    let satisfied = false;
    if (dependency.condition === "component-resolved") satisfied = dependency.sourceFinalResultIds.length > 0;
    else if (dependency.condition === "component-applied") satisfied = matching.length > 0;
    else if (dependency.condition === "component-applied-positive") satisfied = matching.some(receipt => receipt.appliedAmount > 0);
    return {
      ...dependency,
      satisfied,
      matchingReceiptIds: matching.map(receipt => receipt.receiptId)
    };
  });
  return {
    ready: details.every(detail => detail.satisfied),
    details,
    qualifyingReceiptIds: Array.from(new Set(details.flatMap(detail => detail.matchingReceiptIds)))
  };
}

export function rerollFinalResultPackagePart(finalResult, { partId, value } = {}) {
  const result = normalizeFinalResultPackage(finalResult);
  const targetId = text(partId);
  let replaced = false;
  result.value.parts = result.value.parts.map(part => {
    if (part.partId !== targetId || part.kind !== "die" || part.excluded) return part;
    replaced = true;
    return { ...part, value: Math.max(1, integerOr(value, part.value)) };
  });
  if (!replaced) throw new Error(`final-part-not-rerollable:${targetId || "missing"}`);
  result.value.amount = sumActiveParts(result.value.parts);
  result.metadata = { ...result.metadata, wasEdited: true };
  return result;
}

export function rerollAllFinalResultPackageDice(finalResult, valuesByPartId = {}) {
  const result = normalizeFinalResultPackage(finalResult);
  result.value.parts = result.value.parts.map(part => {
    if (part.kind !== "die" || part.excluded) return part;
    const nextValue = finiteNumberOrNull(valuesByPartId?.[part.partId]);
    return nextValue === null ? part : { ...part, value: Math.max(1, Math.trunc(nextValue)) };
  });
  result.value.amount = sumActiveParts(result.value.parts);
  result.metadata = { ...result.metadata, wasEdited: true };
  return result;
}

export function finalResultPackageDiagnostics(finalResults = []) {
  const results = Array.from(finalResults ?? []).map(normalizeFinalResultPackage);
  const ids = new Set(results.map(result => result.finalResultId));
  const diagnostics = [];
  for (const result of results) {
    for (const dependency of result.dependencies) {
      if (!dependency.componentId) diagnostics.push({ level: "error", code: "dependency-component-missing", finalResultId: result.finalResultId });
      if (!dependency.sourceFinalResultIds.length) diagnostics.push({ level: "warning", code: "dependency-source-unresolved", finalResultId: result.finalResultId, componentId: dependency.componentId });
      for (const id of dependency.sourceFinalResultIds) {
        if (!ids.has(id)) diagnostics.push({ level: "error", code: "dependency-source-missing", finalResultId: result.finalResultId, sourceFinalResultId: id });
      }
    }
    if (result.value.kind === "derived" && !result.value.source.sourceFinalResultIds.length) {
      diagnostics.push({ level: "warning", code: "value-source-unresolved", finalResultId: result.finalResultId, componentId: result.value.source.componentId });
    }
  }
  return diagnostics;
}
