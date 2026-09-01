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

export const ABILITY_AREA_SHAPES = Object.freeze({
  none: "Нет",
  zone: "Зона / прямоугольник",
  line: "Линия",
  radius: "Радиус",
  cone: "Конус",
  manual: "Частная область"
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

/**
 * Canonical authoring traits for Ability/Spell.
 *
 * Legacy structured fields are deliberately folded in here so old Items keep
 * working without any runtime prose inference. New authoring should write
 * system.traitIds.
 */
export function abilityTraitIds(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const result = new Set(uniqueStrings(system.traitIds));
  const legacy = system.actionTraits ?? {};

  if (legacy.melee) result.add("melee");
  if (legacy.ranged) result.add("ranged");
  if (legacy.area) result.add("area");
  if (legacy.intervention) result.add("intervention");

  if (String(system.category ?? "") === "spell") result.add("spell");
  if (system.defenseAction?.enabled) result.add("defensive");

  // A structured Intervention cost is sufficient to preserve origin context
  // even if an old Item omitted the trait. This is structured data, not prose
  // inference, and is required for HB-02 to remain reliable.
  if (positiveInt(system.costs?.intervention, 0) > 0) result.add("intervention");

  return Array.from(result);
}

export function abilityIsSpell(itemOrSystem) {
  return abilityTraitIds(itemOrSystem).includes("spell");
}

export function abilityTraitLabels(itemOrSystem) {
  return abilityTraitIds(itemOrSystem).map(id => ABILITY_TRAITS[id] ?? id);
}

export function abilityCosts(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
  const stored = system.costs ?? {};
  const legacyClassCost = positiveInt(system.classResourceCost, 0);
  const storedMin = positiveInt(stored.classResourceMin, 0);
  const storedMax = positiveInt(stored.classResourceMax, 0);
  const useLegacyClassCost = storedMin === 0 && storedMax === 0 && legacyClassCost > 0;
  const classMin = useLegacyClassCost ? legacyClassCost : storedMin;
  const classMax = useLegacyClassCost
    ? legacyClassCost
    : Math.max(classMin, storedMax);

  return {
    action: positiveInt(stored.action, 0),
    movement: positiveInt(stored.movement, 0),
    intervention: positiveInt(stored.intervention, 0),
    freeAction: Boolean(stored.freeAction),
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

export function abilityTargeting(itemOrSystem) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
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

  const chunks = [];
  const modeLabel = ABILITY_TARGET_MODES[target.mode] ?? target.mode;
  chunks.push(modeLabel);

  if (["single", "multiple"].includes(target.mode)) {
    const relation = ABILITY_TARGET_RELATIONS[target.relation] ?? target.relation;
    if (target.mode === "multiple") {
      const count = target.countMax > target.countMin
        ? `${target.countMin}–${target.countMax}`
        : `${target.countMax}`;
      chunks.push(`${count} · ${relation}`);
    } else if (target.relation !== "any") {
      chunks.push(relation);
    }
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
  const target = abilityTargeting(itemOrSystem);
  if (target.areaShape === "none") return "";
  const label = ABILITY_AREA_SHAPES[target.areaShape] ?? target.areaShape;
  return target.areaSize ? `${label}: ${target.areaSize}` : label;
}

export function abilityProfile(itemOrSystem, degree) {
  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
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
    healing: {
      enabled: Boolean(profile.healing?.enabled),
      components: Array.from(profile.healing?.components ?? [])
    },
    tempHp: {
      enabled: Boolean(profile.tempHp?.enabled),
      components: Array.from(profile.tempHp?.components ?? [])
    },
    effectUuids: uniqueStrings(profile.effectUuids)
  };
}

export function abilityHasDegreeProfiles(itemOrSystem) {
  return Object.keys(ABILITY_PROFILE_DEGREES).some(degree =>
    abilityProfile(itemOrSystem, degree).enabled
  );
}

export function abilityOutcomeChannelForDegree(itemOrSystem, kind, degree = null) {
  if (!["damage", "healing", "tempHp"].includes(kind)) {
    return { enabled: false, components: [], fromProfile: false };
  }

  if (degree && Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) {
    const profile = abilityProfile(itemOrSystem, degree);
    const anyProfiles = abilityHasDegreeProfiles(itemOrSystem);
    const channel = profile[kind];
    if (profile.enabled && channel?.enabled) {
      return {
        ...channel,
        enabled: true,
        components: Array.from(channel.components ?? []),
        fromProfile: true,
        degree
      };
    }
    if (anyProfiles) {
      return {
        ...channel,
        enabled: false,
        components: [],
        fromProfile: true,
        degree
      };
    }
  }

  const system = itemOrSystem?.system ?? itemOrSystem ?? {};
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
  return ["damage", "healing", "tempHp"].filter(kind =>
    abilityOutcomeChannelForDegree(itemOrSystem, kind, degree).enabled
  );
}
