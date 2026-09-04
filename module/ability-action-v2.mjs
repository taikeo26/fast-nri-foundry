import {
  abilityActionParts,
  abilityAreaPresetLabel,
  abilityAreaPresets,
  abilityConfiguredOutcomeKinds,
  abilityCostLabel,
  abilityCosts,
  abilityHasDegreeProfiles,
  abilityImplementationRepeat,
  abilityImplementationRuntime,
  abilityIsSpell,
  abilityOutcomeChannelForDegree,
  abilityProfile,
  abilityTargeting,
  abilityTraitIds
} from "./ability-authoring.mjs";
import { abilityCheckConfig } from "./check-system.mjs";
import {
  actionContextFromAbility,
  actionContextFromWeapon,
  createActionContext,
  normalizeActionContext
} from "./action-context.mjs";
import {
  actionStateFlagUpdate,
  actionStateFromMessage,
  addTargetSlotSelections,
  appendPartResolutionStep,
  createActionState,
  normalizeActionState,
  normalizeTargetResult,
  registerActionRoll,
  registerOutcomePool,
  removePartResolutionStep,
  rerollPartResolutionStep,
  rerollRegisteredOutcomePart,
  resolveAllPartTargetDegrees,
  setPartTargetResultBase,
  setRegisteredOutcomePartExcluded,
  removeTargetSlotSelection
} from "./action-state.mjs";
import {
  createApplicationReceipt,
  evaluateFinalResultDependencies,
  materializeActionFinalResults,
  normalizeApplicationReceipt,
  normalizeFinalResultPackage,
  resolveFinalResultAmount
} from "./action-final-results.mjs";
import { filterDuplicateTargetSelectionsByHardBlock } from "./hard-blocks.mjs";
import { preventDuplicateTargetSelectionsEnabled } from "./settings.mjs";
import { resolveHpGainAgainstActor, resolveTemporaryHp } from "./health-actions.mjs";
import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";
import { formulaWithActorCombatTerm } from "./attack-term.mjs";
import {
  effectiveArmorForAction,
  effectiveDefenseCharacteristicForAction
} from "./target-state.mjs";
import {
  degreeVsArmor,
  degreeVsDC,
  prepareRoll,
  resolveDamageAgainstActor,
  selfDefenseContextualModifiers
} from "./rolls.mjs";
import {
  resolveDefenseCombatSource,
  resolveDefenseOptionsForToken
} from "./defense-actions.mjs";
import { applyEffectToActor, resolveEffectDocuments } from "./effect-system.mjs";
import { placeAbilityAreaPreset } from "./area-templates.mjs";
import { weaponV2Runtime } from "./weapon-v2-runtime.mjs";
import { itemIsEquipped, itemIsHeld, itemIsUsable, itemRequiresHands } from "./equipment.mjs";

/**
 * Fast NRI 0.5.80 — shared production ActionState v2 orchestration (Ability/Spell/Weapon/Maneuver/Skill).
 *
 * Target-first Card 1 → Card 2 now supports Check/Attack, degree profiles,
 * mixed Damage/HP/Effect outcomes, chronological per-target Defenses,
 * area/shared-roll/shared-outcome and optional explicit multi-part Ability
 * definitions. The adapter never parses prose and never creates a parallel
 * spell workflow.
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

function v2SourceKind(item, runtime) {
  const explicit = String(runtime?.v2SourceKind ?? "").trim();
  if (["weapon", "ability", "spell", "maneuver", "skill"].includes(explicit)) return explicit;
  if (item?.type === "weapon") return "weapon";
  return abilityIsSpell(runtime) ? "spell" : "ability";
}

function actionContextForImplementation(actor, item, runtime) {
  const kind = v2SourceKind(item, runtime);
  const base = kind === "weapon"
    ? actionContextFromWeapon(actor, item)
    : ["maneuver", "skill"].includes(kind)
      ? createActionContext({
          actor,
          check: {
            enabled: Boolean(abilityCheckConfig(runtime).enabled),
            formula: abilityCheckConfig(runtime).formula,
            targetCharacteristic: abilityCheckConfig(runtime).targetCharacteristic
          },
          traits: {
            melee: abilityTraitIds(runtime).includes("melee"),
            ranged: abilityTraitIds(runtime).includes("ranged"),
            area: abilityTraitIds(runtime).includes("area"),
            intervention: abilityTraitIds(runtime).includes("intervention")
          },
          traitIds: abilityTraitIds(runtime),
          directedDefense: Boolean(abilityCheckConfig(runtime).directedDefense)
        })
      : actionContextFromAbility(actor, item, { implementationId: runtime.implementationId });
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
      itemUuid: item?.uuid ?? null,
      itemType: item?.type ?? kind,
      name: item?.name ?? runtime?.name ?? runtime?.implementationName ?? "Действие",
      implementationId: runtime.implementationId,
      implementationName: runtime.implementationName
    },
    metadata: {
      ...(base.metadata ?? {}),
      ...(kind === "weapon" ? { weaponAttackTerm: runtime.weaponAttackTerm ?? null } : {})
    }
  };
}

function targetSlotFromRuntime(runtime, { resolution = false } = {}) {
  const target = abilityTargeting(runtime);
  if (["none", "location"].includes(target.mode)) return null;
  const self = target.mode === "self";
  const area = target.mode === "area";
  const single = target.mode === "single" || self;
  const min = self
    ? 1
    : Math.max(0, Number(target.countMin) || (single ? 1 : 0));
  const rawMax = self || single
    ? 1
    : Math.max(0, Number(target.countMax) || 0);
  return {
    slotId: "recipient",
    label: self
      ? "Получатель"
      : area
        ? "Цели области"
        : target.mode === "multiple"
          ? "Получатели"
          : "Цель",
    roles: resolution ? ["resolution", "recipient"] : ["recipient"],
    selectionMode: self ? "source" : "manual",
    min,
    max: rawMax > 0 ? rawMax : null,
    allowDuplicates: false,
    metadata: {
      relation: target.relation,
      rangeMode: target.rangeMode,
      rangeCells: target.rangeCells,
      requiresVisibility: target.requiresVisibility,
      area
    }
  };
}

function channelComponents(runtime, kind, degree = null) {
  return abilityOutcomeChannelForDegree(runtime, kind, degree).components.map((component, index) => ({
    index,
    formula: String(component?.formula ?? "").trim(),
    traitIds: Array.from(component?.traitIds ?? []).map(String).filter(Boolean),
    damageType: String(component?.damageType ?? "physical")
  })).filter(component => component.formula);
}

const PROFILE_DEGREES = Object.freeze(["failure", "partial", "success", "great"]);

function abilityAllOutcomeKinds(runtime) {
  const kinds = new Set(abilityConfiguredOutcomeKinds(runtime));
  for (const degree of PROFILE_DEGREES) {
    for (const kind of abilityConfiguredOutcomeKinds(runtime, degree)) kinds.add(kind);
  }
  return Array.from(kinds);
}

function partRuntime(runtime, rawPart = null) {
  if (!rawPart) return runtime;
  return {
    ...runtime,
    system: {
      ...runtime.system,
      ...rawPart,
      traitIds: Array.from(rawPart?.traitIds ?? []).length
        ? Array.from(rawPart.traitIds)
        : Array.from(runtime.system?.traitIds ?? []),
      targeting: rawPart?.targeting ?? runtime.system?.targeting ?? {},
      check: rawPart?.check ?? runtime.system?.check ?? {},
      defenseProcedure: rawPart?.defenseProcedure ?? runtime.system?.defenseProcedure ?? {},
      profiles: rawPart?.profiles ?? runtime.system?.profiles ?? {},
      outcomes: rawPart?.outcomes ?? runtime.system?.outcomes ?? {},
      effectUuids: Array.from(rawPart?.effectUuids ?? runtime.system?.effectUuids ?? [])
    }
  };
}

function explicitTargetSlots(rawPart, { resolution = false } = {}) {
  const stored = Array.from(rawPart?.targetSlots ?? []);
  if (!stored.length) return [];
  return stored.map((slot, index) => {
    const roles = Array.from(slot?.roles ?? []).map(String).filter(Boolean);
    const normalizedRoles = roles.length ? roles : ["recipient"];
    if (resolution && !normalizedRoles.includes("resolution")) normalizedRoles.unshift("resolution");
    return {
      slotId: String(slot?.id ?? slot?.slotId ?? `target-${index + 1}`),
      label: String(slot?.label ?? `Цель ${index + 1}`),
      roles: normalizedRoles,
      selectionMode: slot?.selectionMode === "source" ? "source" : "manual",
      min: Math.max(0, Number(slot?.min) || 0),
      max: Number(slot?.max) > 0 ? Math.max(1, Number(slot.max)) : null,
      allowDuplicates: Boolean(slot?.allowDuplicates),
      metadata: {
        relation: String(slot?.relation ?? "any"),
        rangeMode: String(slot?.rangeMode ?? "none"),
        rangeCells: Math.max(0, Number(slot?.rangeCells) || 0),
        requiresVisibility: Boolean(slot?.requiresVisibility)
      }
    };
  });
}

function profileDamageTransform(runtime, degree) {
  if (!abilityHasDegreeProfiles(runtime)) return null;
  const profile = abilityProfile(runtime, degree);
  if (!profile.enabled || !profile.damage?.enabled) {
    return { removeAll: true, removeHighest: 0, removeLowest: 0 };
  }
  return {
    removeAll: Boolean(profile.damage?.removeAll),
    removeHighest: Math.max(0, Number(profile.damage?.removeHighest) || 0),
    removeLowest: Math.max(0, Number(profile.damage?.removeLowest) || 0)
  };
}

function profileMetadataForKind(runtime, kind) {
  if (!abilityHasDegreeProfiles(runtime)) return {};
  const componentsByDegree = {};
  const enabledByDegree = {};
  const damageTransformsByDegree = {};
  for (const degree of PROFILE_DEGREES) {
    const profile = abilityProfile(runtime, degree);
    const channel = abilityOutcomeChannelForDegree(runtime, kind, degree);
    enabledByDegree[degree] = Boolean(profile.enabled && channel.enabled);
    componentsByDegree[degree] = channelComponents(runtime, kind, degree);
    if (kind === "damage") damageTransformsByDegree[degree] = profileDamageTransform(runtime, degree);
  }
  return {
    profileDriven: true,
    componentsByDegree,
    enabledByDegree,
    damageTransformsByDegree
  };
}

function effectProfileMetadata(runtime) {
  const common = Array.from(runtime.system?.effectUuids ?? []).map(String).filter(Boolean);
  const byDegree = {};
  for (const degree of PROFILE_DEGREES) {
    const profile = abilityProfile(runtime, degree);
    byDegree[degree] = profile.enabled ? Array.from(profile.effectUuids ?? []).map(String).filter(Boolean) : [];
  }
  return {
    effectUuids: common,
    effectUuidsByDegree: byDegree,
    profileDriven: abilityHasDegreeProfiles(runtime)
  };
}

function componentSignature(components = []) {
  return JSON.stringify(Array.from(components ?? []).map(component => ({
    formula: String(component?.formula ?? "").replace(/\s+/g, "").trim(),
    damageType: String(component?.damageType ?? "physical"),
    traitIds: Array.from(component?.traitIds ?? []).map(String).sort()
  })));
}

function sharedProfileCompatibility(runtime) {
  if (!abilityHasDegreeProfiles(runtime)) return { compatible: true, reasons: [] };
  const reasons = [];
  for (const kind of abilityAllOutcomeKinds(runtime)) {
    const signatures = new Set();
    for (const degree of PROFILE_DEGREES) {
      const profile = abilityProfile(runtime, degree);
      if (!profile.enabled) continue;
      const channel = abilityOutcomeChannelForDegree(runtime, kind, degree);
      if (!channel.enabled) continue;
      signatures.add(componentSignature(channelComponents(runtime, kind, degree)));
    }
    if (signatures.size > 1) reasons.push(`${kind}-profile-formulas`);
  }
  return { compatible: reasons.length === 0, reasons };
}

function standardOutcomeComponents(runtime, slot, check) {
  const kinds = abilityAllOutcomeKinds(runtime);
  const results = kinds.map(kind => ({
    componentId: kind,
    type: kind,
    label: kind === "damage" ? "Урон" : kind === "healing" ? "Исцеление" : "Временные HP",
    recipient: slot ? { type: "targetSlot", targetSlotId: slot.slotId } : { type: "source" },
    degreeSource: check.enabled && slot ? { type: "degree", targetSlotId: slot.slotId } : { type: "none" },
    timing: "resolution",
    valueSource: { type: "roll" },
    delivery: { mode: "independent" },
    metadata: {
      abilityOutcomeKind: kind,
      components: channelComponents(runtime, kind),
      ...profileMetadataForKind(runtime, kind)
    }
  }));

  const effectMeta = effectProfileMetadata(runtime);
  const hasEffects = effectMeta.effectUuids.length
    || Object.values(effectMeta.effectUuidsByDegree).some(values => values.length);
  if (hasEffects) {
    results.push({
      componentId: "effect",
      type: "effect",
      label: "Эффект",
      recipient: slot ? { type: "targetSlot", targetSlotId: slot.slotId } : { type: "source" },
      degreeSource: check.enabled && slot ? { type: "effect-degree", targetSlotId: slot.slotId } : { type: "none" },
      timing: "application",
      valueSource: { type: "manual" },
      delivery: { mode: "independent" },
      metadata: effectMeta
    });
  }
  return results;
}

function explicitOutcomeComponents(rawPart, slots = []) {
  return Array.from(rawPart?.outcomeComponents ?? []).map((source, index) => {
    const componentId = String(source?.id ?? source?.componentId ?? `component-${index + 1}`);
    const type = String(source?.type ?? "manual");
    const targetSlotId = String(source?.targetSlotId ?? slots[0]?.slotId ?? "");
    const recipientType = ["source", "targetSlot", "none"].includes(String(source?.recipientType))
      ? String(source.recipientType)
      : targetSlotId ? "targetSlot" : "source";
    const valueSourceType = String(source?.valueSourceType ?? (["damage", "healing", "tempHp"].includes(type) ? "roll" : "manual"));
    return {
      componentId,
      type,
      label: String(source?.label ?? (type === "damage" ? "Урон" : type === "healing" ? "Исцеление" : type === "tempHp" ? "Временные HP" : type === "effect" ? "Эффект" : componentId)),
      recipient: recipientType === "targetSlot"
        ? { type: "targetSlot", targetSlotId }
        : { type: recipientType },
      degreeSource: source?.degreeSourceTargetSlotId
        ? { type: String(source?.degreeSourceType ?? "degree"), targetSlotId: String(source.degreeSourceTargetSlotId) }
        : { type: "none" },
      timing: String(source?.timing ?? "resolution"),
      valueSource: {
        type: valueSourceType,
        componentId: String(source?.valueSourceComponentId ?? "") || null,
        value: Number.isFinite(Number(source?.value)) ? Number(source.value) : null
      },
      dependsOn: Array.from(source?.dependsOn ?? []).map(dep => ({
        componentId: String(dep?.componentId ?? ""),
        condition: String(dep?.condition ?? "component-resolved"),
        params: {
          ...(dep?.partId ? { partId: String(dep.partId) } : {}),
          ...(dep?.targetSlotId ? { targetSlotId: String(dep.targetSlotId) } : {})
        }
      })).filter(dep => dep.componentId),
      delivery: {
        mode: source?.deliveryMode === "combineByRecipient" ? "combineByRecipient" : "independent",
        key: String(source?.deliveryKey ?? "") || null
      },
      metadata: {
        components: Array.from(source?.components ?? []).map((component, componentIndex) => ({
          index: componentIndex,
          formula: String(component?.formula ?? "").trim(),
          traitIds: Array.from(component?.traitIds ?? []).map(String).filter(Boolean),
          damageType: String(component?.damageType ?? "physical")
        })).filter(component => component.formula),
        effectUuids: Array.from(source?.effectUuids ?? []).map(String).filter(Boolean),
        explicitActionPart: true,
        ...(source?.metadata && typeof source.metadata === "object" ? source.metadata : {}),
        ...(source?.resultTextByDegree ? { resultTextByDegree: source.resultTextByDegree } : {}),
        ...(source?.enabledByDegree ? { enabledByDegree: source.enabledByDegree } : {}),
        ...(source?.componentsByDegree ? { componentsByDegree: source.componentsByDegree, profileDriven: true } : {}),
        ...(source?.maneuverId ? { maneuverId: String(source.maneuverId) } : {})
      }
    };
  });
}

const DEGREE_LABELS = Object.freeze({
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
});

function targetDocumentForSelection(selection) {
  const tokenUuid = String(selection?.tokenUuid ?? "").trim();
  if (tokenUuid) {
    try {
      const resolved = globalThis.fromUuidSync?.(tokenUuid);
      if (resolved?.actor) return resolved.object ?? resolved;
    } catch (_error) { /* fall through */ }
    const live = Array.from(globalThis.canvas?.tokens?.placeables ?? []).find(token =>
      (token?.document?.uuid ?? token?.uuid) === tokenUuid
    );
    if (live?.actor) return live;
  }
  const actorUuid = String(selection?.actorUuid ?? "").trim();
  if (actorUuid) {
    try {
      const actor = globalThis.fromUuidSync?.(actorUuid);
      if (actor) return { actor };
    } catch (_error) { /* fall through */ }
    const actor = globalThis.game?.actors?.get?.(actorUuid.replace(/^Actor\./, ""));
    if (actor) return { actor };
  }
  return null;
}

export function abilityV2DegreeResolver(sourceActor, runtime) {
  const fallbackCheck = abilityCheckConfig(runtime);
  return ({ part, selection, declarationRoll }) => {
    const check = {
      ...fallbackCheck,
      ...(part?.metadata?.checkConfig ?? {})
    };
    if (declarationRoll?.status !== "rolled" || !Number.isFinite(Number(declarationRoll?.total))) {
      return { resolverId: "ability-characteristic", error: "missing-declaration-roll" };
    }
    const fixedDc = finiteNumberOrNull(check?.dc ?? part?.metadata?.checkConfig?.dc);
    if (fixedDc !== null) {
      const degree = degreeVsDC(declarationRoll.total, fixedDc, declarationRoll.naturalD20);
      return {
        resolverId: "fixed-dc",
        input: { dc: fixedDc },
        degree,
        error: degree ? null : "missing-fixed-dc"
      };
    }
    const target = targetDocumentForSelection(selection);
    const targetActor = target?.actor ?? null;
    if (!targetActor) return { resolverId: "ability-characteristic", error: "target-unavailable" };

    if (check.targetCharacteristic === "armor") {
      const resolved = target?.document || target?.getOccupiedGridSpaceOffsets || target?.object
        ? effectiveArmorForAction(target, sourceActor)
        : { armor: targetActor.system?.armor ?? null, state: null };
      const degree = degreeVsArmor(declarationRoll.total, resolved?.armor, declarationRoll.naturalD20);
      return {
        resolverId: "ability-characteristic",
        input: { targetCharacteristic: "armor", armor: resolved?.armor ?? null },
        degree,
        error: degree ? null : "missing-target-threshold"
      };
    }

    const resolved = target?.document || target?.getOccupiedGridSpaceOffsets || target?.object
      ? effectiveDefenseCharacteristicForAction(target, check.targetCharacteristic, sourceActor)
      : { value: finiteNumberOrNull(targetActor.system?.defenses?.[check.targetCharacteristic]), state: null };
    const dc = finiteNumberOrNull(resolved?.value);
    const degree = dc === null ? null : degreeVsDC(declarationRoll.total, dc, declarationRoll.naturalD20);
    return {
      resolverId: "ability-characteristic",
      input: { targetCharacteristic: check.targetCharacteristic, dc },
      degree,
      error: degree ? null : "missing-target-characteristic"
    };
  };
}

function registeredDeclarationRoll(state, part) {
  return Array.from(part?.declaration?.rollRefs ?? [])
    .map(rollId => state.rollRegistry.find(entry => entry.rollId === rollId))
    .find(Boolean)?.roll ?? null;
}

function rollStateFromRoll(roll, formula) {
  const d20 = Array.from(roll?.dice ?? []).find(die => Number(die?.faces) === 20);
  const active = Array.from(d20?.results ?? []).find(result => result?.active !== false && !result?.discarded);
  return {
    status: "rolled",
    formula: String(formula ?? roll?.formula ?? ""),
    total: finiteNumberOrNull(roll?.total),
    naturalD20: finiteNumberOrNull(active?.result)
  };
}

async function rollDeclarationChecks(rawState, actor, runtime) {
  let next = normalizeActionState(rawState);
  for (const part of next.parts) {
    if (part.declaration.rollMode === "none" || !part.declaration.formula) continue;
    const formula = formulaWithActorCombatTerm(actor, part.declaration.formula);
    const roll = await evaluatedRoll(formula);
    next = registerActionRoll(next, {
      rollId: `declaration-${part.partId}`,
      partId: part.partId,
      kind: "declaration",
      label: part.declaration.label,
      roll: rollStateFromRoll(roll, formula)
    });
  }
  return resolveAllPartTargetDegrees(next, abilityV2DegreeResolver(actor, runtime));
}

function partDefenseProcedureIds(check, traitIds = [], directedDefense = false) {
  const traits = new Set(Array.from(traitIds ?? []).map(String));
  const ids = [];
  const area = traits.has("area");
  if (
    directedDefense
    && check.enabled
    && check.targetCharacteristic === "armor"
    && !area
    && (traits.has("melee") !== traits.has("ranged"))
  ) ids.push("directed");
  if (check.enabled && ["awareness", "reflex", "fortitude", "will"].includes(check.targetCharacteristic)) {
    ids.push("counteraction");
  }
  if (check.enabled && area) ids.push("dodge");
  return Array.from(new Set(ids));
}

function partEligibility(runtime, rawPart = null, index = 0) {
  const view = partRuntime(runtime, rawPart);
  const check = abilityCheckConfig(view);
  const target = abilityTargeting(view);
  const explicitSlots = explicitTargetSlots(rawPart, { resolution: check.enabled });
  const targetSupported = ["none", "self", "single", "multiple", "area"].includes(target.mode);
  const hasResolutionTarget = explicitSlots.some(slot => slot.roles.includes("resolution"))
    || Boolean(targetSlotFromRuntime(view, { resolution: check.enabled }));
  const explicitOutcomes = Array.from(rawPart?.outcomeComponents ?? []);
  const kinds = explicitOutcomes.length
    ? Array.from(new Set(explicitOutcomes.map(component => String(component?.type ?? "manual"))))
    : abilityAllOutcomeKinds(view);
  const effectMeta = effectProfileMetadata(view);
  const hasEffects = explicitOutcomes.some(component => String(component?.type) === "effect")
    || effectMeta.effectUuids.length
    || Object.values(effectMeta.effectUuidsByDegree).some(values => values.length);
  const reasons = [];

  if (!targetSupported) reasons.push(`part-${index + 1}:target-mode:${target.mode}`);
  if (check.enabled && !hasResolutionTarget) reasons.push(`part-${index + 1}:check-without-resolution-target`);
  const unsupported = kinds.filter(kind => !["damage", "healing", "tempHp", "effect", "manual", "maneuver"].includes(kind));
  if (unsupported.length) reasons.push(`part-${index + 1}:unsupported-outcome:${unsupported.join(",")}`);
  if (!kinds.length && !hasEffects) reasons.push(`part-${index + 1}:no-outcome`);

  // Shared multi-target outcomes must be one real pool. Different formulas
  // between degree profiles cannot be silently rolled several times.
  const sharedTargeting = ["multiple", "area"].includes(target.mode)
    || explicitSlots.some(slot => slot.max === null || Number(slot.max) > 1)
    || Array.from(rawPart?.traitIds ?? []).map(String).includes("area");
  if (sharedTargeting && abilityHasDegreeProfiles(view)) {
    const shared = sharedProfileCompatibility(view);
    if (!shared.compatible) reasons.push(`part-${index + 1}:shared-profile-incompatible:${shared.reasons.join(",")}`);
  }

  return { view, check, target, kinds, hasEffects, reasons };
}

export function abilityV2AdapterEligibility(itemOrRuntime) {
  const runtime = itemOrRuntime?.implementationId
    ? itemOrRuntime
    : abilityImplementationRuntime(itemOrRuntime, null);
  const explicitParts = abilityActionParts(runtime);
  const sources = explicitParts.length ? explicitParts : [null];
  const details = sources.map((part, index) => partEligibility(runtime, part, index));
  const reasons = details.flatMap(entry => entry.reasons);
  const kinds = Array.from(new Set(details.flatMap(entry => entry.kinds)));
  return {
    eligible: reasons.length === 0,
    reasons,
    kinds,
    partCount: sources.length,
    explicitParts: explicitParts.length > 0
  };
}

function standardPartDefinition(runtime, rawPart, index, item) {
  const view = partRuntime(runtime, rawPart);
  const check = abilityCheckConfig(view);
  const explicitSlots = explicitTargetSlots(rawPart, { resolution: check.enabled });
  const fallbackSlot = targetSlotFromRuntime(view, { resolution: check.enabled });
  const targetSlots = explicitSlots.length ? explicitSlots : fallbackSlot ? [fallbackSlot] : [];
  const resolutionSlot = targetSlots.find(slot => slot.roles.includes("resolution")) ?? null;
  const recipientSlot = targetSlots.find(slot => slot.roles.includes("recipient")) ?? targetSlots[0] ?? null;
  const outcomes = Array.from(rawPart?.outcomeComponents ?? []).length
    ? explicitOutcomeComponents(rawPart, targetSlots)
    : standardOutcomeComponents(view, recipientSlot, check);
  const repeat = rawPart
    ? {
        count: Math.max(1, Number(rawPart?.repeat?.count) || 1),
        label: String(rawPart?.repeat?.label ?? rawPart?.label ?? "Результат")
      }
    : abilityImplementationRepeat(runtime);
  const parentTraitIds = abilityTraitIds(runtime).map(String).filter(Boolean);
  const rawTraitIds = Array.from(rawPart?.traitIds ?? []).map(String).filter(Boolean);
  const directionalTraits = new Set(["melee", "ranged", "area"]);
  const rawOverridesDirection = rawTraitIds.some(id => directionalTraits.has(id));
  const inheritedTraitIds = rawOverridesDirection
    ? parentTraitIds.filter(id => !directionalTraits.has(id))
    : parentTraitIds;
  const traitIds = Array.from(new Set([...inheritedTraitIds, ...rawTraitIds]));
  const procedures = partDefenseProcedureIds(check, traitIds, check.directedDefense);

  return {
    partId: String(rawPart?.id ?? `result${index ? `-${index + 1}` : ""}`),
    label: String(rawPart?.label ?? (repeat.count > 1 ? repeat.label : (runtime.implementationName || item.name))),
    repeat: { count: repeat.count },
    targetSlots,
    declaration: check.enabled ? {
      rollMode: "check",
      formula: check.formula,
      label: Number.isFinite(Number(rawPart?.check?.dc ?? view?.system?.check?.dc))
        ? `Проверка против Сложности ${Number(rawPart?.check?.dc ?? view?.system?.check?.dc)}`
        : `Проверка против ${check.targetCharacteristic}`,
      degreeResolverId: Number.isFinite(Number(rawPart?.check?.dc ?? view?.system?.check?.dc)) ? "fixed-dc" : "ability-characteristic",
      targetCharacteristic: check.targetCharacteristic
    } : { rollMode: "none" },
    outcomeComponents: outcomes,
    defenseProcedureIds: procedures,
    metadata: {
      implementationId: runtime.implementationId,
      explicitActionPart: Boolean(rawPart),
      traitIds,
      checkConfig: {
        enabled: check.enabled,
        formula: check.formula,
        targetCharacteristic: check.targetCharacteristic,
        directedDefense: check.directedDefense,
        dc: Number.isFinite(Number(rawPart?.check?.dc ?? view?.system?.check?.dc))
          ? Number(rawPart?.check?.dc ?? view?.system?.check?.dc)
          : null
      },
      resolutionTargetSlotId: resolutionSlot?.slotId ?? null,
      recipientTargetSlotId: recipientSlot?.slotId ?? null,
      area: traitIds.includes("area") || abilityTargeting(view).mode === "area",
      areaPresets: abilityAreaPresets(view).map(area => ({
        id: area.id,
        type: area.type,
        label: abilityAreaPresetLabel(area)
      }))
    }
  };
}

export function abilityActionDefinitionV2(actor, item, runtime) {
  const eligibility = abilityV2AdapterEligibility(runtime);
  if (!eligibility.eligible) throw new Error(`ability-v2-not-eligible:${eligibility.reasons.join("|")}`);
  const explicitParts = abilityActionParts(runtime);
  const rawParts = explicitParts.length ? explicitParts : [null];
  const parts = rawParts.map((rawPart, index) => standardPartDefinition(runtime, rawPart, index, item));
  const traits = Array.from(new Set([
    ...abilityTraitIds(runtime),
    ...parts.flatMap(part => Array.from(part.metadata?.traitIds ?? []))
  ]));

  return {
    sourceKind: v2SourceKind(item, runtime),
    sourceRef: {
      actorUuid: actor.uuid,
      itemUuid: item?.uuid ?? null,
      name: item?.name ?? runtime?.name ?? runtime?.implementationName ?? "Действие",
      implementationId: runtime.implementationId
    },
    traits,
    parts,
    metadata: {
      adapterId: v2SourceKind(item, runtime) === "weapon"
        ? "weapon-v2-0.5.78"
        : ["maneuver", "skill"].includes(v2SourceKind(item, runtime))
          ? "system-action-v2-0.5.79"
          : "ability-v2-0.5.77",
      implementationId: runtime.implementationId,
      explicitActionParts: explicitParts.length > 0
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

function targetDegreeSummary(result) {
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  const base = result?.degreeState?.baseDegree ?? null;
  const current = target?.current?.degree ?? base;
  const effect = target?.current?.effectDegree ?? base;
  return { target, base, current, effect };
}

function resolutionStepsHTML(part, result) {
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  if (!target?.steps?.length) return "";
  return `<div class="fast-nri-v2-defense-history">${target.steps.map(step => {
    const defense = step.operation?.params?.defenseRule ?? {};
    const resource = step.operation?.params?.resource ?? {};
    const outcome = defense.result === "success" ? "успех" : "провал";
    const resourceText = Number(resource.cost) > 0
      ? ` · ${esc(resource.label || "Классовый ресурс")} −${esc(resource.cost)}${resource.resourceUndone ? " · возвращено" : ""}`
      : "";
    const resourceUndo = Number(resource.spent) > 0 && !resource.resourceUndone
      ? `<button type="button" data-fast-nri-ability-v2-defense-resource-undo data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(result.targetSlotId)}" data-selection-id="${escAttr(result.selectionId)}" data-step-id="${escAttr(step.stepId)}"><span>Вернуть ресурс</span></button>`
      : "";
    return `<div class="fast-nri-qa-final-die-row">
      <span><strong>${esc(step.actionRef?.name || "Защита")}</strong> · ${esc(step.roll?.total ?? "—")} · ${esc(outcome)}${step.wasRerolled ? " · переброшено" : ""}${resourceText}</span>
      <span class="fast-nri-qa-row-actions">
        ${resourceUndo}
        <button type="button" data-fast-nri-ability-v2-defense-reroll data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(result.targetSlotId)}" data-selection-id="${escAttr(result.selectionId)}" data-step-id="${escAttr(step.stepId)}"><span>Переброс</span></button>
        <button type="button" data-fast-nri-ability-v2-defense-undo data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(result.targetSlotId)}" data-selection-id="${escAttr(result.selectionId)}" data-step-id="${escAttr(step.stepId)}"><span>Отмена</span></button>
      </span>
    </div>`;
  }).join("")}</div>`;
}

function slotHTML(state, part, slot, { resolution = false } = {}) {
  const rows = slot.selections.length
    ? slot.selections.map(selection => {
      const result = part.targetResults.find(entry => entry.targetSlotId === slot.slotId && entry.selectionId === selection.selectionId);
      const summary = targetDegreeSummary(result);
      const error = result?.degreeState?.status === "error" ? result.degreeState.error : null;
      let degreeText = "";
      if (resolution && slot.roles.includes("resolution")) {
        if (summary.base) {
          const baseLabel = DEGREE_LABELS[summary.base] ?? summary.base;
          const currentLabel = DEGREE_LABELS[summary.current] ?? summary.current;
          const effectLabel = DEGREE_LABELS[summary.effect] ?? summary.effect;
          degreeText = summary.current !== summary.base || summary.effect !== summary.current
            ? ` <span class="fast-nri-qa-degree">· исходно <strong>${esc(baseLabel)}</strong> → итог <strong>${esc(currentLabel)}</strong>${summary.effect !== summary.current ? ` · эффект: <strong>${esc(effectLabel)}</strong>` : ""}</span>`
            : ` <span class="fast-nri-qa-degree">· <strong>${esc(currentLabel)}</strong></span>`;
        } else if (error) degreeText = ` <span class="fast-nri-qa-error">· степень: ${esc(error)}</span>`;
        else degreeText = ` <span class="fast-nri-qa-degree">· степень не определена</span>`;
      }
      const defenseButton = resolution && slot.roles.includes("resolution") && part.defenseProcedureIds.length
        ? `<button type="button" data-fast-nri-ability-v2-defense data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}"><i class="fa-solid fa-shield-halved"></i><span>Защита</span></button>`
        : "";
      return `<div class="fast-nri-qa-target-row">
        <div class="fast-nri-qa-target-head"><span><strong>${esc(selectionName(selection))}</strong>${degreeText}</span><button type="button" data-fast-nri-ability-v2-remove data-part-id="${escAttr(part.partId)}" data-slot-id="${escAttr(slot.slotId)}" data-selection-id="${escAttr(selection.selectionId)}" title="Удалить"><i class="fa-solid fa-trash"></i></button></div>
        ${defenseButton ? `<div class="fast-nri-damage-actions">${defenseButton}</div>` : ""}
        ${resolutionStepsHTML(part, result)}
      </div>`;
    }).join("")
    : `<div class="fast-nri-roll-empty">Получатели не выбраны.</div>`;
  const defaultHint = slot.selectionMode === "source" ? " · по умолчанию: источник" : "";
  return `<div class="fast-nri-v2-slot">
    <div class="fast-nri-qa-stage-title">${esc(slot.label)} <small>· ${slot.roles.includes("resolution") ? "цель проверки и получатель" : "получатель"}${esc(defaultHint)}</small></div>
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


function resultSnapshotDegree(result, { effect = false, current = true } = {}) {
  const target = result?.targetResult ? normalizeTargetResult(result.targetResult) : null;
  if (current && target) return effect ? target.current.effectDegree : target.current.degree;
  return result?.degreeState?.baseDegree ?? null;
}

function outcomeComponentForPool(part, pool) {
  return part?.outcomeComponents?.find(component => component.componentId === pool?.componentId) ?? null;
}

function rankedActiveViewParts(view, direction = "largest") {
  return Array.from(view?.parts ?? [])
    .filter(part => !part.excluded)
    .sort((a, b) => {
      const delta = direction === "largest"
        ? Number(b.value || 0) - Number(a.value || 0)
        : Number(a.value || 0) - Number(b.value || 0);
      return delta || String(a.partId).localeCompare(String(b.partId));
    });
}

function excludeViewParts(view, parts, reason) {
  const ids = new Set(Array.from(parts ?? []).map(part => part.partId));
  for (const part of view.parts ?? []) {
    if (!ids.has(part.partId) || part.excluded) continue;
    part.excluded = true;
    part.exclusionReason = reason;
  }
}

/**
 * Re-project a stored shared pool for one target's current degree. This never
 * rerolls dice. Manual/defense exclusions are preserved; only exclusions made
 * by an older degree profile are replaced.
 */
export function reprofileAbilityV2Snapshot(rawSnapshot) {
  const snapshot = normalizeTargetResult({ base: rawSnapshot, current: rawSnapshot }).base;
  const degree = snapshot.degree;
  for (const view of snapshot.outcomeViews) {
    for (const part of view.parts) {
      if (part.exclusionReason !== "profile") continue;
      part.excluded = false;
      part.exclusionReason = null;
    }

    const metadata = view.metadata ?? {};
    if (!metadata.profileDriven || !degree) continue;
    const enabled = metadata.enabledByDegree?.[degree];
    if (enabled === false) {
      excludeViewParts(view, rankedActiveViewParts(view, "largest"), "profile");
      continue;
    }

    if (metadata.componentType !== "damage") continue;
    const transform = metadata.damageTransformsByDegree?.[degree] ?? null;
    if (!transform) continue;
    if (transform.removeAll) {
      excludeViewParts(view, rankedActiveViewParts(view, "largest"), "profile");
      continue;
    }
    const highest = Math.max(0, Number(transform.removeHighest) || 0);
    if (highest) excludeViewParts(view, rankedActiveViewParts(view, "largest").slice(0, highest), "profile");
    const lowest = Math.max(0, Number(transform.removeLowest) || 0);
    if (lowest) excludeViewParts(view, rankedActiveViewParts(view, "smallest").slice(0, lowest), "profile");
  }
  return snapshot;
}

function lowerSnapshotDegree(snapshot, steps = 1) {
  const order = ["failure", "partial", "success", "great"];
  const lower = value => {
    const index = order.indexOf(value);
    if (index < 0) return value ?? null;
    return order[Math.max(0, index - Math.max(0, Number(steps) || 1))];
  };
  snapshot.degree = lower(snapshot.degree);
  snapshot.effectDegree = lower(snapshot.effectDegree);
  return snapshot;
}

function removeDamagePartsByMode(rawSnapshot, count = 1, mode = "largest") {
  const snapshot = normalizeTargetResult({ base: rawSnapshot, current: rawSnapshot }).base;
  const direction = mode === "smallest" ? 1 : -1;
  const candidates = snapshot.outcomeViews
    .filter(view => view.metadata?.componentType === "damage")
    .flatMap(view => Array.from(view.parts ?? []).filter(part => !part.excluded).map(part => ({ view, part })))
    .sort((a, b) => direction * (Number(a.part.value || 0) - Number(b.part.value || 0)) || String(a.part.partId).localeCompare(String(b.part.partId)));
  for (const candidate of candidates.slice(0, Math.max(0, Number(count) || 0))) {
    candidate.part.excluded = true;
    candidate.part.exclusionReason = "defense";
  }
  return snapshot;
}

export const ABILITY_V2_OPERATION_RESOLVERS = Object.freeze({
  "ability-reprofile"(snapshot) {
    return reprofileAbilityV2Snapshot(snapshot);
  },
  "ability-lower-whole-degree"(rawSnapshot, params = {}) {
    const snapshot = lowerSnapshotDegree(normalizeTargetResult({ base: rawSnapshot, current: rawSnapshot }).base, params.steps ?? 1);
    return reprofileAbilityV2Snapshot(snapshot);
  },
  "ability-remove-largest-damage-parts"(snapshot, params = {}) {
    return removeDamagePartsByMode(snapshot, params.count ?? 1, params.mode ?? "largest");
  },
  "ability-full-cancel"(rawSnapshot) {
    const snapshot = normalizeTargetResult({ base: rawSnapshot, current: rawSnapshot }).base;
    snapshot.degree = "failure";
    snapshot.effectDegree = "failure";
    for (const view of snapshot.outcomeViews) {
      for (const part of view.parts) {
        if (part.excluded) continue;
        part.excluded = true;
        part.exclusionReason = "defense";
      }
    }
    return snapshot;
  }
});

function outcomeViewFromRegisteredPool(pool, component) {
  return {
    viewId: `${pool.poolId}:${component.componentId}`,
    sourcePoolId: pool.poolId,
    parts: Array.from(pool.parts ?? []).map(part => ({
      partId: `${pool.poolId}:${part.partId}`,
      sourcePartId: part.partId,
      kind: part.kind,
      faces: part.faces,
      value: part.value,
      excluded: Boolean(part.excluded),
      exclusionReason: part.excluded ? (part.exclusionReason || "manual") : null,
      metadata: {
        ...(part.metadata ?? {}),
        componentId: component.componentId
      }
    })),
    metadata: {
      componentId: component.componentId,
      componentType: component.type,
      rolledForDegree: pool.metadata?.rolledForDegree ?? null,
      profileDriven: Boolean(component.metadata?.profileDriven),
      enabledByDegree: component.metadata?.enabledByDegree ?? {},
      damageTransformsByDegree: component.metadata?.damageTransformsByDegree ?? {}
    }
  };
}

/** Bind all already-rolled Part pools into every per-target TargetResult. */
export function bindAbilityV2OutcomePools(rawState, partId = null) {
  let state = normalizeActionState(rawState);
  const parts = partId ? state.parts.filter(part => part.partId === partId) : state.parts;
  for (const part of parts) {
    const pools = state.poolRegistry.filter(pool => pool.partId === part.partId);
    for (const result of part.targetResults) {
      if (!result.targetResult) continue;
      const baseDegree = result.degreeState?.baseDegree ?? null;
      const views = pools.map(pool => {
        const component = outcomeComponentForPool(part, pool);
        return component ? outcomeViewFromRegisteredPool(pool, component) : null;
      }).filter(Boolean);
      let snapshot = {
        degree: baseDegree,
        effectDegree: baseDegree,
        outcomeViews: views,
        components: [],
        metadata: { adapterId: state.metadata?.adapterId ?? "action-v2" }
      };
      snapshot = reprofileAbilityV2Snapshot(snapshot);
      state = setPartTargetResultBase(
        state,
        part.partId,
        result.targetSlotId,
        result.selectionId,
        snapshot,
        { preserveSteps: true, operationResolvers: ABILITY_V2_OPERATION_RESOLVERS }
      );
    }
  }
  return normalizeActionState(state);
}

function componentTargetResults(part, component) {
  const slotId = component?.degreeSource?.targetSlotId || component?.recipient?.targetSlotId || part?.metadata?.resolutionTargetSlotId;
  if (!slotId) return [];
  return part.targetResults.filter(result => result.targetSlotId === slotId);
}

function currentDegreeForOutcome(part, component) {
  const results = componentTargetResults(part, component);
  if (!results.length) return null;
  const degrees = results.map(result => resultSnapshotDegree(result)).filter(Boolean);
  if (!degrees.length) return null;
  const enabled = component.metadata?.enabledByDegree ?? {};
  return degrees.find(degree => enabled[degree] !== false) ?? degrees[0];
}

function sourcesForOutcomeComponent(part, component) {
  if (!component.metadata?.profileDriven) {
    return { sources: Array.from(component.metadata?.components ?? []), degree: null };
  }
  const degree = currentDegreeForOutcome(part, component);
  if (degree) {
    return {
      sources: Array.from(component.metadata?.componentsByDegree?.[degree] ?? []),
      degree
    };
  }
  for (const candidate of PROFILE_DEGREES) {
    if (component.metadata?.enabledByDegree?.[candidate] === false) continue;
    const sources = Array.from(component.metadata?.componentsByDegree?.[candidate] ?? []);
    if (sources.length) return { sources, degree: candidate };
  }
  return { sources: [], degree };
}

function outcomeButtonLabel(component) {
  if (component.type === "damage") return "Бросить урон";
  if (component.type === "healing") return "Бросить исцеление";
  if (component.type === "tempHp") return "Бросить временные HP";
  return component.label ? `Бросить: ${component.label}` : "Бросить результат";
}

function effectUuidsForComponentDegree(component, degree) {
  const common = Array.from(component?.metadata?.effectUuids ?? []);
  const profiled = degree ? Array.from(component?.metadata?.effectUuidsByDegree?.[degree] ?? []) : [];
  return Array.from(new Set([...common, ...profiled].map(String).filter(Boolean)));
}

function manualOutcomeText(part, component) {
  const results = componentTargetResults(part, component);
  const table = component?.metadata?.resultTextByDegree ?? {};
  const rows = results.map(result => {
    const degree = resultSnapshotDegree(result, { effect: component.type === "maneuver" });
    const text = String(table?.[degree] ?? "").trim();
    return text ? `${selectionName(result)}: ${text}` : null;
  }).filter(Boolean);
  if (rows.length) return rows.join(" · ");
  const fallback = String(component?.metadata?.resultText ?? "").trim();
  return fallback;
}

function poolEditorHTML(state, part, component) {
  if (["manual", "maneuver"].includes(component.type)) {
    const text = manualOutcomeText(part, component);
    return `<div class="fast-nri-qa-stage-title">${esc(component.label || (component.type === "maneuver" ? "Манёвр" : "Результат"))}${text ? ` · ${esc(text)}` : " · определяется итоговой степенью"}</div>`;
  }
  if (component.type === "effect") {
    const results = componentTargetResults(part, component);
    const counts = results.length
      ? results.map(result => effectUuidsForComponentDegree(component, resultSnapshotDegree(result, { effect: true })).length)
      : [effectUuidsForComponentDegree(component, null).length];
    const maxCount = Math.max(0, ...counts);
    return `<div class="fast-nri-qa-stage-title">${esc(component.label || "Эффект")} · ${esc(maxCount)} подготовленн. Effect</div>`;
  }
  const pool = poolForPartComponent(state, part.partId, component.componentId);
  if (!pool) {
    return `<button type="button" data-fast-nri-ability-v2-outcome-roll data-part-id="${escAttr(part.partId)}" data-component-id="${escAttr(component.componentId)}"><i class="fa-solid fa-dice"></i><span>${esc(outcomeButtonLabel(component))}</span></button>`;
  }
  const activeDice = pool.parts.filter(entry => entry.kind === "die" && !entry.excluded);
  const currentDegrees = componentTargetResults(part, component).map(result => resultSnapshotDegree(result)).filter(Boolean);
  const profileStale = component.metadata?.profileDriven && pool.metadata?.rolledForDegree
    && currentDegrees.some(degree => degree !== pool.metadata.rolledForDegree);
  return `<div class="fast-nri-qa-reroll-editor" data-pool-id="${escAttr(pool.poolId)}">
    <div class="fast-nri-qa-stage-title">${esc(component.label || component.type)} · ${esc(pool.formula || "бросок")}${pool.metadata?.sharedOutcome ? " · общий пул" : ""}</div>
    ${profileStale ? `<div class="fast-nri-qa-warning">Степень одной из целей изменилась после сохранённого броска профиля. Foundry не перебрасывает результат автоматически; при необходимости явно нажмите «Перебросить результат».</div>` : ""}
    ${pool.parts.map(entry => `<div class="fast-nri-qa-final-die-row ${entry.excluded ? "fast-nri-qa-die-excluded" : ""}">
      <span>${entry.kind === "die" ? `d${esc(entry.faces)}` : "фикс."} = <strong>${esc(entry.value)}</strong>${entry.excluded ? " · исключён" : ""}</span>
      <span class="fast-nri-qa-row-actions">
        ${entry.kind === "die" && !entry.excluded ? `<button type="button" data-fast-nri-ability-v2-outcome-reroll data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-faces="${escAttr(entry.faces)}"><span>Переброс</span></button>` : ""}
        ${entry.kind === "die" ? `<button type="button" data-fast-nri-ability-v2-outcome-toggle data-pool-id="${escAttr(pool.poolId)}" data-part-value-id="${escAttr(entry.partId)}" data-excluded="${entry.excluded ? "true" : "false"}"><span>${entry.excluded ? "Вернуть" : "Исключить"}</span></button>` : ""}
      </span>
    </div>`).join("")}
    <div class="fast-nri-damage-actions">
      <button type="button" data-fast-nri-ability-v2-outcome-reroll-all data-pool-id="${escAttr(pool.poolId)}" ${activeDice.length ? "" : "disabled"}><i class="fa-solid fa-dice"></i><span>Перебросить все кубы</span></button>
      <button type="button" data-fast-nri-ability-v2-outcome-roll data-part-id="${escAttr(part.partId)}" data-component-id="${escAttr(component.componentId)}"><i class="fa-solid fa-rotate"></i><span>Перебросить результат</span></button>
    </div>
  </div>`;
}

function areaButtonsHTML(part) {
  const presets = Array.from(part.metadata?.areaPresets ?? []);
  if (!presets.length) return "";
  return `<div class="fast-nri-qa-target-actions">${presets.map(area => `<button type="button" data-fast-nri-ability-v2-area data-part-id="${escAttr(part.partId)}" data-area-id="${escAttr(area.id)}"><i class="fa-solid fa-draw-polygon"></i><span>${esc(area.label || "Разместить область")}</span></button>`).join("")}</div>`;
}

function partHTML(state, part, { resolution = false } = {}) {
  const declarationRoll = registeredDeclarationRoll(state, part);
  const declarationLine = part.declaration.rollMode === "none"
    ? `<div>Атака/проверка: <strong>не требуется</strong></div>`
    : declarationRoll?.status === "rolled"
      ? `<div>Атака/проверка: <strong>${esc(declarationRoll.formula || part.declaration.formula || "—")} = ${esc(declarationRoll.total ?? "—")}</strong>${declarationRoll.naturalD20 ? ` · d20=${esc(declarationRoll.naturalD20)}` : ""}</div>`
      : `<div>Атака/проверка: <strong>${esc(part.declaration.formula || "настроенная проверка")}</strong> · будет брошена после заявления действия.</div>`;
  return `<section class="fast-nri-qa-stage fast-nri-v2-part" data-part-id="${escAttr(part.partId)}">
    <div class="fast-nri-v2-part-title"><strong>${esc(part.label)}</strong></div>
    ${declarationLine}
    ${areaButtonsHTML(part)}
    ${part.targetSlots.map(slot => slotHTML(state, part, slot, { resolution })).join("")}
    ${resolution ? `<section class="fast-nri-qa-stage"><div class="fast-nri-qa-stage-title">Дополнительный результат</div>${part.outcomeComponents.map(component => poolEditorHTML(state, part, component)).join("")}</section>` : ""}
  </section>`;
}

function cardHeader(item, runtime, phase) {
  const kind = v2SourceKind(item, runtime);
  const icon = kind === "weapon"
    ? "fa-swords"
    : kind === "spell"
      ? "fa-wand-magic-sparkles"
      : kind === "maneuver"
        ? "fa-hand-fist"
        : kind === "skill"
          ? "fa-dice-d20"
          : "fa-bolt";
  const label = kind === "weapon" ? "Атака оружием"
    : kind === "spell" ? "Заклинание"
      : kind === "maneuver" ? "Манёвр"
        : kind === "skill" ? "Действие навыка"
          : "Способность";
  const implementation = ["weapon", "maneuver", "skill"].includes(kind) ? "" : ` — ${esc(runtime.implementationName || "Основная реализация")}`;
  return `<div class="fast-nri-chat-roll-title"><i class="fa-solid ${icon}"></i><strong>${esc(item.name)}${implementation}</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>${label}</span><span>${esc(phase)}</span></div>`;
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
  if (!part || !component || component.type === "effect") return next;
  const selected = sourcesForOutcomeComponent(part, component);
  const sources = selected.sources;
  const parts = [];
  const formulas = [];
  const declarationRoll = registeredDeclarationRoll(next, part);
  const criticalMultiplier = component.type === "damage"
    && Array.from(part.metadata?.traitIds ?? next.definition?.traits ?? []).includes("attack")
    && part.declaration.targetCharacteristic === "armor"
    && Number(declarationRoll?.naturalD20) === 20 ? 2 : 1;
  for (const source of sources) {
    if (!source.formula) continue;
    const roll = await evaluatedRoll(source.formula);
    formulas.push(source.formula);
    parts.push(...rollParts(roll, {
      componentId: component.componentId,
      traitIds: source.traitIds,
      damageType: source.damageType,
      formulaComponentIndex: source.index,
      criticalMultiplier
    }).map((value, index) => ({ ...value, partId: `${component.componentId}-${source.index}-${index}` })));
  }
  next = registerOutcomePool(next, {
    poolId: `pool-${part.partId}-${component.componentId}`,
    partId: part.partId,
    componentId: component.componentId,
    formula: formulas.join(" + "),
    parts,
    allocation: { mode: "none" },
    metadata: {
      adapterId: next.metadata?.adapterId ?? "action-v2-outcome",
      rolledForDegree: selected.degree,
      sharedOutcome: part.targetSlots.some(slot => slot.selections.length > 1) || Boolean(part.metadata?.area)
    }
  });
  return bindAbilityV2OutcomePools(next, part.partId);
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
  if (!actor) return {};
  const sourceKind = String(message?.getFlag?.("fast-nri", "v2SourceKind") ?? "");
  if (["maneuver", "skill"].includes(sourceKind)) {
    const source = message?.getFlag?.("fast-nri", "v2SyntheticSource") ?? {};
    const runtimeSnapshot = message?.getFlag?.("fast-nri", "v2RuntimeSnapshot") ?? null;
    if (!runtimeSnapshot) return {};
    const item = {
      uuid: null,
      id: source.id ?? runtimeSnapshot.implementationId ?? null,
      type: sourceKind,
      name: source.name ?? runtimeSnapshot.implementationName ?? "Действие",
      parent: actor,
      system: runtimeSnapshot.system ?? {}
    };
    const runtime = { ...runtimeSnapshot, parent: actor, v2SourceKind: sourceKind };
    return { actor, item, runtime };
  }
  const item = await globalThis.fromUuid?.(message?.getFlag?.("fast-nri", "itemUuid"));
  if (!item || !["ability", "weapon"].includes(item.type)) return {};
  const runtime = item.type === "weapon"
    ? weaponV2Runtime(actor, item)
    : abilityImplementationRuntime(item, message.getFlag?.("fast-nri", "implementationId") ?? null);
  return { actor, item, runtime };
}

async function startV2Runtime(actor, item, runtime, { parentMessageId = null, resource = null } = {}) {
  const eligibility = abilityV2AdapterEligibility(runtime);
  if (!eligibility.eligible) return null;
  const sourceKind = v2SourceKind(item, runtime);
  const normalizedResource = resource ?? { cost: 0, before: 0, after: 0, spent: 0, shortage: 0, label: "Классовый ресурс" };
  const definition = abilityActionDefinitionV2(actor, item, runtime);
  let state = createActionState({
    actionContext: actionContextForImplementation(actor, item, runtime),
    definition,
    metadata: {
      adapterId: sourceKind === "weapon"
        ? "weapon-v2-0.5.78"
        : ["maneuver", "skill"].includes(sourceKind)
          ? "system-action-v2-0.5.79"
          : eligibility.kinds.includes("damage") || abilityCheckConfig(runtime).enabled ? "ability-v2-check-damage" : "ability-v2-health",
      itemUuid: item?.uuid ?? null,
      implementationId: runtime.implementationId,
      parentMessageId,
      sourceKind,
      ...(sourceKind === "weapon" ? { weaponAttackTerm: runtime.weaponAttackTerm ?? null } : {})
    }
  });

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

  const parentMessage = parentMessageId ? globalThis.game?.messages?.get?.(parentMessageId) ?? null : null;
  const periodicRemovalEffectUuid = sourceKind === "ability" || sourceKind === "spell"
    ? parentMessage?.getFlag?.("fast-nri", "periodicRemovalEffectUuid") ?? null
    : null;
  const periodicRemovalSourceTickMessageId = sourceKind === "ability" || sourceKind === "spell"
    ? parentMessage?.getFlag?.("fast-nri", "periodicRemovalSourceTickMessageId") ?? null
    : null;
  const message = await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker({ actor }),
    content: abilityV2DeclarationCardHTML(state, { item, runtime, resource: normalizedResource }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_DECLARATION_KIND,
        actorUuid: actor.uuid,
        itemUuid: item?.uuid ?? null,
        implementationId: runtime.implementationId,
        v2SourceKind: sourceKind,
        ...(["maneuver", "skill"].includes(sourceKind) ? {
          v2SyntheticSource: { id: item?.id ?? runtime.implementationId, name: item?.name ?? runtime.implementationName, type: sourceKind },
          v2RuntimeSnapshot: {
            implementationId: runtime.implementationId,
            implementationName: runtime.implementationName,
            v2SourceKind: sourceKind,
            system: runtime.system
          }
        } : {}),
        parentMessageId,
        periodicRemovalEffectUuid,
        periodicRemovalSourceTickMessageId,
        resourceUndone: false,
        ...normalizedResource,
        actionState: state
      }
    }
  });
  await persistDeclaration(message, state, { item, runtime, resource: normalizedResource });
  return { message, actor, item, runtime, resource: normalizedResource, actionState: state, adapter: sourceKind === "weapon" ? "weapon-v2" : "v2" };
}

export async function startAbilityV2Implementation(actor, item, implementationId, { parentMessageId = null } = {}) {
  const runtime = abilityImplementationRuntime(item, implementationId);
  const eligibility = abilityV2AdapterEligibility(runtime);
  if (!eligibility.eligible) return null;
  const resource = await spendResource(actor, runtime);
  return startV2Runtime(actor, item, runtime, { parentMessageId, resource });
}

export async function startWeaponAttackV2(actor, weapon, { parentMessageId = null } = {}) {
  if (!actor || !weapon || weapon.type !== "weapon") return null;
  if (!itemIsEquipped(weapon)) {
    globalThis.ui?.notifications?.warn?.(`«${weapon.name}» не экипировано и сейчас не доступно для использования.`);
    return null;
  }
  if (itemRequiresHands(weapon) && !itemIsHeld(weapon)) {
    globalThis.ui?.notifications?.warn?.(`«${weapon.name}» требует рук, но не отмечено как «В руках».`);
    return null;
  }
  if (!itemIsUsable(weapon)) return null;
  const runtime = weaponV2Runtime(actor, weapon);
  return startV2Runtime(actor, weapon, runtime, { parentMessageId });
}

export async function startSystemActionV2(actor, descriptor, { parentMessageId = null } = {}) {
  if (!actor || !descriptor || !["maneuver", "skill"].includes(String(descriptor.sourceKind))) return null;
  const sourceKind = String(descriptor.sourceKind);
  const runtime = {
    implementationId: String(descriptor.id ?? `${sourceKind}-action`),
    implementationName: String(descriptor.name ?? "Действие"),
    name: String(descriptor.name ?? "Действие"),
    v2SourceKind: sourceKind,
    parent: actor,
    system: descriptor.system ?? {}
  };
  const item = {
    uuid: null,
    id: runtime.implementationId,
    type: sourceKind,
    name: runtime.implementationName,
    parent: actor,
    system: runtime.system
  };
  return startV2Runtime(actor, item, runtime, { parentMessageId });
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
    const resolved = resolveAllPartTargetDegrees(next, abilityV2DegreeResolver(item.parent ?? null, runtime));
    const rebound = bindAbilityV2OutcomePools(resolved, partId);
    await persistResolution(message, rebound, { item, runtime });
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


async function resolvePeriodicRemovalFromV2(message, state) {
  const effectUuid = message?.getFlag?.("fast-nri", "periodicRemovalEffectUuid") ?? null;
  if (!effectUuid) return null;
  const degrees = state.parts.flatMap(part => part.targetResults.map(result => result.degreeState?.baseDegree).filter(Boolean));
  const degree = degrees.includes("great") ? "great" : degrees.includes("success") ? "success" : null;
  if (!degree) return null;
  const { resolvePeriodicRemovalAbilitySuccess } = await import("./periodic-damage.mjs");
  return resolvePeriodicRemovalAbilitySuccess({ effectUuid, degree, sourceCheckMessageId: message.id });
}

async function resolveDeclaration(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_DECLARATION_KIND) return;
  const { actor, item, runtime } = await itemRuntimeFromMessage(message);
  if (!actor || !item || !runtime) return;
  const resolvedState = state.parts.some(part => part.declaration.rollMode !== "none")
    ? await rollDeclarationChecks(state, actor, runtime)
    : state;
  const resolution = await globalThis.ChatMessage.create({
    speaker: globalThis.ChatMessage.getSpeaker({ actor: item.parent ?? null }),
    content: abilityV2ResolutionCardHTML(resolvedState, { item, runtime }),
    flags: {
      "fast-nri": {
        kind: ABILITY_V2_RESOLUTION_KIND,
        actorUuid: message.getFlag("fast-nri", "actorUuid"),
        itemUuid: item?.uuid ?? null,
        implementationId: runtime.implementationId,
        v2SourceKind: message.getFlag("fast-nri", "v2SourceKind") ?? v2SourceKind(item, runtime),
        v2SyntheticSource: message.getFlag("fast-nri", "v2SyntheticSource") ?? null,
        v2RuntimeSnapshot: message.getFlag("fast-nri", "v2RuntimeSnapshot") ?? null,
        abilityV2DeclarationMessageId: message.id,
        actionState: resolvedState
      }
    }
  });
  await persistResolution(resolution, resolvedState, { item, runtime });
  await persistDeclaration(message, resolvedState, { item, runtime, resource: flagsResource(message), resolutionMessageId: resolution.id });
  await resolvePeriodicRemovalFromV2(message, resolvedState);
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
  let next = rerollRegisteredOutcomePart(state, { poolId: element.dataset.poolId, partId: element.dataset.partValueId, value });
  const pool = next.poolRegistry.find(entry => entry.poolId === element.dataset.poolId);
  if (pool?.partId) next = bindAbilityV2OutcomePools(next, pool.partId);
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
  next = bindAbilityV2OutcomePools(next, pool.partId);
  await persistResolution(message, next, { item, runtime });
}

async function toggleOutcomeDie(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  let next = setRegisteredOutcomePartExcluded(state, {
    poolId: element.dataset.poolId,
    partId: element.dataset.partValueId,
    excluded: element.dataset.excluded !== "true",
    reason: "manual"
  });
  const pool = next.poolRegistry.find(entry => entry.poolId === element.dataset.poolId);
  if (pool?.partId) next = bindAbilityV2OutcomePools(next, pool.partId);
  await persistResolution(message, next, { item, runtime });
}


function liveTokenForSelection(selection) {
  const uuid = String(selection?.tokenUuid ?? "").trim();
  if (uuid) {
    try {
      const document = globalThis.fromUuidSync?.(uuid);
      if (document?.actor) return document.object ?? document;
    } catch (_error) { /* fall through */ }
    const live = Array.from(globalThis.canvas?.tokens?.placeables ?? []).find(token =>
      (token?.document?.uuid ?? token?.uuid) === uuid
    );
    if (live?.actor) return live;
  }
  return null;
}

function traitsObjectFromIds(ids = []) {
  const set = new Set(Array.from(ids ?? []).map(String));
  return {
    attack: set.has("attack"),
    melee: set.has("melee"),
    ranged: set.has("ranged"),
    area: set.has("area"),
    intervention: set.has("intervention")
  };
}

function partDefenseActionContext(state, part) {
  const roll = registeredDeclarationRoll(state, part);
  const check = part.metadata?.checkConfig ?? {};
  return normalizeActionContext({
    ...state.actionContext,
    traitIds: Array.from(part.metadata?.traitIds ?? []),
    traits: traitsObjectFromIds(part.metadata?.traitIds ?? []),
    check: {
      enabled: Boolean(check.enabled),
      formula: check.formula,
      targetCharacteristic: check.targetCharacteristic,
      total: roll?.total ?? null,
      naturalD20: roll?.naturalD20 ?? null
    },
    defenseProcedures: Object.fromEntries(part.defenseProcedureIds.map(id => [id, true])),
    defenseProcedure: { directedDefense: part.defenseProcedureIds.includes("directed") }
  });
}

function defenseCharacteristicForPart(part, procedure, role, config = {}) {
  if (procedure === "dodge") return "reflex";
  if (procedure === "counteraction") return String(part.metadata?.checkConfig?.targetCharacteristic ?? "reflex");
  if (role === "ally") return "fortitude";
  if (["fortitude", "reflex"].includes(config?.selfDefenseCharacteristic)) return config.selfDefenseCharacteristic;
  const ids = new Set(Array.from(part.metadata?.traitIds ?? []));
  if (ids.has("ranged")) return "reflex";
  return "fortitude";
}

export function actionV2DamageSelectionMode(sourceItem, config = {}) {
  const configuredSelection = String(config?.damageSelectionMode ?? "standard");
  if (["largest", "smallest"].includes(configuredSelection)) return configuredSelection;
  const sourceProperties = new Set(Array.from(sourceItem?.system?.propertyIds ?? []).map(String));
  return sourceItem?.type === "weapon" && sourceProperties.has("steady") ? "smallest" : "largest";
}

function defenseRuleData({ part, option, role, characteristic, attackTotal, sourceNaturalD20, combatFormula, sourceItem = null, result = null, dodgeReduction = 1 } = {}) {
  const damageSelectionMode = actionV2DamageSelectionMode(sourceItem, option.config);
  return {
    procedure: option.procedure,
    role,
    characteristic,
    attackTotal: finiteNumberOrNull(attackTotal),
    sourceNaturalD20: finiteNumberOrNull(sourceNaturalD20),
    combatFormula: String(combatFormula ?? "").trim(),
    removeDamageParts: Math.max(0, Number(option.config?.removeDamageParts) || (option.procedure === "directed" ? 1 : 0)),
    damageSelectionMode,
    effectDegreeReduction: Math.max(0, Number(option.config?.effectDegreeReduction) || 1),
    dodgeReduction: Math.max(1, Number(dodgeReduction) || 1),
    result
  };
}

/** Pure rule mapping from one stored defense roll to one ResolutionStep operation. */
export function abilityV2DefenseOperation({
  procedure,
  defenseTotal,
  naturalD20,
  attackTotal,
  sourceNaturalD20 = null,
  removeDamageParts = 1,
  damageSelectionMode = "largest",
  effectDegreeReduction = 1,
  dodgeReduction = 1,
  defenseRule = {}
} = {}) {
  const defense = finiteNumberOrNull(defenseTotal);
  const attack = finiteNumberOrNull(attackTotal);
  const natural = finiteNumberOrNull(naturalD20);
  let result = "failure";
  let fullCancel = false;
  let degreeReduction = 0;

  if (natural !== 1) {
    if (procedure === "directed" && natural === 20) {
      if (Number(sourceNaturalD20) === 20) result = "success";
      else { result = "success"; fullCancel = true; }
    } else if (["counteraction", "dodge"].includes(procedure) && natural === 20) {
      result = "success";
      fullCancel = true;
    } else if (defense !== null && attack !== null && defense >= attack) {
      result = "success";
    }
  }

  const rule = { ...defenseRule, procedure, result, fullCancel };
  if (result !== "success") return { result, fullCancel: false, degreeReduction: 0, operation: { resolverId: "noop", params: { defenseRule: rule } } };
  if (fullCancel) return { result, fullCancel: true, degreeReduction: 99, operation: { resolverId: "ability-full-cancel", params: { defenseRule: rule } } };

  if (procedure === "directed") {
    const operations = [];
    const remove = Math.max(0, Number(removeDamageParts) || 0);
    if (remove) operations.push({ resolverId: "ability-remove-largest-damage-parts", params: { count: remove, mode: damageSelectionMode === "smallest" ? "smallest" : "largest" } });
    const lowerEffect = Math.max(0, Number(effectDegreeReduction) || 0);
    if (lowerEffect) operations.push({ resolverId: "lower-effect-degree", params: { steps: lowerEffect } });
    return {
      result,
      fullCancel: false,
      degreeReduction: 0,
      operation: { resolverId: "sequence", params: { operations, defenseRule: rule } }
    };
  }

  degreeReduction = procedure === "dodge"
    ? Math.max(1, Number(dodgeReduction) || 1)
    : Math.max(1, Number(effectDegreeReduction) || 1);
  return {
    result,
    fullCancel: false,
    degreeReduction,
    operation: {
      resolverId: "ability-lower-whole-degree",
      params: { steps: degreeReduction, defenseRule: { ...rule, degreeReduction } }
    }
  };
}

async function chooseAbilityV2Defense(options, { defenderToken, protectedName } = {}) {
  const { DialogV2 } = globalThis.foundry?.applications?.api ?? {};
  if (!DialogV2) return options.find(option => !option.disabled) ?? null;
  const enabled = options.filter(option => !option.disabled);
  if (!enabled.length) {
    globalThis.ui?.notifications?.warn?.("Нет доступной Защиты для выбранного защитника.");
    return null;
  }
  const buttons = enabled.map(option => ({
    action: option.id,
    label: option.actionName,
    icon: "fa-solid fa-shield-halved",
    callback: async () => option.id
  }));
  buttons.push({ action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", callback: async () => null });
  const selected = await DialogV2.wait({
    window: { title: "Выбор Защиты" },
    content: `<div><strong>Защитник:</strong> ${esc(defenderToken?.name || "—")}</div><div><strong>Цель:</strong> ${esc(protectedName || "—")}</div><small>Вмешательство, Движение и Воздействие не списываются автоматически. Предупреждения правил не превращаются в hard block.</small>`,
    modal: true,
    rejectClose: false,
    buttons
  });
  return enabled.find(option => option.id === selected) ?? null;
}

async function chooseAbilityV2DodgeReduction() {
  const { DialogV2 } = globalThis.foundry?.applications?.api ?? {};
  if (!DialogV2) return 1;
  return Number(await DialogV2.wait({
    window: { title: "Уворот: итог перемещения" },
    content: `<p>Foundry не перемещает токен автоматически. Укажите итог после ручного перемещения.</p>`,
    modal: true,
    rejectClose: false,
    buttons: [
      { action: "inside", label: "Остался под областью · −1 степень", callback: async () => 1 },
      { action: "safe", label: "Достиг безопасной клетки · −2 степени", callback: async () => 2 },
      { action: "cancel", label: "Отмена", callback: async () => null }
    ]
  })) || 0;
}

async function chooseAbilityV2DefenseClassResourceCost(actor, option) {
  const source = option?.runtime ?? option?.item ?? null;
  if (!source) return 0;
  const costs = abilityCosts(source);
  const min = Math.max(0, Number(costs.classResourceMin ?? costs.classResource) || 0);
  const max = Math.max(min, Number(costs.classResourceMax ?? min) || min);
  if (max <= min) return min;
  const { DialogV2 } = globalThis.foundry?.applications?.api ?? {};
  if (!DialogV2) return min;
  const selected = await DialogV2.wait({
    window: { title: `${option?.actionName || "Защита"}: расход ресурса` },
    content: `<p>Выберите количество «${esc(actor?.system?.classResource?.label || "Классового ресурса")}": <strong>${esc(min)}–${esc(max)}</strong>.</p>`,
    modal: true,
    rejectClose: false,
    buttons: [
      ...Array.from({ length: max - min + 1 }, (_value, index) => min + index).map(amount => ({
        action: `defense-cost-${amount}`,
        label: `${amount}`,
        callback: async () => amount
      })),
      { action: "cancel", label: "Отмена", callback: async () => null }
    ]
  });
  return selected === null || selected === undefined ? null : Math.max(min, Math.min(max, Number(selected) || min));
}

async function spendAbilityV2DefenseClassResource(actor, option, selectedCost = 0) {
  const source = actor?.system?.classResource ?? {};
  const cost = Math.max(0, Number(selectedCost) || 0);
  const before = Math.max(0, Number(source.value) || 0);
  const max = Math.max(0, Number(source.max) || 0);
  const shortage = Math.max(0, cost - before);
  if (shortage > 0) {
    globalThis.ui?.notifications?.warn?.(`${actor.name}: недостаточно ресурса «${source.label || "Классовый ресурс"}». Нужно ${cost}, доступно ${before}. Защита не блокируется.`);
  }
  const after = Math.max(0, before - cost);
  const spent = before - after;
  if (cost > 0) {
    try {
      await actor.update({ "system.classResource.value": after });
    } catch (error) {
      console.error("Быстрая НРИ | Ошибка списания ресурса Защиты Ability v2", error);
      globalThis.ui?.notifications?.error?.("Не удалось изменить классовый ресурс; Защита всё равно разрешена.");
      return { cost, label: source.label || "Классовый ресурс", before, after: before, spent: 0, shortage, max, updateFailed: true, resourceUndone: false };
    }
  }
  return { cost, label: source.label || "Классовый ресурс", before, after, spent, shortage, max, resourceUndone: false };
}

async function restoreAbilityV2DefenseResource(step) {
  const resource = step?.operation?.params?.resource ?? null;
  const spent = Math.max(0, Number(resource?.spent) || 0);
  if (!resource || !(spent > 0) || resource.resourceUndone) return { restored: false, resource };
  const actor = step?.actor?.actorUuid ? await globalThis.fromUuid?.(step.actor.actorUuid) : null;
  if (!actor) {
    globalThis.ui?.notifications?.warn?.("Не удалось найти защитника для возврата классового ресурса.");
    return { restored: false, resource };
  }
  const current = Math.max(0, Number(actor.system?.classResource?.value) || 0);
  const max = Math.max(0, Number(resource.max) || Number(actor.system?.classResource?.max) || 0);
  const restoredTo = max > 0 ? Math.min(max, current + spent) : current + spent;
  await actor.update({ "system.classResource.value": restoredTo });
  resource.resourceUndone = true;
  resource.resourceRestoredTo = restoredTo;
  return { restored: true, resource, actor, restoredTo };
}

async function prepareAbilityV2DefenseRoll(actor, rule, actionName, { additionalModifiers = [] } = {}) {
  const characteristicValue = finiteNumberOrNull(actor?.system?.defenses?.[rule.characteristic]);
  if (characteristicValue === null) {
    globalThis.ui?.notifications?.error?.(`Нет корректного значения защиты «${rule.characteristic}».`);
    return null;
  }
  const combat = String(rule.combatFormula ?? "").trim();
  const baseFormula = combat ? `1d20 + ${characteristicValue} + ${combat}` : `1d20 + ${characteristicValue}`;
  return prepareRoll({
    actor,
    label: `${actionName}: ${actor.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: actionName },
      { formula: String(characteristicValue), label: rule.characteristic, reason: actor.name },
      ...(combat ? [{ formula: combat, label: "Куб боя", reason: "Защитное действие" }] : [])
    ],
    showDC: false,
    additionalModifiers,
    contextHTML: `<div><strong>${esc(actionName)}</strong> · исходный результат ${esc(rule.attackTotal ?? "—")}</div>`
  });
}

async function addDefenseFromResolution(element) {
  const message = messageFromElement(element);
  let state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const part = state.parts.find(entry => entry.partId === element.dataset.partId);
  const slot = part?.targetSlots.find(entry => entry.slotId === element.dataset.slotId);
  const selection = slot?.selections.find(entry => entry.selectionId === element.dataset.selectionId);
  const resultEntry = part?.targetResults.find(entry => entry.targetSlotId === slot?.slotId && entry.selectionId === selection?.selectionId);
  if (!part || !slot || !selection || !resultEntry?.targetResult) return;

  const defenders = currentControlledTokens();
  if (defenders.length !== 1) {
    globalThis.ui?.notifications?.warn?.("Для Защиты выделите ровно один токен-защитник.");
    return;
  }
  const defenderToken = defenders[0];
  let protectedToken = liveTokenForSelection(selection);
  const role = defenderToken?.actor?.uuid === selection.actorUuid ? "self" : "ally";
  if (role === "self") protectedToken = defenderToken;
  if (!protectedToken) {
    globalThis.ui?.notifications?.warn?.("Защищаемая цель должна быть токеном на текущей сцене.");
    return;
  }

  const actionContext = partDefenseActionContext(state, part);
  const target = normalizeTargetResult(resultEntry.targetResult);
  const defenseHistory = target.steps.map(step => ({ actorUuid: step.actor?.actorUuid, tokenUuid: step.actor?.tokenUuid }));
  const options = resolveDefenseOptionsForToken({
    defenderToken,
    protectedToken,
    role,
    actionContext,
    defenseHistory,
    procedures: part.defenseProcedureIds
  });
  const option = await chooseAbilityV2Defense(options, { defenderToken, protectedName: selectionName(selection) });
  if (!option) return;
  for (const warning of option.warnings ?? []) globalThis.ui?.notifications?.warn?.(`${option.actionName}: ${warning}`);
  const selectedClassResourceCost = await chooseAbilityV2DefenseClassResourceCost(defenderToken.actor, option);
  if (selectedClassResourceCost === null) return;

  const characteristic = defenseCharacteristicForPart(part, option.procedure, role, option.config);
  const combat = resolveDefenseCombatSource(defenderToken.actor, option.runtime ?? option.item, role);
  const declaration = registeredDeclarationRoll(state, part);
  const baseRule = defenseRuleData({
    part,
    option,
    role,
    characteristic,
    attackTotal: declaration?.total,
    sourceNaturalD20: declaration?.naturalD20,
    combatFormula: combat?.formula,
    sourceItem: item
  });
  const contextualModifiers = selfDefenseContextualModifiers(defenderToken.actor, item, target.current.effectDegree);
  const rolled = await prepareAbilityV2DefenseRoll(defenderToken.actor, baseRule, option.actionName, { additionalModifiers: contextualModifiers });
  if (!rolled) return;
  let dodgeReduction = 1;
  const preliminary = Number(rolled.naturalD20) === 20
    || (Number(rolled.naturalD20) !== 1 && Number(rolled.roll?.total) >= Number(baseRule.attackTotal));
  if (option.procedure === "dodge" && preliminary && Number(rolled.naturalD20) !== 20) {
    dodgeReduction = await chooseAbilityV2DodgeReduction();
    if (!dodgeReduction) return;
  }
  const rule = { ...baseRule, dodgeReduction };
  const resource = await spendAbilityV2DefenseClassResource(defenderToken.actor, option, selectedClassResourceCost);
  const resolved = abilityV2DefenseOperation({
    ...rule,
    defenseTotal: rolled.roll?.total,
    naturalD20: rolled.naturalD20,
    defenseRule: rule
  });
  resolved.operation.params.defenseRule = {
    ...(resolved.operation.params.defenseRule ?? rule),
    ...rule,
    result: resolved.result,
    fullCancel: resolved.fullCancel,
    degreeReduction: resolved.degreeReduction
  };
  resolved.operation.params.resource = resource;

  state = appendPartResolutionStep(state, part.partId, slot.slotId, selection.selectionId, {
    stepId: randomId("defense"),
    type: option.procedure,
    actor: {
      actorUuid: defenderToken.actor.uuid,
      tokenUuid: defenderToken.document?.uuid ?? defenderToken.uuid ?? null,
      name: defenderToken.name ?? defenderToken.actor.name
    },
    actionRef: {
      itemUuid: option.item?.uuid ?? null,
      name: option.actionName,
      procedureId: option.procedure
    },
    actionContext,
    roll: rollStateFromRoll(rolled.roll, rolled.formula),
    operation: resolved.operation
  }, { operationResolvers: ABILITY_V2_OPERATION_RESOLVERS });
  await persistResolution(message, state, { item, runtime });
}

async function rerollDefenseFromResolution(element) {
  const message = messageFromElement(element);
  let state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const part = state.parts.find(entry => entry.partId === element.dataset.partId);
  const entry = part?.targetResults.find(result => result.targetSlotId === element.dataset.slotId && result.selectionId === element.dataset.selectionId);
  const step = entry?.targetResult ? normalizeTargetResult(entry.targetResult).steps.find(candidate => candidate.stepId === element.dataset.stepId) : null;
  const actor = step?.actor?.actorUuid ? await globalThis.fromUuid?.(step.actor.actorUuid) : null;
  const rule = step?.operation?.params?.defenseRule ?? null;
  if (!part || !entry || !step || !actor || !rule) return;
  const contextualModifiers = selfDefenseContextualModifiers(actor, item, entry.targetResult ? normalizeTargetResult(entry.targetResult).current.effectDegree : null);
  const rolled = await prepareAbilityV2DefenseRoll(actor, rule, step.actionRef?.name || "Защита", { additionalModifiers: contextualModifiers });
  if (!rolled) return;
  let dodgeReduction = rule.dodgeReduction ?? 1;
  const preliminary = Number(rolled.naturalD20) === 20
    || (Number(rolled.naturalD20) !== 1 && Number(rolled.roll?.total) >= Number(rule.attackTotal));
  if (rule.procedure === "dodge" && preliminary && Number(rolled.naturalD20) !== 20) {
    dodgeReduction = await chooseAbilityV2DodgeReduction();
    if (!dodgeReduction) return;
  }
  const nextRule = { ...rule, dodgeReduction };
  state = rerollPartResolutionStep(
    state,
    part.partId,
    entry.targetSlotId,
    entry.selectionId,
    step.stepId,
    rollStateFromRoll(rolled.roll, rolled.formula),
    {
      operationResolvers: ABILITY_V2_OPERATION_RESOLVERS,
      deriveOperation: ({ step: rerolledStep }) => {
        const resolved = abilityV2DefenseOperation({
          ...nextRule,
          defenseTotal: rerolledStep.roll?.total,
          naturalD20: rerolledStep.roll?.naturalD20,
          defenseRule: nextRule
        });
        resolved.operation.params.defenseRule = {
          ...(resolved.operation.params.defenseRule ?? nextRule),
          ...nextRule,
          result: resolved.result,
          fullCancel: resolved.fullCancel,
          degreeReduction: resolved.degreeReduction
        };
        resolved.operation.params.resource = rerolledStep.operation?.params?.resource ?? step.operation?.params?.resource ?? null;
        return resolved.operation;
      }
    }
  );
  await persistResolution(message, state, { item, runtime });
}

async function undoDefenseResourceFromResolution(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const part = state.parts.find(entry => entry.partId === element.dataset.partId);
  const resultEntry = part?.targetResults.find(entry => entry.targetSlotId === element.dataset.slotId && entry.selectionId === element.dataset.selectionId);
  const target = resultEntry?.targetResult ? normalizeTargetResult(resultEntry.targetResult) : null;
  const step = target?.steps.find(entry => entry.stepId === element.dataset.stepId) ?? null;
  if (!step) return;
  const restored = await restoreAbilityV2DefenseResource(step);
  if (!restored.restored) {
    globalThis.ui?.notifications?.info?.("Для этой Защиты ресурс уже возвращён или фактически не списывался.");
    return;
  }
  const liveStep = resultEntry.targetResult.steps.find(entry => entry.stepId === element.dataset.stepId);
  if (liveStep) liveStep.operation.params.resource = restored.resource;
  await persistResolution(message, state, { item, runtime });
}

async function undoDefenseFromResolution(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state || message.getFlag?.("fast-nri", "kind") !== ABILITY_V2_RESOLUTION_KIND) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const part = state.parts.find(entry => entry.partId === element.dataset.partId);
  const resultEntry = part?.targetResults.find(entry => entry.targetSlotId === element.dataset.slotId && entry.selectionId === element.dataset.selectionId);
  const step = resultEntry?.targetResult ? normalizeTargetResult(resultEntry.targetResult).steps.find(entry => entry.stepId === element.dataset.stepId) : null;
  if (step) await restoreAbilityV2DefenseResource(step);
  const next = removePartResolutionStep(
    state,
    element.dataset.partId,
    element.dataset.slotId,
    element.dataset.selectionId,
    element.dataset.stepId,
    { operationResolvers: ABILITY_V2_OPERATION_RESOLVERS }
  );
  await persistResolution(message, next, { item, runtime });
}

async function placeAreaFromAbilityV2(element) {
  const message = messageFromElement(element);
  const state = actionStateFromMessage(message);
  if (!message || !state) return;
  const { item, runtime } = await itemRuntimeFromMessage(message);
  if (!item || !runtime) return;
  const area = abilityAreaPresets(runtime).find(candidate => candidate.id === element.dataset.areaId);
  if (!area) return;
  await placeAbilityAreaPreset({
    item,
    implementationId: runtime.implementationId,
    area,
    actionContext: state.actionContext
  });
}

function finalLabel(type) {
  return type === "damage" ? "Урон"
    : type === "healing" ? "Исцеление"
      : type === "tempHp" ? "Временные HP"
        : type === "effect" ? "Эффект"
          : type === "maneuver" ? "Манёвр"
            : type === "manual" ? "Результат"
              : type;
}

function finalManualText(result) {
  const table = result?.metadata?.componentMetadata?.resultTextByDegree ?? {};
  const degree = result?.provenance?.resolution?.effectDegree ?? result?.provenance?.resolution?.degree ?? null;
  return String(table?.[degree] ?? result?.metadata?.componentMetadata?.resultText ?? "").trim();
}

export function abilityV2EffectUuidsFromFinal(rawFinalResult) {
  const result = normalizeFinalResultPackage(rawFinalResult);
  if (result.componentType !== "effect") return [];
  const metadata = result.metadata?.componentMetadata ?? {};
  const degree = result.provenance?.resolution?.effectDegree ?? null;
  return Array.from(new Set([
    ...Array.from(metadata.effectUuids ?? []),
    ...Array.from(degree ? metadata.effectUuidsByDegree?.[degree] ?? [] : [])
  ].map(String).filter(Boolean)));
}

function finalResultIsDamage(rawFinalResult) {
  return normalizeFinalResultPackage(rawFinalResult).componentType === "damage";
}

function finalDamageHasAutomaticCritical(rawFinalResult) {
  const result = normalizeFinalResultPackage(rawFinalResult);
  return result.componentType === "damage"
    && result.value.parts.some(part => Number(part.metadata?.criticalMultiplier) === 2);
}

function finalMessagesForBatch(batchId) {
  return Array.from(globalThis.game?.messages?.contents ?? globalThis.game?.messages ?? []).filter(message =>
    message?.getFlag?.("fast-nri", "kind") === ABILITY_V2_FINAL_KIND
    && message?.getFlag?.("fast-nri", "abilityV2FinalBatchId") === batchId
  );
}

function applicationReceiptsForBatch(batchId) {
  if (!batchId) return [];
  return Array.from(globalThis.game?.messages?.contents ?? globalThis.game?.messages ?? [])
    .filter(message =>
      message?.getFlag?.("fast-nri", "kind") === ABILITY_V2_APPLICATION_KIND
      && message?.getFlag?.("fast-nri", "abilityV2FinalBatchId") === batchId
    )
    .map(message => normalizeApplicationReceipt(message?.getFlag?.("fast-nri", "abilityV2ApplicationReceipt") ?? {}));
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

export function abilityV2FinalCardHTML(rawFinalResults, { finalResults = [], receipts = [] } = {}) {
  const values = (Array.isArray(rawFinalResults) ? rawFinalResults : [rawFinalResults]).filter(Boolean).map(normalizeFinalResultPackage);
  const allResults = finalResults.length ? finalResults.map(normalizeFinalResultPackage) : values;
  const batchId = values[0]?.batchId ?? "";
  return `<div class="fast-nri-chat-roll fast-nri-v2-final-card fast-nri-ability-v2-final-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid fa-list-check"></i><strong>Итог действия</strong></div>
    <div class="fast-nri-chat-roll-meta"><span>Одна Final/Application Card</span><span>${esc(values.length)} индивидуальн. результатов</span></div>
    ${values.map(result => {
      const amount = resolveFinalResultAmount(result, { finalResults: allResults });
      const recipient = result.provenance.recipient;
      const isDamage = finalResultIsDamage(result);
      const isEffect = result.componentType === "effect";
      const effectCount = isEffect ? abilityV2EffectUuidsFromFinal(result).length : 0;
      const manualText = ["manual", "maneuver"].includes(result.componentType) ? finalManualText(result) : "";
      const canApply = ["damage", "healing", "tempHp", "effect"].includes(result.componentType);
      const automaticCritical = finalDamageHasAutomaticCritical(result);
      const dependencyState = evaluateFinalResultDependencies(result, receipts);
      const dependencyWarning = result.dependencies.length && !dependencyState.ready
        ? `<div class="fast-nri-qa-warning">Зависимость ещё не подтверждена ApplicationReceipt исходного результата. Это предупреждение: применение не блокируется.</div>`
        : "";
      return `<section class="fast-nri-qa-stage fast-nri-v2-final-result-row" data-final-result-id="${escAttr(result.finalResultId)}">
        <div class="fast-nri-qa-stage-title"><strong>${esc(result.partLabel || "Результат")}</strong> · ${esc(result.componentLabel || finalLabel(result.componentType))}</div>
        <div>Назначено: <strong>${esc(recipient.name || recipient.actorUuid || recipient.tokenUuid || "не назначено")}</strong></div>
        <div class="fast-nri-qa-final-total">${esc(finalLabel(result.componentType))}: <strong>${esc(manualText || (isEffect ? `${effectCount} Effect` : amount))}</strong></div>
        ${!canApply && manualText ? `<div class="fast-nri-qa-warning">Результат показан для ручного исполнения; Foundry не выбирает перемещение, Захват или состояние за пользователя.</div>` : ""}
        ${dependencyWarning}
        ${automaticCritical ? `<div class="fast-nri-critical-roll"><i class="fa-solid fa-burst"></i><strong>Натуральная 20: при автоматическом применении крит ×2 учитывается автоматически</strong></div>` : ""}
        ${canApply ? `<div class="fast-nri-damage-actions fast-nri-v2-critical-apply-actions">
          <button type="button" data-fast-nri-ability-v2-final-apply-selected data-final-result-id="${escAttr(result.finalResultId)}" data-multiplier="1"><i class="fa-solid fa-crosshairs"></i><span>Применить по выбранному</span></button>
          ${isDamage ? `<button type="button" class="fast-nri-apply-damage-button fast-nri-apply-damage-x2" data-fast-nri-ability-v2-final-apply-selected data-final-result-id="${escAttr(result.finalResultId)}" data-multiplier="2" title="Применить этот урон ×2"><strong>×2</strong></button>` : ""}
        </div>` : ""}
      </section>`;
    }).join("")}
    ${allResults.some(result => ["damage", "healing", "tempHp", "effect"].includes(result.componentType)) ? `<div class="fast-nri-damage-actions fast-nri-v2-critical-apply-actions">
      <button type="button" data-fast-nri-ability-v2-final-apply-assigned data-batch-id="${escAttr(batchId)}" data-multiplier="1"><i class="fa-solid fa-check-double"></i><span>Применить по назначенным целям</span></button>
      ${allResults.some(finalResultIsDamage) ? `<button type="button" class="fast-nri-apply-damage-button fast-nri-apply-damage-x2" data-fast-nri-ability-v2-final-apply-assigned data-batch-id="${escAttr(batchId)}" data-multiplier="2" title="Применить ×2 ко всем потокам урона; остальные результаты останутся без множителя"><strong>×2</strong></button>` : ""}
    </div>` : ""}
  </div>`;
}

async function refreshFinalBatch(batchId) {
  const messages = finalMessagesForBatch(batchId);
  const receipts = applicationReceiptsForBatch(batchId);
  for (const message of messages) {
    const finals = finalResultsFromMessage(message);
    const content = abilityV2FinalCardHTML(finals, { finalResults: finals, receipts });
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

export function abilityV2DamageStateFromFinal(finalResult) {
  const result = normalizeFinalResultPackage(finalResult);
  return {
    supported: true,
    fullCancel: false,
    parts: result.value.parts.map(part => ({
      id: part.partId,
      kind: part.kind,
      faces: part.faces,
      value: part.value,
      currentValue: part.value,
      damageType: String(part.metadata?.damageType ?? "physical"),
      traitIds: Array.from(part.metadata?.traitIds ?? []),
      manualRemoved: Boolean(part.excluded),
      profileZeroed: false,
      defenseZeroed: false,
      immuneRemoved: false
    })),
    penalties: []
  };
}

export function resolveAbilityV2DamageForActor(finalResult, actor, multiplier = 1) {
  const result = normalizeFinalResultPackage(finalResult);
  const state = abilityV2DamageStateFromFinal(result);
  // Manual Application never inherits a multiplier implicitly.
  // The explicit ×2 control is always available for Damage as a soft-automation tool.
  const safeMultiplier = Number(multiplier) === 2 ? 2 : 1;
  return resolveDamageAgainstActor(state, actor, safeMultiplier);
}

export function automaticAbilityV2DamageMultiplier(finalResult) {
  return finalDamageHasAutomaticCritical(finalResult) ? 2 : 1;
}

export function resolveAbilityV2DamageForActorAutomatic(finalResult, actor) {
  return resolveAbilityV2DamageForActor(finalResult, actor, automaticAbilityV2DamageMultiplier(finalResult));
}

async function applyDamageFinalToActor(finalResult, actor, amount, multiplier = 1) {
  const resolution = resolveAbilityV2DamageForActor(finalResult, actor, multiplier);
  const resolvedAmount = Math.max(0, Number(resolution.finalDamage) || 0);
  const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
  const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
  const tempSpent = Math.min(previousTemp, resolvedAmount);
  const hpSpent = Math.min(previousHp, Math.max(0, resolvedAmount - tempSpent));
  const afterTemp = previousTemp - tempSpent;
  const afterHp = previousHp - hpSpent;
  await actor.update({
    "system.hp.temp": afterTemp,
    "system.hp.value": afterHp
  }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  return {
    requestedAmount: amount,
    appliedAmount: tempSpent + hpSpent,
    before: { hp: previousHp, tempHp: previousTemp },
    after: { hp: afterHp, tempHp: afterTemp },
    resolution
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


function cloneRuntimeValue(value) {
  if (value === undefined) return null;
  try { return structuredClone(value); }
  catch (_error) {
    try { return JSON.parse(JSON.stringify(value)); }
    catch (_second) { return null; }
  }
}

function actorEffectItems(actor) {
  return Array.from(actor?.items?.contents ?? actor?.items ?? []).filter(item => item?.type === "effect");
}

async function applyEffectFinalToActor(finalResult, actor, actionContext = null) {
  const uuids = abilityV2EffectUuidsFromFinal(finalResult);
  const sources = await resolveEffectDocuments(uuids);
  const applied = [];
  for (const source of sources) {
    const beforeItems = new Map(actorEffectItems(actor).map(effect => [effect.id, {
      id: effect.id,
      runtime: cloneRuntimeValue(effect.system?.runtime ?? {}),
      sourceUuid: String(effect.system?.sourceUuid ?? "")
    }]));
    const embedded = await applyEffectToActor(source, actor, { actionContext });
    if (!embedded) continue;
    const before = beforeItems.get(embedded.id) ?? null;
    applied.push({
      effectId: embedded.id,
      sourceUuid: source.uuid ?? null,
      existedBefore: Boolean(before),
      beforeRuntime: before?.runtime ?? null,
      afterRuntime: cloneRuntimeValue(embedded.system?.runtime ?? {})
    });
  }
  return {
    requestedAmount: uuids.length,
    appliedAmount: applied.length,
    before: { effects: applied.map(entry => ({ effectId: entry.effectId, existedBefore: entry.existedBefore, runtime: entry.beforeRuntime })) },
    after: { effects: applied.map(entry => ({ effectId: entry.effectId, runtime: entry.afterRuntime })) },
    resolution: { effectUuids: uuids, applied }
  };
}

export function abilityV2HealthUndoPlan(rawReceipt, actor) {
  const receipt = normalizeApplicationReceipt(rawReceipt);
  const currentHp = Math.max(0, Number(actor?.system?.hp?.value) || 0);
  const currentTemp = Math.max(0, Number(actor?.system?.hp?.temp) || 0);
  if (receipt.componentType === "damage") {
    const expectedHp = Math.max(0, Number(receipt.after?.hp) || 0);
    const expectedTemp = Math.max(0, Number(receipt.after?.tempHp) || 0);
    if (currentHp !== expectedHp || currentTemp !== expectedTemp) return { ok: false, reason: "hp-changed" };
    return { ok: true, update: {
      "system.hp.value": Math.max(0, Number(receipt.before?.hp) || 0),
      "system.hp.temp": Math.max(0, Number(receipt.before?.tempHp) || 0)
    } };
  }
  if (receipt.componentType === "healing") {
    const expectedHp = Math.max(0, Number(receipt.after?.hp) || 0);
    if (currentHp !== expectedHp) return { ok: false, reason: "hp-changed" };
    return { ok: true, update: { "system.hp.value": Math.max(0, Number(receipt.before?.hp) || 0) } };
  }
  if (receipt.componentType === "tempHp") {
    const expectedTemp = Math.max(0, Number(receipt.after?.tempHp) || 0);
    if (currentTemp !== expectedTemp) return { ok: false, reason: "temp-hp-changed" };
    return { ok: true, update: { "system.hp.temp": Math.max(0, Number(receipt.before?.tempHp) || 0) } };
  }
  return { ok: false, reason: "unsupported" };
}

function applicationCardHTML(receipt, { provenanceName = null } = {}) {
  const value = normalizeApplicationReceipt(receipt);
  return `<div class="fast-nri-chat-roll fast-nri-ability-v2-application-card"><div class="fast-nri-chat-roll-title"><i class="fa-solid fa-receipt"></i><strong>${esc(value.recipient.name || "Получатель")} · ${esc(finalLabel(value.componentType))}</strong></div><div class="fast-nri-chat-roll-meta"><span>ApplicationReceipt</span><span>Final provenance: ${esc(provenanceName || "—")}</span></div><div class="fast-nri-qa-final-total">Запрошено: <strong>${esc(value.requestedAmount)}</strong> · применено: <strong>${esc(value.appliedAmount)}</strong></div>${value.undone ? `<div class="fast-nri-qa-warning">Отменено.</div>` : `<button type="button" data-fast-nri-ability-v2-application-undo><i class="fa-solid fa-rotate-left"></i><span>Отмена</span></button>`}</div>`;
}

async function createAbilityApplicationReceiptMessage(finalResult, token, actor, amount, mode, multiplier = 1) {
  if (!["damage", "healing", "tempHp", "effect"].includes(finalResult.componentType)) return null;
  const dependencyState = evaluateFinalResultDependencies(finalResult, applicationReceiptsForBatch(finalResult.batchId));
  if (!dependencyState.ready) {
    globalThis.ui?.notifications?.warn?.("Зависимость результата ещё не подтверждена применением исходного результата. Применение не блокируется.");
  }
  const application = finalResult.componentType === "damage"
    ? await applyDamageFinalToActor(finalResult, actor, amount, multiplier)
    : finalResult.componentType === "effect"
      ? await applyEffectFinalToActor(finalResult, actor, null)
      : await applyHealthFinalToActor(finalResult, actor, amount);
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
    dependencyReceiptIds: dependencyState.qualifyingReceiptIds,
    before: application.before,
    after: application.after,
    metadata: {
      resolution: application.resolution,
      adapterId: finalResult.application?.adapterId || finalResult.metadata?.sourceAdapterId || "action-v2",
      applicationMode: mode,
      multiplier: finalResult.componentType === "damage" ? Number(application.resolution?.multiplier) || 1 : 1
    }
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
  await refreshFinalBatch(finalResult.batchId);
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
  const multiplier = Number(element.dataset.multiplier) === 2 ? 2 : 1;
  for (const token of recipients) {
    const actor = token?.actor;
    if (!actor) continue;
    await createAbilityApplicationReceiptMessage(finalResult, token, actor, amount, "current-controlled", multiplier);
  }
}

async function applyFinalAssigned(element) {
  const message = messageFromElement(element);
  const finals = finalResultsFromMessage(message);
  if (!message || !finals.length) return;
  const requestedMultiplier = Number(element.dataset.multiplier) === 2 ? 2 : 1;
  for (const finalResult of finals) {
    if (!["damage", "healing", "tempHp", "effect"].includes(finalResult.componentType)) continue;
    const recipient = await assignedRecipient(finalResult);
    if (!recipient?.actor) {
      globalThis.ui?.notifications?.warn?.(`Назначенный получатель «${finalResult.provenance.recipient.name || "—"}» недоступен. Остальные результаты продолжают применяться.`);
      continue;
    }
    const amount = resolveFinalResultAmount(finalResult, { finalResults: finals });
    const multiplier = requestedMultiplier === 2 && finalResultIsDamage(finalResult) ? 2 : 1;
    await createAbilityApplicationReceiptMessage(finalResult, recipient.token, recipient.actor, amount, "assigned-recipient", multiplier);
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
  if (["damage", "healing", "tempHp"].includes(receipt.componentType)) {
    const plan = abilityV2HealthUndoPlan(receipt, actor);
    if (!plan.ok) {
      globalThis.ui?.notifications?.warn?.(plan.reason === "temp-hp-changed"
        ? "Временные HP уже изменились после этой карточки. Undo не выполнен, чтобы не стереть более новый результат."
        : "HP уже изменились после этой карточки. Undo не выполнен, чтобы не стереть более новый результат.");
      return;
    }
    await actor.update(plan.update, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  } else if (receipt.componentType === "effect") {
    const applied = Array.from(receipt.metadata?.resolution?.applied ?? []);
    for (const entry of applied) {
      const effect = actorEffectItems(actor).find(item => item.id === entry.effectId);
      if (!effect) {
        globalThis.ui?.notifications?.warn?.("Один из применённых Effect уже отсутствует. Undo остановлен, чтобы не затронуть более новое состояние.");
        return;
      }
      if (JSON.stringify(cloneRuntimeValue(effect.system?.runtime ?? {})) !== JSON.stringify(entry.afterRuntime ?? {})) {
        globalThis.ui?.notifications?.warn?.("Effect уже изменился после этой карточки. Undo не выполнен, чтобы не стереть более новое состояние.");
        return;
      }
    }
    for (const entry of [...applied].reverse()) {
      const effect = actorEffectItems(actor).find(item => item.id === entry.effectId);
      if (!effect) continue;
      if (entry.existedBefore) {
        await effect.update({ "system.runtime": cloneRuntimeValue(entry.beforeRuntime ?? {}) });
      } else {
        await effect.delete();
      }
    }
  }
  const next = normalizeApplicationReceipt({ ...receipt, undone: true });
  await message.update({
    content: applicationCardHTML(next, { provenanceName: message.getFlag?.("fast-nri", "abilityV2ProvenanceName") }),
    "flags.fast-nri.abilityV2ApplicationReceipt": next
  });
  await refreshFinalBatch(receipt.batchId);
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
      ["[data-fast-nri-ability-v2-defense]", addDefenseFromResolution],
      ["[data-fast-nri-ability-v2-defense-reroll]", rerollDefenseFromResolution],
      ["[data-fast-nri-ability-v2-defense-resource-undo]", undoDefenseResourceFromResolution],
      ["[data-fast-nri-ability-v2-defense-undo]", undoDefenseFromResolution],
      ["[data-fast-nri-ability-v2-area]", placeAreaFromAbilityV2],
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
