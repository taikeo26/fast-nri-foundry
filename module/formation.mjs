import {
  areAdjacent,
  areAllies,
  isStandingAndConscious
} from "./field-geometry.mjs";

function tokenDocument(tokenOrDocument) {
  if (!tokenOrDocument) return null;
  return tokenOrDocument.document ?? tokenOrDocument;
}

function tokenActor(tokenOrDocument) {
  const document = tokenDocument(tokenOrDocument);
  return document?.actor ?? tokenOrDocument?.actor ?? null;
}

function currentGrid() {
  return globalThis.canvas?.grid ?? null;
}

function currentSceneTokens() {
  const sceneDocuments = globalThis.canvas?.scene?.tokens?.contents;
  if (Array.isArray(sceneDocuments)) return Array.from(sceneDocuments);
  return Array.from(globalThis.canvas?.tokens?.placeables ?? []);
}

function tokenIdentity(tokenOrDocument) {
  const document = tokenDocument(tokenOrDocument);
  return String(document?.uuid ?? document?.id ?? "");
}

function sameToken(tokenA, tokenB) {
  const first = tokenDocument(tokenA);
  const second = tokenDocument(tokenB);
  if (!first || !second) return false;
  if (first === second) return true;
  return Boolean(first.uuid && second.uuid && first.uuid === second.uuid);
}

function positiveInteger(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.trunc(numeric));
}

function formationRuleItems(actor) {
  return Array.from(actor?.items ?? []).filter(item =>
    item?.type === "ability" || item?.type === "effect"
  );
}

function itemFormationRule(item, key) {
  return positiveInteger(item?.system?.rules?.formation?.[key]);
}

/**
 * Return the strongest modifier of one formation-rule channel on an Actor.
 * Matching modifiers deliberately do not add together: a stronger rule
 * replaces a weaker one, while equal sources remain one effective modifier.
 */
export function actorFormationRule(actor, key) {
  let best = 0;
  for (const item of formationRuleItems(actor)) {
    best = Math.max(best, itemFormationRule(item, key));
  }
  return best;
}

/**
 * True when a candidate Token contributes one creature to the target's base
 * Formation. Only standing, conscious allies directly adjacent to the target
 * qualify. Adjacency is delegated to the Foundry-first geometry adapter and
 * therefore uses the complete footprint of both Tokens.
 */
export function tokenSupportsFormation(targetToken, candidateToken, grid = currentGrid()) {
  if (!targetToken || !candidateToken || sameToken(targetToken, candidateToken)) return false;
  if (!areAllies(targetToken, candidateToken)) return false;
  if (!isStandingAndConscious(candidateToken)) return false;
  return areAdjacent(targetToken, candidateToken, grid);
}

/**
 * Return the creatures in the target's base Formation.
 *
 * The target itself contributes when standing and conscious. Each directly
 * adjacent standing/conscious ally contributes at most once. Allies adjacent
 * only to another formation member do not chain into the target's Formation.
 *
 * Candidate Tokens default to Tokens currently placed on the canvas. A caller
 * may pass an explicit list for deterministic calculations or tests.
 */
export function formationMembers(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  if (!targetToken) return [];

  const result = [];
  if (isStandingAndConscious(targetToken)) result.push(targetToken);

  const seenObjects = new Set();
  const seenIds = new Set();

  for (const candidate of Array.from(candidates ?? [])) {
    if (!candidate || sameToken(targetToken, candidate)) continue;

    const document = tokenDocument(candidate);
    if (!document) continue;

    const identity = tokenIdentity(document);
    if (identity) {
      if (seenIds.has(identity)) continue;
      seenIds.add(identity);
    } else {
      if (seenObjects.has(document)) continue;
      seenObjects.add(document);
    }

    if (tokenSupportsFormation(targetToken, candidate, grid)) result.push(candidate);
  }

  return result;
}

export function baseFormationCount(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  return formationMembers(targetToken, candidates, grid).length;
}

/**
 * Strongest global Formation bonus that currently applies to the target.
 *
 * - A standing/conscious target may provide selfBonus to itself.
 * - A standing/conscious adjacent ally may provide adjacentAllyBonus.
 * - These sources are one bonus family and therefore do not stack; only the
 *   strongest applicable value is used.
 */
export function formationSupportBonus(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  if (!targetToken) return 0;

  let best = 0;

  if (isStandingAndConscious(targetToken)) {
    best = Math.max(best, actorFormationRule(tokenActor(targetToken), "selfBonus"));
  }

  for (const member of formationMembers(targetToken, candidates, grid)) {
    if (sameToken(member, targetToken)) continue;
    best = Math.max(best, actorFormationRule(tokenActor(member), "adjacentAllyBonus"));
  }

  return best;
}

/**
 * Global Formation value used when no observer-specific rule is involved.
 */
export function formationCount(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  return baseFormationCount(targetToken, candidates, grid)
    + formationSupportBonus(targetToken, candidates, grid);
}

/**
 * Strongest observer-relative penalty supplied by the observer's active
 * Ability/Effect Items. This changes only how that observer evaluates the
 * target's Formation; it never mutates the target's global Formation value.
 */
export function formationTargetPenalty(observerToken) {
  return actorFormationRule(tokenActor(observerToken), "targetPenalty");
}

/**
 * Formation as evaluated for one observer. Used by rules such as Rogue
 * abilities which treat the target's Formation as lower only for that Rogue.
 */
export function formationCountAgainst(
  targetToken,
  observerToken,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  const globalFormation = formationCount(targetToken, candidates, grid);
  const penalty = formationTargetPenalty(observerToken);
  return Math.max(0, globalFormation - penalty);
}

export function formationBreakdown(
  targetToken,
  observerToken = null,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  const base = baseFormationCount(targetToken, candidates, grid);
  const bonus = formationSupportBonus(targetToken, candidates, grid);
  const penalty = observerToken ? formationTargetPenalty(observerToken) : 0;
  return {
    base,
    supportBonus: bonus,
    observerPenalty: penalty,
    total: Math.max(0, base + bonus - penalty)
  };
}
