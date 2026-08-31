import { actorHasBuiltinEffect } from "./effect-system.mjs";

const FALLBACK_DISPOSITIONS = Object.freeze({
  FRIENDLY: 1,
  HOSTILE: -1,
  NEUTRAL: 0,
  SECRET: -2
});

export const TOKEN_RELATIONS = Object.freeze({
  self: "self",
  ally: "ally",
  enemy: "enemy",
  neutral: "neutral"
});

const warnedUnsupportedScenes = new Set();

function tokenDocument(tokenOrDocument) {
  if (!tokenOrDocument) return null;
  return tokenOrDocument.document ?? tokenOrDocument;
}

function actorFromToken(tokenOrDocument) {
  return tokenDocument(tokenOrDocument)?.actor ?? tokenOrDocument?.actor ?? null;
}

function currentGrid() {
  return globalThis.canvas?.grid ?? null;
}

function dispositions() {
  return globalThis.CONST?.TOKEN_DISPOSITIONS ?? FALLBACK_DISPOSITIONS;
}

function normalizeCell(cell) {
  if (!cell) return null;
  const i = Number(cell.i);
  const j = Number(cell.j);
  if (!Number.isFinite(i) || !Number.isFinite(j)) return null;

  const normalized = { i, j };
  const k = Number(cell.k);
  if (Number.isFinite(k)) normalized.k = k;
  return normalized;
}

function sameLayer(a, b) {
  if (a?.k === undefined || b?.k === undefined) return true;
  return Number(a.k) === Number(b.k);
}

export function cellKey(cell) {
  const normalized = normalizeCell(cell);
  if (!normalized) return "";
  return `${normalized.i}:${normalized.j}:${normalized.k ?? ""}`;
}

export function sameCell(a, b) {
  const first = normalizeCell(a);
  const second = normalizeCell(b);
  if (!first || !second) return false;
  return first.i === second.i && first.j === second.j && sameLayer(first, second);
}

export function isFastNriGridSupported(grid = currentGrid()) {
  return Boolean(grid?.isSquare);
}

/**
 * Read the exact grid spaces occupied by a Token from Foundry itself.
 * Fast NRI deliberately does not reconstruct token footprint from x/y/size.
 */
export function occupiedCells(tokenOrDocument, data = undefined) {
  const document = tokenDocument(tokenOrDocument);
  if (!document?.getOccupiedGridSpaceOffsets) return [];

  const offsets = document.getOccupiedGridSpaceOffsets(data) ?? [];
  const unique = new Map();
  for (const offset of offsets) {
    const cell = normalizeCell(offset);
    const key = cellKey(cell);
    if (cell && key) unique.set(key, cell);
  }
  return Array.from(unique.values());
}

/**
 * Foundry supplies native adjacent offsets. Fast NRI additionally guarantees
 * that a diagonal square is one adjacent cell even if the Scene movement rule
 * has diagonals configured as illegal.
 */
export function adjacentCells(cell, grid = currentGrid()) {
  const origin = normalizeCell(cell);
  if (!origin || !isFastNriGridSupported(grid)) return [];

  const unique = new Map();
  for (const offset of grid.getAdjacentOffsets?.(origin) ?? []) {
    const normalized = normalizeCell(offset);
    const key = cellKey(normalized);
    if (normalized && key && !sameCell(origin, normalized)) unique.set(key, normalized);
  }

  for (const di of [-1, 1]) {
    for (const dj of [-1, 1]) {
      const diagonal = { i: origin.i + di, j: origin.j + dj };
      if (origin.k !== undefined) diagonal.k = origin.k;
      unique.set(cellKey(diagonal), diagonal);
    }
  }

  return Array.from(unique.values());
}

export function areCellsAdjacent(a, b, grid = currentGrid()) {
  const first = normalizeCell(a);
  const second = normalizeCell(b);
  if (!first || !second || !isFastNriGridSupported(grid)) return false;
  if (!sameLayer(first, second) || sameCell(first, second)) return false;

  if (grid.testAdjacency?.(first, second)) return true;

  // Fast NRI square-grid adjacency is 8-way even when Scene movement has
  // diagonal movement disabled.
  return Math.abs(first.i - second.i) === 1
    && Math.abs(first.j - second.j) === 1;
}

export function areAdjacent(tokenA, tokenB, grid = currentGrid()) {
  if (!isFastNriGridSupported(grid)) return false;

  const cellsA = occupiedCells(tokenA);
  const cellsB = occupiedCells(tokenB);
  if (!cellsA.length || !cellsB.length) return false;

  return cellsA.some(a => cellsB.some(b => areCellsAdjacent(a, b, grid)));
}

/**
 * Return the exact Fast NRI ring N cells away from the Token footprint.
 * Radius 0 is the footprint itself. The result is independent of diagonal
 * movement cost because every neighboring square is one Fast NRI cell.
 */
export function cellsAtRadius(tokenOrDocument, radius, grid = currentGrid()) {
  const steps = Math.max(0, Math.trunc(Number(radius) || 0));
  if (!isFastNriGridSupported(grid)) return [];

  const origin = occupiedCells(tokenOrDocument);
  if (!origin.length || steps === 0) return origin;

  const visited = new Map(origin.map(cell => [cellKey(cell), cell]));
  let frontier = origin;

  for (let step = 1; step <= steps; step += 1) {
    const next = new Map();

    for (const cell of frontier) {
      for (const neighbor of adjacentCells(cell, grid)) {
        const key = cellKey(neighbor);
        if (!key || visited.has(key) || next.has(key)) continue;
        next.set(key, neighbor);
      }
    }

    frontier = Array.from(next.values());
    for (const [key, cell] of next) visited.set(key, cell);
    if (!frontier.length) break;
  }

  return frontier;
}

export function tokenRelation(tokenA, tokenB) {
  const first = tokenDocument(tokenA);
  const second = tokenDocument(tokenB);
  if (!first || !second) return TOKEN_RELATIONS.neutral;

  if (first === second || (first.uuid && second.uuid && first.uuid === second.uuid)) {
    return TOKEN_RELATIONS.self;
  }

  const { FRIENDLY, HOSTILE } = dispositions();
  const firstDisposition = Number(first.disposition);
  const secondDisposition = Number(second.disposition);

  if (firstDisposition === FRIENDLY && secondDisposition === FRIENDLY) return TOKEN_RELATIONS.ally;
  if (firstDisposition === HOSTILE && secondDisposition === HOSTILE) return TOKEN_RELATIONS.ally;

  const opposed = (
    firstDisposition === FRIENDLY && secondDisposition === HOSTILE
  ) || (
    firstDisposition === HOSTILE && secondDisposition === FRIENDLY
  );

  return opposed ? TOKEN_RELATIONS.enemy : TOKEN_RELATIONS.neutral;
}

export function areAllies(tokenA, tokenB) {
  return tokenRelation(tokenA, tokenB) === TOKEN_RELATIONS.ally;
}

export function areEnemies(tokenA, tokenB) {
  return tokenRelation(tokenA, tokenB) === TOKEN_RELATIONS.enemy;
}

export function isConscious(actorOrToken) {
  const actor = actorOrToken?.system ? actorOrToken : actorFromToken(actorOrToken);
  if (!actor) return false;
  if (actorHasBuiltinEffect(actor, "unconscious")) return false;

  const hp = Number(actor.system?.hp?.value);
  if (Number.isFinite(hp) && hp <= 0) return false;
  return true;
}

export function isStanding(actorOrToken) {
  const actor = actorOrToken?.system ? actorOrToken : actorFromToken(actorOrToken);
  if (!actor) return false;
  return !actorHasBuiltinEffect(actor, "prone");
}

export function isStandingAndConscious(actorOrToken) {
  return isStanding(actorOrToken) && isConscious(actorOrToken);
}

export function warnIfUnsupportedFastNriGrid(grid = currentGrid(), sceneId = globalThis.canvas?.scene?.id ?? "") {
  if (!grid || isFastNriGridSupported(grid)) return false;

  const key = String(sceneId || "unknown");
  if (warnedUnsupportedScenes.has(key)) return true;
  warnedUnsupportedScenes.add(key);

  globalThis.ui?.notifications?.warn?.(
    "Быстрая НРИ 6.2: автоматическая геометрия поля поддерживает только квадратную сетку."
  );
  return true;
}

export function activateFieldGeometry() {
  Hooks.on("canvasReady", canvasInstance => {
    warnIfUnsupportedFastNriGrid(
      canvasInstance?.grid ?? currentGrid(),
      canvasInstance?.scene?.id ?? globalThis.canvas?.scene?.id ?? ""
    );
  });
}
