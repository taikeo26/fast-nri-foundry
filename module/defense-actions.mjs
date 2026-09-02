import {
  DEFENSE_PROCEDURE_IDS,
  actionContextDefenseProcedureIds,
  normalizeActionContext
} from "./action-context.mjs";
import { hardBlockDefenseCandidate } from "./hard-blocks.mjs";
import { abilityCosts, abilityImplementationRuntime, abilityImplementations } from "./ability-authoring.mjs";
import { resolveActorCombatTerm } from "./attack-term.mjs";

const SYSTEM_ID = "fast-nri";
const MIGRATION_SETTING = "defenseInfrastructureMigrated";

export const DEFENSE_ACTION_PROCEDURES = DEFENSE_PROCEDURE_IDS;

export const DEFENSE_TARGET_SCOPES = Object.freeze({
  ally: "Союзник",
  self: "Себя",
  either: "Себя или союзник"
});

export const DEFENSE_RANGE_MODES = Object.freeze({
  adjacent: "Соседняя цель",
  speedAdjacent: "До клетки рядом в пределах Скорости",
  cells: "Дистанция в клетках",
  manual: "По описанию / вручную"
});

export const DEFENSE_MOVEMENT_MODES = Object.freeze({
  none: "Без перемещения",
  moveAdjacent: "Переместиться рядом с целью"
});

export const DEFENSE_DAMAGE_SELECTION_MODES = Object.freeze({
  standard: "По стандартному правилу исходного действия",
  largest: "Самые большие части",
  smallest: "Самые маленькие части"
});

export const DEFENSE_MODIFIER_SCOPES = Object.freeze({
  all: "Все Защитные действия",
  self: "Только Самозащита",
  ally: "Только защита союзника"
});

function normalizeName(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
}

function positiveInt(value, fallback = 0) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function actorItems(actor) {
  return actor?.items?.contents ?? Array.from(actor?.items ?? []);
}

export function defenseActionConfig(item) {
  const config = item?.system?.defenseAction ?? {};

  return {
    enabled: Boolean(config.enabled),
    procedure: Object.hasOwn(DEFENSE_ACTION_PROCEDURES, config.procedure)
      ? config.procedure
      : "directed",
    targetScope: ["ally", "self", "either"].includes(config.targetScope)
      ? config.targetScope
      : "ally",
    interventionCost: positiveInt(config.interventionCost, 1),
    rangeMode: ["adjacent", "speedAdjacent", "cells", "manual"].includes(config.rangeMode)
      ? config.rangeMode
      : "adjacent",
    rangeCells: positiveInt(config.rangeCells, 0),
    requiresVisibility: Boolean(config.requiresVisibility),
    movementMode: ["none", "moveAdjacent"].includes(config.movementMode)
      ? config.movementMode
      : "none",
    damageSelectionMode: ["standard", "largest", "smallest"].includes(config.damageSelectionMode)
      ? config.damageSelectionMode
      : "standard",
    combatDiceFormula: String(config.combatDiceFormula ?? "").trim(),
    selfDefenseCharacteristic: ["fortitude", "reflex"].includes(config.selfDefenseCharacteristic)
      ? config.selfDefenseCharacteristic
      : "",
    removeDamageParts: positiveInt(config.removeDamageParts, 1),
    effectDegreeReduction: positiveInt(config.effectDegreeReduction, 1),
    allowManeuver: Boolean(config.allowManeuver)
  };
}

export function defenseModifierConfig(item) {
  const config = item?.system?.defenseModifier ?? {};

  return {
    enabled: Boolean(config.enabled),
    scope: ["all", "self", "ally"].includes(config.scope)
      ? config.scope
      : "all",
    combatDiceFormula: String(config.combatDiceFormula ?? "").trim()
  };
}

export function defenseRoleMatches(scope, role) {
  if (scope === "either") return role === "self" || role === "ally";
  return scope === role;
}

export function isDefenseAbilityForRole(item, role, procedure = null) {
  if (item?.type !== "ability") return false;
  const config = defenseActionConfig(item);
  if (!config.enabled || !defenseRoleMatches(config.targetScope, role)) return false;
  return !procedure || config.procedure === procedure;
}

export function defenseAbilityItems(actor, role, procedure = null) {
  return actorItems(actor)
    .filter(item => isDefenseAbilityForRole(item, role, procedure))
    .sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));
}

export function resolveDefenseCombatSource(actor, actionItem = null, role = "self") {
  const action = defenseActionConfig(actionItem);

  if (actionItem?.type === "ability" && action.combatDiceFormula) {
    return {
      formula: action.combatDiceFormula,
      label: actionItem.name,
      reason: "Формула защитного действия",
      sourceItemUuid: actionItem.uuid ?? null
    };
  }

  const modifiers = actorItems(actor)
    .filter(item => item?.type === "ability")
    .map(item => ({ item, config: defenseModifierConfig(item) }))
    .filter(({ config }) =>
      config.enabled
      && config.combatDiceFormula
      && (config.scope === "all" || config.scope === role)
    )
    .sort((a, b) => (Number(a.item.sort) || 0) - (Number(b.item.sort) || 0));

  if (modifiers.length) {
    const { item, config } = modifiers[0];
    return {
      formula: config.combatDiceFormula,
      label: item.name,
      reason: "Модификатор Защитного действия",
      sourceItemUuid: item.uuid ?? null
    };
  }

  const term = resolveActorCombatTerm(actor);
  if (!term) return null;
  return {
    formula: term.formula,
    label: term.label,
    reason: term.reason,
    sourceItemUuid: null
  };
}

export function tokenFootprint(tokenLike, gridSize = null) {
  const document = tokenLike?.document ?? tokenLike ?? {};
  const size = Number(gridSize)
    || Number(globalThis.canvas?.dimensions?.size)
    || Number(globalThis.canvas?.grid?.size)
    || 1;

  const x = Number(document.x ?? tokenLike?.x ?? 0) || 0;
  const y = Number(document.y ?? tokenLike?.y ?? 0) || 0;
  const width = Math.max(0, Number(document.width ?? 1) || 1);
  const height = Math.max(0, Number(document.height ?? 1) || 1);

  return {
    left: x / size,
    top: y / size,
    right: x / size + width,
    bottom: y / size + height
  };
}

export function footprintGapCells(a, b) {
  if (!a || !b) return Infinity;

  const dx = Math.max(
    0,
    Number(b.left) - Number(a.right),
    Number(a.left) - Number(b.right)
  );

  const dy = Math.max(
    0,
    Number(b.top) - Number(a.bottom),
    Number(a.top) - Number(b.bottom)
  );

  return Math.max(dx, dy);
}

export function tokenGapCells(a, b) {
  return footprintGapCells(tokenFootprint(a), tokenFootprint(b));
}

export function tokensAdjacent(a, b) {
  if (!a || !b) return false;
  if (a === b || a?.id === b?.id) return false;
  return tokenGapCells(a, b) <= 0.001;
}

export function defenseCostLabel(itemOrConfig, actor = null) {
  const item = itemOrConfig?.type === "ability" ? itemOrConfig : null;
  const config = item ? defenseActionConfig(item) : itemOrConfig;
  const chunks = [];

  const interventions = positiveInt(config?.interventionCost, 0);
  if (interventions > 0) {
    chunks.push(`${interventions} ${interventions === 1 ? "Вмешательство" : "Вмешательства"}`);
  }

  const costs = item ? abilityCosts(item) : { classResourceMin: 0, classResourceMax: 0 };
  if (costs.classResourceMin > 0 || costs.classResourceMax > 0) {
    const label = String(actor?.system?.classResource?.label ?? "Классовый ресурс").trim();
    const amount = costs.classResourceMax > costs.classResourceMin
      ? `${costs.classResourceMin}–${costs.classResourceMax}`
      : `${costs.classResourceMin}`;
    chunks.push(`${amount} ${label || "Классового ресурса"}`);
  }

  return chunks.length ? chunks.join(" + ") : "без стоимости";
}

export function evaluateDefenseAbility({ actor, defenderToken, protectedToken, item, role }) {
  const config = defenseActionConfig(item);
  const reasons = [];
  const warnings = [];

  if (!config.enabled) reasons.push("не отмечено как Защитное действие");
  if (!defenseRoleMatches(config.targetScope, role)) warnings.push("по правилу способность не предназначена для выбранной роли цели");

  if (role === "ally") {
    if (!protectedToken?.actor) {
      reasons.push("нет выбранной защищаемой цели");
    } else if (protectedToken?.id === defenderToken?.id) {
      warnings.push("по правилу эта способность предназначена для другого существа");
    }

    if (config.rangeMode === "adjacent" && !tokensAdjacent(defenderToken, protectedToken)) {
      warnings.push("по правилу цель должна соседствовать с защитником");
    }

    if (config.rangeMode === "speedAdjacent") {
      const gap = tokenGapCells(defenderToken, protectedToken);
      const speed = Math.max(0, Number(actor?.system?.speed) || 0);
      if (Number.isFinite(gap) && gap > speed) {
        warnings.push(`по правилу до цели не должно быть больше Скорости (${speed})`);
      } else {
        warnings.push("маршрут и свободная клетка рядом с целью проверяются за столом");
      }
    }

    if (config.rangeMode === "cells") {
      const gap = tokenGapCells(defenderToken, protectedToken);
      if (Number.isFinite(gap) && gap > config.rangeCells) {
        warnings.push(`по правилу цель не должна быть дальше ${config.rangeCells} кл.`);
      }
    }

    if (config.rangeMode === "manual") {
      warnings.push("дистанция проверяется по описанию способности");
    }

    if (config.requiresVisibility && protectedToken?.visible === false) {
      warnings.push("по правилу цель должна быть видима");
    }
  }

  const intervention = Number(actor?.system?.resources?.intervention);
  if (config.interventionCost > 0 && Number.isFinite(intervention) && intervention < config.interventionCost) {
    warnings.push(`в листе ${intervention} Вмешательств из требуемых ${config.interventionCost}`);
  }

  const costs = abilityCosts(item);
  const classCost = costs.classResourceMin;
  const classValue = Number(actor?.system?.classResource?.value);
  if (classCost > 0 && Number.isFinite(classValue) && classValue < classCost) {
    warnings.push(`классового ресурса ${classValue} из минимально требуемых ${classCost}`);
  }

  return {
    disabled: reasons.length > 0,
    reasons,
    warnings
  };
}

function builtInDefenseConfig(procedure) {
  const base = {
    enabled: true,
    procedure,
    targetScope: "self",
    interventionCost: 1,
    rangeMode: "manual",
    rangeCells: 0,
    requiresVisibility: false,
    movementMode: "none",
    damageSelectionMode: "standard",
    combatDiceFormula: "",
    selfDefenseCharacteristic: "",
    removeDamageParts: procedure === "directed" ? 1 : 0,
    effectDegreeReduction: 1,
    allowManeuver: false
  };

  return base;
}

function builtInDefenseOption(actor, procedure, actionContext = {}) {
  const labels = {
    directed: "Самозащита",
    counteraction: "Противодействие",
    dodge: "Уворот"
  };
  const ids = {
    directed: "system-self-defense",
    counteraction: "system-counteraction",
    dodge: "system-dodge"
  };
  const warnings = [];
  const interventions = Number(actor?.system?.resources?.intervention);
  if (Number.isFinite(interventions) && interventions < 1) {
    warnings.push(`в листе ${interventions} Вмешательств из требуемых 1`);
  }

  if (procedure === "dodge") {
    warnings.push("перемещение Уворота и достижение безопасного места подтверждаются игроком вручную");
  }

  const hardBlock = hardBlockDefenseCandidate(actionContext, {
    interventionCost: 1,
    actionName: labels[procedure],
    actionTraits: { intervention: true }
  });

  return {
    id: ids[procedure],
    kind: "builtin",
    procedure,
    actionName: labels[procedure],
    item: null,
    config: builtInDefenseConfig(procedure),
    disabled: hardBlock.blocked,
    reasons: hardBlock.blocked ? [hardBlock.message] : [],
    warnings,
    hardBlock,
    costLabel: "1 Вмешательство"
  };
}

/**
 * Canonical defense resolver (0.5.53+, with HB-02 enforcement from 0.5.54).
 *
 * It returns every currently applicable defense instead of selecting one for
 * the player. Standard procedures and Ability-provided defenses are combined;
 * a special Ability therefore never removes the built-in option by itself.
 */
export function resolveDefenseOptions({
  actor,
  defenderToken = null,
  protectedToken = null,
  role = "self",
  actionContext = {},
  defenseHistory = [],
  procedures = null
} = {}) {
  const context = normalizeActionContext(actionContext);
  const allowed = new Set(actionContextDefenseProcedureIds(context));
  const requested = procedures
    ? new Set(Array.isArray(procedures) ? procedures : [procedures])
    : null;
  const activeProcedures = Array.from(allowed).filter(id => !requested || requested.has(id));
  const options = [];

  const alreadyUsed = Array.from(defenseHistory ?? []).some(entry =>
    entry?.actorUuid === actor?.uuid
  );

  if (role === "self") {
    for (const procedure of activeProcedures) {
      const option = builtInDefenseOption(actor, procedure, context);
      if (alreadyUsed) {
        option.warnings.push("этот персонаж уже использовал защиту в этой цепочке");
      }
      options.push(option);
    }
  }

  for (const item of actorItems(actor)) {
    if (item?.type !== "ability") continue;
    for (const implementation of abilityImplementations(item)) {
      const runtime = abilityImplementationRuntime(item, implementation.id);
      const config = defenseActionConfig(runtime);
      if (!config.enabled) continue;
      if (!activeProcedures.includes(config.procedure)) continue;

      const availability = evaluateDefenseAbility({
        actor,
        defenderToken,
        protectedToken,
        item: runtime,
        role
      });

      if (alreadyUsed) availability.warnings.push("этот персонаж уже использовал защиту в этой цепочке");

      const actionName = abilityImplementations(item).length > 1
        ? `${item.name} — ${implementation.name}`
        : item.name;
      const hardBlock = hardBlockDefenseCandidate(context, {
        interventionCost: config.interventionCost,
        item: runtime,
        actionName,
        actionTraits: runtime.system?.actionTraits ?? {}
      });
      if (hardBlock.blocked) {
        availability.disabled = true;
        availability.reasons.push(hardBlock.message);
      }

      options.push({
        id: implementation.legacy ? `ability-${item.id}` : `ability-${item.id}-${implementation.id}`,
        kind: "ability",
        procedure: config.procedure,
        actionName,
        item,
        implementationId: implementation.id,
        runtime,
        config,
        disabled: availability.disabled,
        reasons: availability.reasons,
        warnings: availability.warnings,
        hardBlock,
        costLabel: defenseCostLabel(runtime, actor)
      });
    }
  }

  return options;
}

/** Resolve defenses strictly from the Actor embedded in the selected defender Token. */
export function resolveDefenseOptionsForToken({
  defenderToken = null,
  protectedToken = null,
  role = "self",
  actionContext = {},
  defenseHistory = [],
  procedures = null
} = {}) {
  const actor = defenderToken?.actor ?? null;
  if (!actor) return [];
  return resolveDefenseOptions({
    actor,
    defenderToken,
    protectedToken,
    role,
    actionContext,
    defenseHistory,
    procedures
  });
}

export function actionHasDefenseProcedure(actionContext, procedure) {
  return actionContextDefenseProcedureIds(actionContext).includes(String(procedure ?? ""));
}

export function registerDefenseActionSettings() {
  game.settings.register(SYSTEM_ID, MIGRATION_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: false
  });
}

const MIGRATION_PRESETS = Object.freeze({
  "защита союзника": {
    defenseAction: {
      enabled: true,
      procedure: "directed",
      targetScope: "ally",
      interventionCost: 1,
      rangeMode: "adjacent",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: true
    }
  },
  "рывок на защиту": {
    defenseAction: {
      enabled: true,
      procedure: "directed",
      targetScope: "ally",
      interventionCost: 2,
      rangeMode: "speedAdjacent",
      rangeCells: 0,
      requiresVisibility: true,
      movementMode: "moveAdjacent",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: true
    }
  },
  "прикрытие": {
    defenseAction: {
      enabled: true,
      procedure: "directed",
      targetScope: "ally",
      interventionCost: 1,
      rangeMode: "adjacent",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: true
    }
  },
  "мультикласс защитника — прикрытие": {
    defenseAction: {
      enabled: true,
      procedure: "directed",
      targetScope: "ally",
      interventionCost: 1,
      rangeMode: "adjacent",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: true
    }
  },
  "защитный щит": {
    classResourceCost: 1,
    defenseAction: {
      enabled: true,
      procedure: "directed",
      targetScope: "ally",
      interventionCost: 1,
      rangeMode: "manual",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "largest",
      combatDiceFormula: "",
      removeDamageParts: 2,
      effectDegreeReduction: 2,
      allowManeuver: true
    }
  },
  "всегда готов": {
    defenseModifier: {
      enabled: true,
      scope: "all",
      combatDiceFormula: "2d6"
    }
  }
});

function migrationUpdateFor(item) {
  if (item?.type !== "ability") return null;
  const preset = MIGRATION_PRESETS[normalizeName(item.name)];
  if (!preset) return null;

  const update = {};

  if (preset.defenseAction && !item.system?.defenseAction?.enabled) {
    for (const [key, value] of Object.entries(preset.defenseAction)) {
      update[`system.defenseAction.${key}`] = value;
    }
  }

  if (preset.defenseModifier && !item.system?.defenseModifier?.enabled) {
    for (const [key, value] of Object.entries(preset.defenseModifier)) {
      update[`system.defenseModifier.${key}`] = value;
    }
  }

  if (
    Number.isFinite(Number(preset.classResourceCost))
    && (Number(item.system?.classResourceCost) || 0) <= 0
  ) {
    update["system.classResourceCost"] = preset.classResourceCost;
  }

  return Object.keys(update).length ? update : null;
}

export async function migrateDefenseAbilitiesOnce() {
  if (!game.user.isGM) return;
  if (game.settings.get(SYSTEM_ID, MIGRATION_SETTING)) return;

  const items = [
    ...Array.from(game.items ?? []),
    ...Array.from(game.actors ?? []).flatMap(actor => Array.from(actor.items ?? []))
  ];

  let changed = 0;

  try {
    for (const item of items) {
      const update = migrationUpdateFor(item);
      if (!update) continue;
      await item.update(update);
      changed += 1;
    }

    await game.settings.set(SYSTEM_ID, MIGRATION_SETTING, true);
    console.log(`Быстрая НРИ | Инфраструктура Защитных Ability: обновлено ${changed} Item(s).`);
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка миграции Защитных Ability", error);
    ui.notifications.error("Не удалось автоматически разметить защитные способности.");
  }
}
