import { areEnemies, occupiedCells, sameCell } from "./field-geometry.mjs";
import { controlledMeleeCells } from "./melee-control.mjs";

function tokenDocument(tokenOrDocument) {
  if (!tokenOrDocument) return null;
  return tokenOrDocument.document ?? tokenOrDocument;
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

/**
 * True when this enemy currently controls at least one grid cell occupied by
 * the target. Field control itself is delegated to melee-control, so standing,
 * consciousness, equipment state, Reach, and control-blocking Effects remain
 * defined in one place.
 */
export function tokenThreatensTarget(threatToken, targetToken, grid = currentGrid()) {
  if (!threatToken || !targetToken || !areEnemies(threatToken, targetToken)) return false;

  const targetCells = occupiedCells(targetToken);
  if (!targetCells.length) return false;

  const controlledCells = controlledMeleeCells(threatToken, grid);
  if (!controlledCells.length) return false;

  return targetCells.some(targetCell =>
    controlledCells.some(controlledCell => sameCell(targetCell, controlledCell))
  );
}

/**
 * Return each threatening enemy Token at most once.
 *
 * Candidate Tokens default to the Tokens currently placed on the canvas. A
 * caller may pass an explicit candidate list for deterministic calculations or
 * tests. Duplicate references to the same TokenDocument are ignored.
 */
export function threateningEnemies(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  if (!targetToken) return [];

  const result = [];
  const seenObjects = new Set();
  const seenIds = new Set();

  for (const candidate of Array.from(candidates ?? [])) {
    if (!candidate) continue;

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

    if (tokenThreatensTarget(candidate, targetToken, grid)) result.push(candidate);
  }

  return result;
}

export function threatCount(targetToken, candidates = currentSceneTokens(), grid = currentGrid()) {
  return threateningEnemies(targetToken, candidates, grid).length;
}
