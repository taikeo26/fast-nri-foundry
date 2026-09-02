import { abilityAreaPresetLabel } from "./ability-authoring.mjs";

const SYSTEM_ID = "fast-nri";

function positive(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, number) : fallback;
}

function areaShapeData(area) {
  const gridSize = Number(canvas?.dimensions?.size) || 100;
  const type = String(area?.type ?? "special");

  if (type === "square" || type === "rectangle") {
    const widthCells = positive(area?.width, 1);
    const heightCells = type === "square" ? widthCells : positive(area?.height, 1);
    return {
      type: "rectangle",
      x: 0,
      y: 0,
      width: widthCells * gridSize,
      height: heightCells * gridSize,
      rotation: 0,
      gridBased: true
    };
  }

  if (type === "line") {
    return {
      type: "line",
      x: 0,
      y: 0,
      length: positive(area?.length, 1) * gridSize,
      width: positive(area?.lineWidth, 1) * gridSize,
      rotation: 0,
      gridBased: true
    };
  }

  return null;
}

function areaRegionData({ item, implementationId, area, actionContext = null } = {}) {
  const shape = areaShapeData(area);
  if (!shape) return null;
  const label = abilityAreaPresetLabel(area) || "Область";
  const visibility = globalThis.CONST?.REGION_VISIBILITY?.ALWAYS;
  const ownershipLevel = globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER;
  const userId = game?.user?.id ?? null;

  return {
    name: `${item?.name || "Способность"} — ${label}`,
    shapes: [shape],
    color: game?.user?.color ?? undefined,
    locked: false,
    highlightMode: "coverage",
    displayMeasurements: true,
    ...(visibility == null ? {} : { visibility }),
    ...(canvas?.level?.id ? { levels: [canvas.level.id] } : {}),
    ...(userId && ownershipLevel != null ? { ownership: { [userId]: ownershipLevel } } : {}),
    flags: {
      [SYSTEM_ID]: {
        abilityArea: true,
        sourceItemUuid: item?.uuid ?? null,
        implementationId: implementationId ?? null,
        areaId: area?.id ?? null,
        areaType: area?.type ?? null,
        ...(actionContext ? { actionContext } : {})
      }
    }
  };
}

/**
 * Start Foundry VTT 14's native interactive Region placement workflow for an
 * Ability area preset. The Region preview follows the cursor and is committed
 * by Foundry itself, rather than relying on HTML5 drag/drop from the chat log.
 */
export async function placeAbilityAreaPreset({ item, implementationId, area, actionContext = null } = {}) {
  if (!area || area.type === "special") {
    ui.notifications.info("Особая область не имеет автоматической линейки. Разместите её по тексту способности.");
    return null;
  }
  if (!canvas?.ready || !canvas?.scene) {
    ui.notifications.warn("Сначала откройте сцену.");
    return null;
  }
  if (typeof canvas?.regions?.placeRegion !== "function") {
    ui.notifications.error("Foundry VTT не предоставляет штатное размещение Region на этой сцене.");
    return null;
  }

  const regionData = areaRegionData({ item, implementationId, area, actionContext });
  if (!regionData) return null;

  try {
    return await canvas.regions.placeRegion(regionData, {
      create: true,
      allowRotation: area.type === "line" || area.type === "rectangle"
    });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка штатного размещения Region", error);
    ui.notifications.error(`Не удалось разместить область: ${error.message}`);
    return null;
  }
}

// Kept as a stable activation entry point for fast-nri.mjs. Area placement no
// longer needs a dropCanvasData hook; chat buttons call placeRegion directly.
export function activateAbilityAreaPlacement() {}
