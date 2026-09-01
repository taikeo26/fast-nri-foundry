import { inferWeaponAttackType } from "./attack-types.mjs";
import {
  abilityActionTraits,
  abilityCheckConfig,
  directedAttackTypeFromTraits,
  normalizeActionTraits,
  normalizeCheckTargetCharacteristic
} from "./check-system.mjs";

export const ACTION_CONTEXT_SCHEMA_VERSION = 1;

export const DEFENSE_PROCEDURE_IDS = Object.freeze({
  directed: "Направленная защита",
  counteraction: "Противодействие",
  dodge: "Уворот"
});

function cloneData(value) {
  if (value === null || value === undefined) return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch (_error) {
      // Fall through to the JSON-safe representation used by ChatMessage flags.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return String(value ?? "").trim();
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function randomActionId() {
  try {
    const id = globalThis.foundry?.utils?.randomID?.();
    if (id) return String(id);
  } catch (_error) {
    // Tests and non-Foundry tooling intentionally use the fallback below.
  }

  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (id) return String(id);
  } catch (_error) {
    // Ignore and use the dependency-free fallback.
  }

  return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeDefenseProcedures(value = {}) {
  return {
    directed: Boolean(value?.directed),
    counteraction: Boolean(value?.counteraction),
    dodge: Boolean(value?.dodge)
  };
}

function targetRef(targetLike = null) {
  if (!targetLike) return null;

  const token = targetLike?.document?.documentName === "Token"
    ? targetLike.document
    : targetLike?.documentName === "Token"
      ? targetLike
      : targetLike?.document ?? targetLike;
  const actor = targetLike?.actor ?? token?.actor ?? null;

  const tokenUuid = text(token?.uuid);
  const actorUuid = text(actor?.uuid);
  if (!tokenUuid && !actorUuid) return null;

  return {
    tokenUuid: tokenUuid || null,
    actorUuid: actorUuid || null,
    name: text(targetLike?.name ?? token?.name ?? actor?.name) || null
  };
}

function normalizeTargets(value = []) {
  const source = Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();

  for (const entry of source) {
    const target = targetRef(entry) ?? (() => {
      if (!entry || typeof entry !== "object") return null;
      const tokenUuid = text(entry.tokenUuid);
      const actorUuid = text(entry.actorUuid);
      if (!tokenUuid && !actorUuid) return null;
      return {
        tokenUuid: tokenUuid || null,
        actorUuid: actorUuid || null,
        name: text(entry.name) || null
      };
    })();

    if (!target) continue;
    const key = target.tokenUuid || target.actorUuid;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }

  return result;
}

function normalizeCheck(value = {}) {
  return {
    enabled: Boolean(value?.enabled),
    formula: text(value?.formula) || null,
    targetCharacteristic: normalizeCheckTargetCharacteristic(value?.targetCharacteristic) || null,
    total: finiteNumberOrNull(value?.total),
    naturalD20: finiteNumberOrNull(value?.naturalD20),
    degree: ["failure", "partial", "success", "great"].includes(value?.degree)
      ? value.degree
      : null,
    critical: Boolean(value?.critical)
  };
}

function deriveStandardDefenseProcedures({ check, traits, directedDefense = false } = {}) {
  const normalizedCheck = normalizeCheck(check);
  const normalizedTraits = normalizeActionTraits(traits);
  const targetCharacteristic = normalizedCheck.targetCharacteristic;
  const directedAttackType = directedAttackTypeFromTraits(normalizedTraits);

  return {
    directed: Boolean(
      directedDefense
      && normalizedCheck.enabled
      && targetCharacteristic === "armor"
      && !normalizedTraits.area
      && ["melee", "ranged"].includes(directedAttackType)
    ),
    // A check against one of the four defensive characteristics creates the
    // standard Counteraction procedure. Area checks keep Counteraction and may
    // additionally expose Dodge; the player chooses which defense to use.
    counteraction: Boolean(
      normalizedCheck.enabled
      && ["awareness", "reflex", "fortitude", "will"].includes(targetCharacteristic)
    ),
    // In the current structured model an area Check is the source used by an
    // area attack workflow. Dodge remains available even when the Check is
    // against KZ, exactly as Rulebook 6.3 specifies.
    dodge: Boolean(normalizedCheck.enabled && normalizedTraits.area)
  };
}

export function normalizeActionContext(value = {}) {
  const traits = normalizeActionTraits(value?.traits ?? value?.actionTraits);
  const check = normalizeCheck(value?.check);
  const explicitProcedures = normalizeDefenseProcedures(value?.defenseProcedures);
  const derivedProcedures = deriveStandardDefenseProcedures({
    check,
    traits,
    directedDefense: Boolean(
      value?.defenseProcedure?.directedDefense
      ?? value?.directedDefense
      ?? explicitProcedures.directed
    )
  });

  const source = value?.source ?? {};
  const initiator = value?.initiator ?? {};
  const origin = value?.origin ?? value?.originActionContext ?? {};

  return {
    schemaVersion: ACTION_CONTEXT_SCHEMA_VERSION,
    actionId: text(value?.actionId) || randomActionId(),
    source: {
      actorUuid: text(source.actorUuid ?? value?.actorUuid) || null,
      itemUuid: text(source.itemUuid ?? value?.itemUuid) || null,
      itemType: text(source.itemType) || null,
      name: text(source.name) || null
    },
    initiator: {
      actorUuid: text(initiator.actorUuid ?? source.actorUuid ?? value?.actorUuid) || null,
      tokenUuid: text(initiator.tokenUuid) || null
    },
    targets: normalizeTargets(value?.targets ?? []),
    check,
    traits,
    defenseProcedures: {
      directed: explicitProcedures.directed || derivedProcedures.directed,
      counteraction: explicitProcedures.counteraction || derivedProcedures.counteraction,
      dodge: explicitProcedures.dodge || derivedProcedures.dodge
    },
    origin: {
      // Once an action originates from an Intervention, every derivative keeps
      // the marker. 0.5.54 will attach HB-02 to this canonical field.
      intervention: Boolean(origin?.intervention || traits.intervention)
    },
    parentActionId: text(value?.parentActionId) || null,
    parentMessageId: text(value?.parentMessageId) || null,
    rootMessageId: text(value?.rootMessageId) || null
  };
}

export function createActionContext({
  actor = null,
  item = null,
  target = null,
  targets = null,
  check = {},
  traits = {},
  directedDefense = false,
  defenseProcedures = {},
  originActionContext = null,
  parentActionId = null,
  parentMessageId = null,
  rootMessageId = null,
  actionId = null
} = {}) {
  const inherited = originActionContext
    ? normalizeActionContext(originActionContext)
    : null;

  const source = {
    actorUuid: actor?.uuid ?? inherited?.source?.actorUuid ?? null,
    itemUuid: item?.uuid ?? inherited?.source?.itemUuid ?? null,
    itemType: item?.type ?? inherited?.source?.itemType ?? null,
    name: item?.name ?? inherited?.source?.name ?? null
  };

  const inheritedTargets = inherited?.targets ?? [];
  const suppliedTargets = targets ?? (target ? [target] : null);

  return normalizeActionContext({
    actionId: actionId ?? inherited?.actionId ?? null,
    source,
    initiator: {
      actorUuid: actor?.uuid ?? inherited?.initiator?.actorUuid ?? null,
      tokenUuid: inherited?.initiator?.tokenUuid ?? null
    },
    targets: suppliedTargets ?? inheritedTargets,
    check: {
      ...(inherited?.check ?? {}),
      ...check
    },
    traits: {
      ...(inherited?.traits ?? {}),
      ...traits
    },
    defenseProcedures: {
      ...(inherited?.defenseProcedures ?? {}),
      ...defenseProcedures
    },
    defenseProcedure: { directedDefense },
    origin: {
      intervention: Boolean(
        inherited?.origin?.intervention
        || originActionContext?.origin?.intervention
        || originActionContext?.originActionContext?.intervention
      )
    },
    parentActionId: parentActionId ?? inherited?.parentActionId ?? null,
    parentMessageId: parentMessageId ?? inherited?.parentMessageId ?? null,
    rootMessageId: rootMessageId ?? inherited?.rootMessageId ?? null
  });
}

export function actionContextFromWeapon(actor, weapon, { target = null, originActionContext = null } = {}) {
  const attackType = inferWeaponAttackType(weapon);
  return createActionContext({
    actor,
    item: weapon,
    target,
    originActionContext,
    check: {
      enabled: true,
      targetCharacteristic: "armor"
    },
    traits: {
      melee: attackType === "melee",
      ranged: attackType === "ranged",
      area: false,
      intervention: false
    },
    directedDefense: true
  });
}

export function actionContextFromAbility(actor, item, { target = null, originActionContext = null } = {}) {
  const config = abilityCheckConfig(item);
  const traits = abilityActionTraits(item);

  return createActionContext({
    actor,
    item,
    target,
    originActionContext,
    check: {
      enabled: config.enabled,
      formula: config.formula,
      targetCharacteristic: config.enabled
        ? config.targetCharacteristic
        : null
    },
    traits,
    directedDefense: Boolean(config.directedDefense)
  });
}

export function deriveActionContext(context, patch = {}) {
  const base = normalizeActionContext(context);
  const nextTraits = {
    ...base.traits,
    ...(patch.traits ?? patch.actionTraits ?? {})
  };
  const nextCheck = {
    ...base.check,
    ...(patch.check ?? {})
  };

  return normalizeActionContext({
    ...cloneData(base),
    ...patch,
    actionId: base.actionId,
    source: {
      ...base.source,
      ...(patch.source ?? {})
    },
    initiator: {
      ...base.initiator,
      ...(patch.initiator ?? {})
    },
    targets: patch.targets ?? base.targets,
    check: nextCheck,
    traits: nextTraits,
    defenseProcedures: {
      ...base.defenseProcedures,
      ...(patch.defenseProcedures ?? {})
    },
    origin: {
      intervention: Boolean(
        base.origin?.intervention
        || patch.origin?.intervention
        || nextTraits.intervention
      )
    },
    parentActionId: patch.parentActionId ?? base.parentActionId,
    parentMessageId: patch.parentMessageId ?? base.parentMessageId,
    rootMessageId: patch.rootMessageId ?? base.rootMessageId
  });
}

export function actionContextWithCheckResult(context, {
  target = null,
  total = null,
  naturalD20 = null,
  degree = null,
  critical = false,
  formula = null,
  parentMessageId = null,
  rootMessageId = null
} = {}) {
  const base = normalizeActionContext(context);
  return deriveActionContext(base, {
    targets: target ? [target] : base.targets,
    check: {
      ...base.check,
      formula: formula ?? base.check.formula,
      total,
      naturalD20,
      degree,
      critical
    },
    parentMessageId,
    rootMessageId
  });
}

export function actionContextForDefenseAction(sourceActionContext, {
  actor = null,
  item = null,
  defenderToken = null,
  protectedToken = null,
  actionName = "Защита",
  procedure = "directed",
  total = null,
  naturalD20 = null,
  parentMessageId = null
} = {}) {
  const sourceContext = normalizeActionContext(sourceActionContext);
  const context = createActionContext({
    actor,
    item,
    target: protectedToken,
    check: {
      enabled: true,
      targetCharacteristic: null,
      total,
      naturalD20,
      degree: null,
      critical: false
    },
    traits: {
      melee: false,
      ranged: false,
      area: false,
      intervention: true
    },
    defenseProcedures: {
      directed: false,
      counteraction: false,
      dodge: false
    },
    parentActionId: sourceContext.actionId,
    parentMessageId
  });

  return normalizeActionContext({
    ...context,
    source: {
      ...context.source,
      name: item?.name ?? actionName,
      itemType: item?.type ?? `system-${procedure}`
    },
    initiator: {
      actorUuid: actor?.uuid ?? context.initiator.actorUuid,
      tokenUuid: defenderToken?.document?.uuid ?? defenderToken?.uuid ?? null
    },
    origin: { intervention: true }
  });
}

export function actionContextDefenseProcedureIds(context) {
  const procedures = normalizeActionContext(context).defenseProcedures;
  return Object.keys(DEFENSE_PROCEDURE_IDS).filter(id => procedures[id]);
}

export function directedAttackTypeFromActionContext(context) {
  return directedAttackTypeFromTraits(normalizeActionContext(context).traits);
}

export function actionContextFromMessage(message) {
  if (!message?.getFlag) return null;
  const stored = message.getFlag("fast-nri", "actionContext");
  return stored ? normalizeActionContext(stored) : null;
}
