import { formationCount, formationCountAgainst } from "./formation.mjs";
import { threatCount } from "./threat.mjs";

function tokenDocument(tokenOrDocument) {
  if (!tokenOrDocument) return null;
  return tokenOrDocument.document ?? tokenOrDocument;
}

function tokenActor(tokenOrDocument) {
  const document = tokenDocument(tokenOrDocument);
  return document?.actor ?? tokenOrDocument?.actor ?? null;
}

function actorIdentity(actor) {
  return String(actor?.uuid ?? actor?.id ?? "");
}

function currentGrid() {
  return globalThis.canvas?.grid ?? null;
}

/**
 * Authoritative TokenDocuments on the currently viewed Scene.
 *
 * Surrounding is intentionally a lazy rules calculation. It is read only when
 * an action needs the target's current state; movement never writes or caches
 * Surrounding anywhere on the Actor/Token.
 */
export function currentSceneTokens() {
  const sceneDocuments = globalThis.canvas?.scene?.tokens?.contents;
  if (Array.isArray(sceneDocuments)) return Array.from(sceneDocuments);

  // Lightweight fallback for tests and environments without a live Scene.
  return Array.from(globalThis.canvas?.tokens?.placeables ?? []);
}

/**
 * Resolve which placed Token represents an acting Actor for observer-relative
 * Formation rules. A controlled matching Token wins; otherwise a unique Token
 * for the Actor on the current Scene is safe. Ambiguous multi-token cases
 * deliberately return null rather than guessing.
 */
export function observerTokenForActor(actor, candidates = currentSceneTokens()) {
  if (!actor) return null;
  const identity = actorIdentity(actor);
  if (!identity) return null;

  const controlledMatches = Array.from(globalThis.canvas?.tokens?.controlled ?? [])
    .filter(token => actorIdentity(tokenActor(token)) === identity);
  if (controlledMatches.length === 1) {
    return tokenDocument(controlledMatches[0]);
  }

  const sceneMatches = Array.from(candidates ?? [])
    .filter(token => actorIdentity(tokenActor(token)) === identity);
  return sceneMatches.length === 1 ? tokenDocument(sceneMatches[0]) : null;
}

function observerToken(observerOrActor, candidates) {
  if (!observerOrActor) return null;

  const document = tokenDocument(observerOrActor);
  if (document?.getOccupiedGridSpaceOffsets) return document;

  if (observerOrActor?.documentName === "Actor" || observerOrActor?.type) {
    return observerTokenForActor(observerOrActor, candidates);
  }

  const actor = tokenActor(observerOrActor);
  return actor ? observerTokenForActor(actor, candidates) : null;
}

/**
 * Complete Fast NRI Surrounding calculation for one target at the instant a
 * rule asks for it. No Effect Item, flag, ActiveEffect, or movement cache is
 * involved.
 */
export function surroundingBreakdown(
  targetToken,
  observerOrActor = null,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  const observer = observerToken(observerOrActor, candidates);
  const threats = threatCount(targetToken, candidates, grid);
  const formation = observer
    ? formationCountAgainst(targetToken, observer, candidates, grid)
    : formationCount(targetToken, candidates, grid);

  return {
    threats,
    formation,
    surrounded: threats > formation
  };
}

export function isSurrounded(
  targetToken,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  return surroundingBreakdown(targetToken, null, candidates, grid).surrounded;
}

export function isSurroundedFor(
  targetToken,
  observerOrActor,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  return surroundingBreakdown(targetToken, observerOrActor, candidates, grid).surrounded;
}
