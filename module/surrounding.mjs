import { areEnemies, isFastNriGridSupported } from "./field-geometry.mjs";
import {
  formationCount,
  formationCountAgainst,
  formationTargetPenalty
} from "./formation.mjs";
import { threatCount } from "./threat.mjs";
import {
  applySurroundedEffect,
  removeSurroundedEffect,
  replaceRelativeOffGuardReasonObservers
} from "./effect-system.mjs";

export const RELATIVE_SURROUNDED_REASON_ID = "surrounded";

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
  // Surrounding is a rules calculation, so use Scene TokenDocuments rather
  // than canvas Token placeables. The document collection is authoritative
  // immediately after a movement/update workflow, while the visual placeable
  // may still be finishing its render/animation. This prevents one-move-late
  // Surrounding updates in live Foundry.
  const sceneDocuments = globalThis.canvas?.scene?.tokens?.contents;
  if (Array.isArray(sceneDocuments)) return Array.from(sceneDocuments);

  // Fallback for lightweight test shims.
  return Array.from(globalThis.canvas?.tokens?.placeables ?? []);
}

function actorIdentity(actor) {
  return String(actor?.uuid ?? actor?.id ?? "");
}

/**
 * Return the complete Fast NRI Surrounding calculation for one target.
 *
 * Global Surrounding compares Threats with the target's global Formation.
 * When an observer is supplied, observer-relative Formation modifiers are
 * applied instead; this is used for rules such as Rogue's `Ломать строй` and
 * never changes the target's global `Окружён` Effect Item.
 */
export function surroundingBreakdown(
  targetToken,
  observerToken = null,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  const threats = threatCount(targetToken, candidates, grid);
  const formation = observerToken
    ? formationCountAgainst(targetToken, observerToken, candidates, grid)
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
  observerToken,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  if (!observerToken) return isSurrounded(targetToken, candidates, grid);
  return surroundingBreakdown(targetToken, observerToken, candidates, grid).surrounded;
}

/**
 * Observer Actor UUIDs for whom this target is Surrounded only because of an
 * observer-relative Formation modifier. The global `Окружён` state is managed
 * independently as an Effect Item.
 */
export function relativeSurroundedObserverUuids(
  targetToken,
  candidates = currentSceneTokens(),
  grid = currentGrid()
) {
  if (!targetToken) return [];

  const result = new Set();

  for (const observer of Array.from(candidates ?? [])) {
    if (!observer || !areEnemies(targetToken, observer)) continue;
    if (formationTargetPenalty(observer) <= 0) continue;
    if (!isSurroundedFor(targetToken, observer, candidates, grid)) continue;

    const uuid = actorIdentity(tokenActor(observer));
    if (uuid) result.add(uuid);
  }

  return Array.from(result).sort();
}

function actorGroups(tokens) {
  const groups = new Map();

  for (const token of Array.from(tokens ?? [])) {
    const actor = tokenActor(token);
    const identity = actorIdentity(actor);
    if (!actor || !identity) continue;

    const group = groups.get(identity) ?? { actor, tokens: [] };
    group.tokens.push(token);
    groups.set(identity, group);
  }

  return Array.from(groups.values());
}

/**
 * Decide which connected client is allowed to write automatic field state for
 * this Actor. Foundry's User#isDesignated gives all clients the same elected
 * user from the supplied condition, avoiding duplicate embedded Item writes.
 * Only users currently viewing this Scene and permitted to update the Actor
 * are eligible.
 */
export function isDesignatedSurroundingUser(actor, sceneId = globalThis.canvas?.scene?.id ?? "") {
  const user = globalThis.game?.user;
  if (!actor || !user) return false;

  if (typeof user.isDesignated === "function") {
    return user.isDesignated(candidate =>
      candidate?.active === true
      && (!sceneId || candidate.viewedScene === sceneId)
      && actor.canUserModify?.(candidate, "update") === true
    );
  }

  // Conservative fallback for test environments or older shims.
  return Boolean(user.isGM || actor.isOwner);
}

async function syncActorGroup(group, candidates, grid, sceneId) {
  const actor = group?.actor;
  const tokens = Array.from(group?.tokens ?? []);
  if (!actor || !tokens.length) return false;
  if (!isDesignatedSurroundingUser(actor, sceneId)) return false;

  const globallySurrounded = tokens.some(token => isSurrounded(token, candidates, grid));

  if (globallySurrounded) await applySurroundedEffect(actor);
  else await removeSurroundedEffect(actor);

  const relativeObservers = new Set();
  for (const token of tokens) {
    for (const observerUuid of relativeSurroundedObserverUuids(token, candidates, grid)) {
      relativeObservers.add(observerUuid);
    }
  }

  await replaceRelativeOffGuardReasonObservers(
    actor,
    RELATIVE_SURROUNDED_REASON_ID,
    Array.from(relativeObservers)
  );

  return true;
}

/**
 * Recalculate automatic Surrounding for all Token Actors on the active Scene.
 * Unsupported grid types are intentionally left untouched rather than guessed.
 */
export async function syncCurrentSceneSurrounding() {
  const grid = currentGrid();
  if (!isFastNriGridSupported(grid)) return false;

  const candidates = currentSceneTokens();
  const sceneId = String(globalThis.canvas?.scene?.id ?? "");

  for (const group of actorGroups(candidates)) {
    await syncActorGroup(group, candidates, grid, sceneId);
  }

  return true;
}

let syncRunning = false;
let genericSyncQueued = false;
const syncQueue = [];

async function drainSyncQueue() {
  if (syncRunning) return;
  syncRunning = true;

  try {
    while (syncQueue.length) {
      const request = syncQueue.shift();
      if (request?.kind === "generic") genericSyncQueued = false;

      try {
        await syncCurrentSceneSurrounding();
      } catch (error) {
        console.error("Быстрая НРИ | Ошибка автоматического расчёта Окружения", error);
      }
    }
  } finally {
    syncRunning = false;
    if (syncQueue.length) void drainSyncQueue();
  }
}

function enqueueSyncRequest(kind) {
  syncQueue.push({ kind });
  void drainSyncQueue();
}

/**
 * Coalesced full-scene recalculation for non-movement state changes.
 * Repeated Item/Actor lifecycle hooks can describe the same logical change,
 * so one queued pass is sufficient for those events.
 */
export function scheduleSurroundingSync() {
  if (genericSyncQueued) return;
  genericSyncQueued = true;

  queueMicrotask(() => enqueueSyncRequest("generic"));
}

/**
 * Every completed Token movement gets its own full-scene recalculation.
 * Movement requests are deliberately NOT coalesced. A zero-delay task lets
 * the complete Foundry movement hook/update stack settle, then the rules read
 * the authoritative Scene TokenDocuments and recalculate every Token Actor.
 */
export function scheduleSurroundingSyncAfterMovement() {
  setTimeout(() => enqueueSyncRequest("movement"), 0);
}

/**
 * Token x/y changes are covered by the v14 moveToken hook. Skipping the
 * generic updateToken pass avoids an intermediate calculation from the same
 * movement; moveToken then guarantees the final full-scene pass.
 */
export function tokenUpdateContainsMovement(changed = {}) {
  if (!changed || typeof changed !== "object") return false;
  return Object.prototype.hasOwnProperty.call(changed, "x")
    || Object.prototype.hasOwnProperty.call(changed, "y");
}

function actorIsOnCurrentScene(actor) {
  if (!actor) return false;
  return currentSceneTokens().some(token => tokenActor(token)?.uuid === actor.uuid);
}

function tokenIsOnCurrentScene(tokenDocumentLike) {
  const document = tokenDocument(tokenDocumentLike);
  const sceneId = String(document?.parent?.id ?? document?.parent?.uuid ?? "");
  const currentSceneId = String(globalThis.canvas?.scene?.id ?? globalThis.canvas?.scene?.uuid ?? "");
  return Boolean(sceneId && currentSceneId && sceneId === currentSceneId);
}

function embeddedActor(item) {
  const parent = item?.parent;
  return parent?.documentName === "Actor" ? parent : null;
}

/**
 * Activate event-driven Surrounding recalculation. No polling is used.
 */
export function activateSurroundingAutomation() {
  Hooks.on("canvasReady", () => scheduleSurroundingSync());

  // v14 moveToken fires after the movement update workflow has concluded.
  // Every movement gets a distinct full-scene recalculation; movement passes
  // are intentionally never coalesced with one another.
  Hooks.on("moveToken", document => {
    if (tokenIsOnCurrentScene(document)) scheduleSurroundingSyncAfterMovement();
  });

  Hooks.on("createToken", document => {
    if (tokenIsOnCurrentScene(document)) scheduleSurroundingSync();
  });

  // Covers disposition, footprint/size, level/elevation and direct Token data
  // updates which are not represented by movement alone. x/y are intentionally
  // left to moveToken so a move cannot produce a stale intermediate field pass.
  Hooks.on("updateToken", (document, changed) => {
    if (!tokenIsOnCurrentScene(document)) return;
    if (tokenUpdateContainsMovement(changed)) return;
    scheduleSurroundingSync();
  });

  Hooks.on("deleteToken", document => {
    if (tokenIsOnCurrentScene(document)) scheduleSurroundingSync();
  });

  // HP value changes may change consciousness and therefore both Threat and
  // Formation. Other Actor updates are harmless and are debounced.
  Hooks.on("updateActor", actor => {
    if (actorIsOnCurrentScene(actor)) scheduleSurroundingSync();
  });

  // Weapon equipment/properties, Formation rules, prone/unconscious Effects,
  // and melee-control blockers are all embedded Items, so one lifecycle set is
  // sufficient without hard-coding Item names.
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => {
      const actor = embeddedActor(item);
      if (actor && actorIsOnCurrentScene(actor)) scheduleSurroundingSync();
    });
  }

  scheduleSurroundingSync();
}
