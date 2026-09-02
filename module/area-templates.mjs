import { abilityAreaPresetLabel } from "./ability-authoring.mjs";

const SYSTEM_ID = "fast-nri";
export const ABILITY_AREA_DRAG_TYPE = "FastNriArea";

function positive(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, number) : fallback;
}

function snap(value, size) {
  if (!(size > 0)) return Number(value) || 0;
  return Math.round((Number(value) || 0) / size) * size;
}

function areaShapeData(area, { x, y }) {
  const gridSize = Number(canvas?.dimensions?.size) || 100;
  const type = String(area?.type ?? "special");

  if (type === "square" || type === "rectangle") {
    const widthCells = positive(area?.width, 1);
    const heightCells = type === "square" ? widthCells : positive(area?.height, 1);
    const width = widthCells * gridSize;
    const height = heightCells * gridSize;
    return {
      type: "rectangle",
      x: snap((Number(x) || 0) - (width / 2), gridSize),
      y: snap((Number(y) || 0) - (height / 2), gridSize),
      width,
      height,
      rotation: 0,
      gridBased: true
    };
  }

  if (type === "line") {
    return {
      type: "line",
      x: snap(x, gridSize),
      y: snap(y, gridSize),
      length: positive(area?.length, 1) * gridSize,
      width: positive(area?.lineWidth, 1) * gridSize
    };
  }

  return null;
}

export function abilityAreaDragData({ item, implementationId, area, actionContext = null } = {}) {
  return {
    type: ABILITY_AREA_DRAG_TYPE,
    itemUuid: item?.uuid ?? null,
    sourceName: item?.name ?? "Область способности",
    implementationId: implementationId ?? null,
    area: {
      id: area?.id ?? null,
      type: area?.type ?? "special",
      label: abilityAreaPresetLabel(area),
      width: Number(area?.width) || 0,
      height: Number(area?.height) || 0,
      length: Number(area?.length) || 0,
      lineWidth: Number(area?.lineWidth) || 1
    },
    ...(actionContext ? { actionContext } : {})
  };
}

export async function placeDroppedAbilityArea(data) {
  if (data?.type !== ABILITY_AREA_DRAG_TYPE) return null;
  const area = data.area ?? {};
  if (area.type === "special") {
    ui.notifications.info("Особая область не имеет автоматической линейки. Разместите её по тексту способности.");
    return null;
  }
  if (!canvas?.ready || !canvas?.scene) {
    ui.notifications.warn("Сначала откройте сцену.");
    return null;
  }

  const shape = areaShapeData(area, { x: data.x, y: data.y });
  if (!shape) return null;

  const label = area.label || "Область";
  const regionData = {
    name: `${data.sourceName || "Способность"} — ${label}`,
    shapes: [shape],
    locked: false,
    flags: {
      [SYSTEM_ID]: {
        abilityArea: true,
        sourceItemUuid: data.itemUuid ?? null,
        implementationId: data.implementationId ?? null,
        areaId: area.id ?? null,
        areaType: area.type,
        ...(data.actionContext ? { actionContext: data.actionContext } : {})
      }
    }
  };

  try {
    const created = await canvas.scene.createEmbeddedDocuments("Region", [regionData]);
    return created?.[0] ?? null;
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось создать Region в точке drop; пробуем штатный placement", error);
    if (typeof canvas?.regions?.placeRegion === "function") {
      ui.notifications.warn("Не удалось создать область прямо в точке сброса. Выберите её положение штатным инструментом Region.");
      try {
        return await canvas.regions.placeRegion(regionData, {
          allowRotation: area.type === "line",
          create: true
        });
      } catch (placementError) {
        console.error("Быстрая НРИ | Ошибка размещения Region", placementError);
      }
    }
    ui.notifications.error(`Не удалось разместить область: ${error.message}`);
    return null;
  }
}

export function activateAbilityAreaPlacement() {
  Hooks.on("dropCanvasData", (_canvas, data) => {
    if (data?.type !== ABILITY_AREA_DRAG_TYPE) return;
    void placeDroppedAbilityArea(data);
  });
}
