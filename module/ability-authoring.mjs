import { ABILITY_TRAITS } from "./config.mjs";

export const ABILITY_PROFILE_DEGREES = Object.freeze({
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
});

export const ABILITY_TARGET_MODES = Object.freeze({
  none: "Без цели",
  self: "На себя",
  single: "Одна цель",
  multiple: "Несколько целей",
  location: "Клетка / точка",
  area: "Область"
});

export const ABILITY_TARGET_RELATIONS = Object.freeze({
  any: "Любая",
  enemy: "Враг",
  ally: "Союзник",
  self: "Только вы"
});

export const ABILITY_RANGE_MODES = Object.freeze({
  none: "Не указана",
  adjacent: "Соседняя цель",
  spell: "Дистанция заклинаний",
  weapon: "Дистанция выбранной атаки/оружия",
  cells: "Клетки",
  sight: "В пределах видимости",
  manual: "Частное правило"
});

// Legacy 0.5.55.4 area representation. Kept only for reading old Items.
export const ABILITY_AREA_SHAPES = Object.freeze({
  none: "Нет",
  zone: "Зона / прямоугольник",
  line: "Линия",
  radius: "Радиус",
  cone: "Конус",
  manual: "Частная область"
});

// 0.5.55.5 Rulebook 6.4 standard area vocabulary. Absence of presets means
// "Нет". Complex geometries deliberately remain Special and have no ruler.
export const ABILITY_AREA_PRESET_TYPES = Object.freeze({
  square: "Квадрат",
  rectangle: "Прямоугольник",
  line: "Линия",
  special: "Особая"
});

function positiveInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values = []) {
  const result = [];
  const seen = new Set();
  for (const value of Array.from(values ?? [])) {
    const id = text(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function rawSystem(itemOrSystem) {
  return itemOrSystem?.system ?? itemOrSystem ?? {};
}

function legacyImplementation(system) {
  const stored = system.costs ?? {};
  const legacyClassCost = positiveInt(system.classResourceCost, 0);
  const storedMin = positiveInt(stored.classResourceMin, 0);
  const storedMax = positiveInt(stored.classResourceMax, 0);
  const classResource = storedMin || legacyClassCost || storedMax || 0;
  return {
    id: "legacy",
    name: "Основная реализация",
    description: "",
    traitIds: uniqueStrings(system.traitIds),
    costs: {
      action: positiveInt(stored.action, 0),
      movement: positiveInt(stored.movement, 0),
      intervention: positiveInt(stored.intervention, 0),
      freeAction: Boolean(stored.freeAction),
      classResource,
      additionalText: String(stored.additionalText ?? "")
    },
    targeting: system.targeting ?? {},
    areas: [],
    conditionText: String(system.conditionText ?? ""),
    requirementText: String(system.requirementText ?? ""),
    limitationText: String(system.limitationText ?? ""),
    exceptionText: String(system.exceptionText ?? ""),
    check: system.check ?? {},
    actionTraits: system.actionTraits ?? {},
    defenseProcedure: system.defenseProcedure ?? {},
    attackCheck: system.attackCheck ?? {},
    profiles: system.profiles ?? {},
    outcomes: system.outcomes ?? {},
    outcome: system.outcome ?? {},
    actionParts: Array.from(system.actionParts ?? []),
    defenseAction: system.defenseAction ?? {},
    effectUuids: uniqueStrings(system.effectUuids),
    repeat: { count: 1, label: "Результат" },
    legacy: true
  };
}

export function abilityImplementations(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  const stored = Array.from(system.implementations ?? []);
  if (!stored.length) return [legacyImplementation(system)];
  return stored.map((entry, index) => ({
    ...entry,
    id: text(entry?.id) || `implementation-${index + 1}`,
    name: text(entry?.name) || `Реализация ${index + 1}`,
    repeat: {
      count: Math.max(1, positiveInt(entry?.repeat?.count, 1)),
      label: text(entry?.repeat?.label) || "Результат"
    },
    legacy: false
  }));
}

export function abilityImplementation(itemOrSystem, implementationId = null) {
  const implementations = abilityImplementations(itemOrSystem);
  if (!implementationId) return implementations[0] ?? null;
  const id = text(implementationId);
  return implementations.find(entry => text(entry.id) === id) ?? implementations[0] ?? null;
}

/**
 * Build a lightweight runtime view which preserves the parent Item identity but
 * exposes one implementation as the executable system. Existing resolvers can
 * therefore stay generic and never parse prose or mutate the Item document.
 */
export function abilityImplementationRuntime(item, implementationId = null) {
  const implementation = abilityImplementation(item, implementationId);
  if (!implementation) return item;
  const base = rawSystem(item);
  return {
    uuid: item?.uuid ?? null,
    id: item?.id ?? null,
    type: item?.type ?? "ability",
    name: item?.name ?? "",
    parent: item?.parent ?? null,
    implementationId: implementation.id,
    implementationName: implementation.name,
    system: {
      ...base,
      ...implementation,
      // Container identity remains common to all realizations.
      description: implementation.description || base.description || "",
      category: base.category,
      level: base.level,
      defenseModifier: base.defenseModifier,
      rules: base.rules,
      // A realization has one exact special-resource cost.
      classResourceCost: positiveInt(implementation.costs?.classResource, 0),
      costs: {
        ...(implementation.costs ?? {}),
        classResourceMin: positiveInt(implementation.costs?.classResource, 0),
        classResourceMax: positiveInt(implementation.costs?.classResource, 0)
      }
    }
  };
}


/**
 * Optional 0.5.77 explicit ActionPart definitions stored on an implementation.
 * Empty means the implementation remains one logical Part and repeat.count
 * expands it through ActionState v2. The helper only normalizes shape; it does
 * not infer rules from prose.
 */
export function abilityActionParts(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  return Array.from(system.actionParts ?? []).map((part, index) => ({
    ...part,
    id: text(part?.id) || `part-${index + 1}`,
    label: text(part?.label) || `Результат ${index + 1}`,
    traitIds: uniqueStrings(part?.traitIds),
    targetSlots: Array.from(part?.targetSlots ?? []).map((slot, slotIndex) => ({
      ...slot,
      id: text(slot?.id) || `target-${slotIndex + 1}`,
      label: text(slot?.label) || `Цель ${slotIndex + 1}`,
      roles: uniqueStrings(slot?.roles),
      selectionMode: ["manual", "source"].includes(text(slot?.selectionMode))
        ? text(slot.selectionMode)
        : "manual",
      min: positiveInt(slot?.min, 0),
      max: positiveInt(slot?.max, 0),
      allowDuplicates: Boolean(slot?.allowDuplicates)
    })),
    outcomeComponents: Array.from(part?.outcomeComponents ?? []).map((component, componentIndex) => ({
      ...component,
      id: text(component?.id) || `component-${componentIndex + 1}`,
      type: text(component?.type) || "manual",
      label: text(component?.label),
      dependsOn: Array.from(component?.dependsOn ?? []).map(dep => ({ ...dep }))
    })),
    repeat: {
      count: Math.max(1, positiveInt(part?.repeat?.count, 1)),
      label: text(part?.repeat?.label) || text(part?.label) || "Результат"
    }
  }));
}

export function abilityImplementationLabel(itemOrSystem, implementationId = null) {
  return abilityImplementation(itemOrSystem, implementationId)?.name ?? "Основная реализация";
}

export function abilityImplementationRepeat(itemOrSystem, implementationId = null) {
  // Runtime views already expose the selected realization as their system. Do
  // not re-enter the parent implementations[] array, otherwise repeat/count
  // would silently fall back to the first realization.
  if (itemOrSystem?.implementationId && (!implementationId || implementationId === itemOrSystem.implementationId)) {
    const runtimeSystem = rawSystem(itemOrSystem);
    return {
      count: Math.max(1, positiveInt(runtimeSystem?.repeat?.count, 1)),
      label: text(runtimeSystem?.repeat?.label) || "Результат"
    };
  }
  const implementation = abilityImplementation(itemOrSystem, implementationId);
  return {
    count: Math.max(1, positiveInt(implementation?.repeat?.count, 1)),
    label: text(implementation?.repeat?.label) || "Результат"
  };
}

/** Canonical structured traits for one executable realization. */
export function abilityTraitIds(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  const result = new Set(uniqueStrings(system.traitIds));
  const legacy = system.actionTraits ?? {};

  if (legacy.melee) result.add("melee");
  if (legacy.ranged) result.add("ranged");
  if (legacy.area) result.add("area");
  if (legacy.intervention) result.add("intervention");

  if (String(system.category ?? "") === "spell") result.add("spell");
  if (system.defenseAction?.enabled) result.add("defensive");
  if (positiveInt(system.costs?.intervention, 0) > 0) result.add("intervention");

  return Array.from(result);
}

export function abilityIsSpell(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  if (String(system.category ?? "") === "spell") return true;
  const implementations = Array.from(system.implementations ?? []);
  if (implementations.length) {
    return implementations.some(implementation =>
      abilityTraitIds({ system: { ...implementation, category: system.category } }).includes("spell")
    );
  }
  return abilityTraitIds(itemOrSystem).includes("spell");
}

export function abilityTraitLabels(itemOrSystem) {
  return abilityTraitIds(itemOrSystem).map(id => ABILITY_TRAITS[id] ?? id);
}

export function abilityCosts(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  const stored = system.costs ?? {};
  const exact = positiveInt(stored.classResource, -1);
  const legacyClassCost = positiveInt(system.classResourceCost, 0);
  const storedMin = positiveInt(stored.classResourceMin, 0);
  const storedMax = positiveInt(stored.classResourceMax, 0);
  const useLegacyClassCost = storedMin === 0 && storedMax === 0 && legacyClassCost > 0;
  const classMin = exact >= 0
    ? exact
    : useLegacyClassCost ? legacyClassCost : storedMin;
  const classMax = exact >= 0
    ? exact
    : useLegacyClassCost ? legacyClassCost : Math.max(classMin, storedMax);

  return {
    action: positiveInt(stored.action, 0),
    movement: positiveInt(stored.movement, 0),
    intervention: positiveInt(stored.intervention, 0),
    freeAction: Boolean(stored.freeAction),
    classResource: classMin,
    classResourceMin: classMin,
    classResourceMax: classMax,
    additionalText: String(stored.additionalText ?? "")
  };
}

export function abilityCostLabel(itemOrSystem, actor = null) {
  const costs = abilityCosts(itemOrSystem);
  const chunks = [];

  if (costs.freeAction) chunks.push("свободное действие");
  if (costs.action > 0) chunks.push(`${costs.action} Воздействи${costs.action === 1 ? "е" : "я"}`);
  if (costs.movement > 0) chunks.push(`${costs.movement} Движени${costs.movement === 1 ? "е" : "я"}`);
  if (costs.intervention > 0) chunks.push(`${costs.intervention} Вмешательств${costs.intervention === 1 ? "о" : "а"}`);

  if (costs.classResourceMin > 0 || costs.classResourceMax > 0) {
    const label = text(actor?.system?.classResource?.label) || "классового ресурса";
    const amount = costs.classResourceMax > costs.classResourceMin
      ? `${costs.classResourceMin}–${costs.classResourceMax}`
      : `${costs.classResourceMin}`;
    chunks.push(`${amount} ${label}`);
  }

  return chunks.join(" + ") || "—";
}

function areaPresetId(source, index) {
  return text(source?.id) || `area-${index + 1}`;
}

function parseLegacyAreaDimensions(value) {
  const match = text(value).match(/(\d+)\s*[x×х]\s*(\d+)/i);
  if (!match) return null;
  return { width: positiveInt(match[1], 1), height: positiveInt(match[2], 1) };
}

function legacyAreaPresets(system) {
  const source = system?.targeting ?? {};
  const shape = text(source.areaShape || "none");
  const size = text(source.areaSize);
  if (!shape || shape === "none") return [];

  if (shape === "zone") {
    const dimensions = parseLegacyAreaDimensions(size) ?? { width: 1, height: 1 };
    return [{
      id: "legacy-area",
      type: dimensions.width === dimensions.height ? "square" : "rectangle",
      label: "",
      width: dimensions.width,
      height: dimensions.height,
      length: 0,
      lineWidth: 1,
      text: "",
      legacy: true
    }];
  }

  if (shape === "line") {
    const length = positiveInt(size.match(/\d+/)?.[0], 0);
    return [{ id: "legacy-area", type: "line", label: "", width: 0, height: 0, length, lineWidth: 1, text: "", legacy: true }];
  }

  // Radius/cone/manual are no longer standard Rulebook 6.4 shapes. Preserve
  // their wording without inventing geometry.
  return [{
    id: "legacy-area",
    type: "special",
    label: ABILITY_AREA_SHAPES[shape] ?? "Особая",
    width: 0,
    height: 0,
    length: 0,
    lineWidth: 1,
    text: size ? `<p>${ABILITY_AREA_SHAPES[shape] ?? "Особая"}: ${size}</p>` : "",
    legacy: true
  }];
}

export function abilityAreaPresets(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  const stored = Array.from(system.areas ?? []);
  if (!stored.length) return legacyAreaPresets(system);
  return stored.map((source, index) => {
    const type = Object.hasOwn(ABILITY_AREA_PRESET_TYPES, source?.type) ? source.type : "special";
    const width = Math.max(1, positiveInt(source?.width, type === "square" || type === "rectangle" ? 1 : 0));
    const height = type === "square" ? width : Math.max(1, positiveInt(source?.height, type === "rectangle" ? 1 : 0));
    return {
      id: areaPresetId(source, index),
      type,
      label: text(source?.label),
      width,
      height,
      length: Math.max(1, positiveInt(source?.length, type === "line" ? 1 : 0)),
      lineWidth: Math.max(1, positiveInt(source?.lineWidth, 1)),
      text: String(source?.text ?? ""),
      legacy: false
    };
  });
}

export function abilityAreaPresetLabel(preset) {
  if (!preset) return "";
  if (text(preset.label)) return text(preset.label);
  if (preset.type === "square") return `Квадрат ${preset.width}×${preset.width}`;
  if (preset.type === "rectangle") return `Прямоугольник ${preset.width}×${preset.height}`;
  if (preset.type === "line") return `Линия ${preset.length}×${preset.lineWidth}`;
  return "Особая область";
}

export function abilityTargeting(itemOrSystem) {
  const system = rawSystem(itemOrSystem);
  const source = system.targeting ?? {};
  const mode = Object.hasOwn(ABILITY_TARGET_MODES, source.mode) ? source.mode : "none";
  const relation = Object.hasOwn(ABILITY_TARGET_RELATIONS, source.relation) ? source.relation : "any";
  const rangeMode = Object.hasOwn(ABILITY_RANGE_MODES, source.rangeMode) ? source.rangeMode : "none";
  const areaShape = Object.hasOwn(ABILITY_AREA_SHAPES, source.areaShape) ? source.areaShape : "none";
  const countMin = positiveInt(source.countMin, mode === "single" ? 1 : 0);
  const countMax = Math.max(countMin, positiveInt(source.countMax, countMin));

  return {
    mode,
    relation,
    countMin,
    countMax,
    rangeMode,
    rangeCells: positiveInt(source.rangeCells, 0),
    requiresVisibility: Boolean(source.requiresVisibility),
    areaShape,
    areaSize: text(source.areaSize),
    text: String(source.text ?? "")
  };
}

export function abilityTargetSummary(itemOrSystem) {
  const target = abilityTargeting(itemOrSystem);
  if (target.mode === "none") return "";
  const chunks = [ABILITY_TARGET_MODES[target.mode] ?? target.mode];
  if (["single", "multiple"].includes(target.mode)) {
    const relation = ABILITY_TARGET_RELATIONS[target.relation] ?? target.relation;
    if (target.mode === "multiple") {
      const count = target.countMax > target.countMin ? `${target.countMin}–${target.countMax}` : `${target.countMax}`;
      chunks.push(`${count} · ${relation}`);
    } else if (target.relation !== "any") chunks.push(relation);
  }
  if (target.requiresVisibility) chunks.push("видимая");
  return chunks.join(" · ");
}

export function abilityRangeSummary(itemOrSystem) {
  const target = abilityTargeting(itemOrSystem);
  if (target.rangeMode === "none") return "";
  if (target.rangeMode === "cells") return `${target.rangeCells} кл.`;
  return ABILITY_RANGE_MODES[target.rangeMode] ?? target.rangeMode;
}

export function abilityAreaSummary(itemOrSystem) {
  const areas = abilityAreaPresets(itemOrSystem);
  return areas.map(abilityAreaPresetLabel).filter(Boolean).join(" / ");
}

export function abilityProfile(itemOrSystem, degree) {
  const system = rawSystem(itemOrSystem);
  const key = Object.hasOwn(ABILITY_PROFILE_DEGREES, degree) ? degree : "success";
  const profile = system.profiles?.[key] ?? {};
  return {
    degree: key,
    enabled: Boolean(profile.enabled),
    text: String(profile.text ?? ""),
    damage: {
      enabled: Boolean(profile.damage?.enabled),
      components: Array.from(profile.damage?.components ?? []),
      removeHighest: positiveInt(profile.damage?.removeHighest, 0),
      removeLowest: positiveInt(profile.damage?.removeLowest, 0),
      removeAll: Boolean(profile.damage?.removeAll)
    },
    healing: { enabled: Boolean(profile.healing?.enabled), components: Array.from(profile.healing?.components ?? []) },
    tempHp: { enabled: Boolean(profile.tempHp?.enabled), components: Array.from(profile.tempHp?.components ?? []) },
    effectUuids: uniqueStrings(profile.effectUuids)
  };
}

export function abilityHasDegreeProfiles(itemOrSystem) {
  return Object.keys(ABILITY_PROFILE_DEGREES).some(degree => abilityProfile(itemOrSystem, degree).enabled);
}

export function abilityOutcomeChannelForDegree(itemOrSystem, kind, degree = null) {
  if (!["damage", "healing", "tempHp"].includes(kind)) return { enabled: false, components: [], fromProfile: false };

  if (degree && Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) {
    const profile = abilityProfile(itemOrSystem, degree);
    const anyProfiles = abilityHasDegreeProfiles(itemOrSystem);
    const channel = profile[kind];
    if (profile.enabled && channel?.enabled) {
      return { ...channel, enabled: true, components: Array.from(channel.components ?? []), fromProfile: true, degree };
    }
    if (anyProfiles) return { ...channel, enabled: false, components: [], fromProfile: true, degree };
  }

  const system = rawSystem(itemOrSystem);
  const modern = system.outcomes?.[kind] ?? null;
  const legacy = system.outcome ?? null;
  const legacyMatches = String(legacy?.kind ?? "none") === kind;
  const modernComponents = Array.from(modern?.components ?? []);
  const legacyComponents = legacyMatches ? Array.from(legacy?.components ?? []) : [];
  return {
    enabled: Boolean(modern?.enabled) || legacyMatches,
    components: modernComponents.length ? modernComponents : legacyComponents,
    fromProfile: false,
    degree: degree ?? null
  };
}

export function abilityConfiguredOutcomeKinds(itemOrSystem, degree = null) {
  return ["damage", "healing", "tempHp"].filter(kind => abilityOutcomeChannelForDegree(itemOrSystem, kind, degree).enabled);
}
