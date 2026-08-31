import {
  hasConditionOffGuardEffect,
  hasManualOffGuardEffect,
  relativeOffGuardReasons
} from "./effect-system.mjs";
import {
  observerTokenForActor,
  surroundingBreakdown
} from "./surrounding.mjs";

export const OFF_GUARD_DEFENSE_PENALTY = 2;

function tokenDocument(tokenOrDocument) {
  if (!tokenOrDocument) return null;
  return tokenOrDocument.document ?? tokenOrDocument;
}

function tokenActor(tokenOrDocument) {
  const document = tokenDocument(tokenOrDocument);
  return document?.actor ?? tokenOrDocument?.actor ?? null;
}

function observerToken(observerOrActor, candidates) {
  if (!observerOrActor) return null;
  const document = tokenDocument(observerOrActor);
  if (document?.getOccupiedGridSpaceOffsets) return document;
  return observerTokenForActor(observerOrActor, candidates);
}

/**
 * Resolve the target state exactly when an action needs it.
 *
 * Surrounding is calculated from the live Scene and never persisted. Manual
 * Off-Guard and other explicitly stored observer-relative reasons remain
 * independent sources. Multiple sources still produce only one -2 penalty.
 */
export function actionTargetState(
  targetToken,
  observerOrActor = null,
  candidates = undefined,
  grid = undefined
) {
  const targetDocument = tokenDocument(targetToken);
  const targetActor = tokenActor(targetDocument);
  const sceneCandidates = candidates ?? undefined;
  const observer = observerToken(observerOrActor, sceneCandidates);

  const surrounding = surroundingBreakdown(
    targetDocument,
    observer ?? observerOrActor,
    sceneCandidates,
    grid
  );

  const manualOffGuard = hasManualOffGuardEffect(targetActor);
  const conditionOffGuard = hasConditionOffGuardEffect(targetActor);
  const relativeReasons = observer
    ? relativeOffGuardReasons(targetActor, observer)
    : [];
  const relativeOffGuard = relativeReasons.length > 0;
  const offGuard = manualOffGuard
    || conditionOffGuard
    || relativeOffGuard
    || surrounding.surrounded;

  return {
    targetActor,
    observerToken: observer,
    surrounding,
    manualOffGuard,
    conditionOffGuard,
    relativeOffGuard,
    relativeReasons,
    offGuard,
    defensePenalty: offGuard ? OFF_GUARD_DEFENSE_PENALTY : 0
  };
}

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function effectiveArmorForAction(targetToken, observerOrActor = null) {
  const state = actionTargetState(targetToken, observerOrActor);
  const armor = state.targetActor?.system?.armor ?? {};
  const penalty = state.defensePenalty;

  const adjust = value => {
    const number = finiteOrNull(value);
    return number === null ? value : number - penalty;
  };

  return {
    state,
    armor: {
      partial: adjust(armor.partial),
      success: adjust(armor.success),
      great: adjust(armor.great)
    }
  };
}

/**
 * Shared entry point for future actions which use a defensive characteristic
 * instead of Armor Class. This keeps the lazy Surrounding rule in one place.
 */
export function effectiveDefenseCharacteristicForAction(
  targetToken,
  characteristic,
  observerOrActor = null
) {
  const state = actionTargetState(targetToken, observerOrActor);
  const raw = finiteOrNull(state.targetActor?.system?.defenses?.[characteristic]);

  return {
    state,
    raw,
    value: raw === null ? null : raw - state.defensePenalty
  };
}
