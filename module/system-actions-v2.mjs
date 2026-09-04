import { startSystemActionV2 } from "./ability-action-v2.mjs";

/**
 * Fast NRI 0.5.79 — canonical system Maneuver / Skill Action descriptors.
 *
 * These are thin structured adapters into ActionState v2. They do not own
 * chat-card orchestration, Defense resolution or Application. Consequences
 * that require a positional/user choice remain manual FinalResult streams.
 */

const FAILURE = "Провал — непосредственного результата нет.";
const PARTIAL = "Частичный успех — непосредственного результата нет.";

function die(value) {
  const text = String(value ?? "").trim();
  return /^\d*d\d+(?:\s*[+-]\s*\d+)?$/i.test(text) ? text : "";
}

function actorSkillFormula(actor, skillId) {
  const skill = die(actor?.system?.skills?.[skillId]);
  return skill ? `1d20 + ${skill}` : "1d20";
}

function actorManeuverFormula(actor) {
  if (actor?.type === "creature") {
    const mod = Number(actor?.system?.attackModifier);
    return Number.isFinite(mod) && mod !== 0 ? `1d20 ${mod >= 0 ? "+" : "-"} ${Math.abs(mod)}` : "1d20";
  }
  const athletics = die(actor?.system?.skills?.athletics);
  const combat = die(actor?.system?.combatDie);
  const terms = [athletics, combat].filter(Boolean);
  return terms.length ? `1d20 + ${terms.join(" + ")}` : "1d20";
}

function targetSlot({ relation = "enemy", rangeMode = "none", rangeCells = 0, multiple = false } = {}) {
  return {
    id: "target",
    label: multiple ? "Цели" : "Цель",
    roles: ["resolution", "recipient"],
    selectionMode: "manual",
    min: 1,
    max: multiple ? 0 : 1,
    allowDuplicates: false,
    relation,
    rangeMode,
    rangeCells,
    requiresVisibility: false
  };
}

function manualOutcome({ id = "result", type = "manual", label = "Результат", texts = {}, maneuverId = null } = {}) {
  return {
    id,
    type,
    label,
    recipientType: "targetSlot",
    targetSlotId: "target",
    degreeSourceTargetSlotId: "target",
    degreeSourceType: type === "maneuver" ? "effect-degree" : "degree",
    valueSourceType: "manual",
    resultTextByDegree: texts,
    ...(maneuverId ? { maneuverId } : {})
  };
}

function healingOutcome() {
  const component = { formula: "1d4", traitIds: ["healing"], damageType: "physical" };
  return {
    id: "healing",
    type: "healing",
    label: "Первая помощь",
    recipientType: "targetSlot",
    targetSlotId: "target",
    degreeSourceTargetSlotId: "target",
    degreeSourceType: "degree",
    valueSourceType: "roll",
    components: [component],
    enabledByDegree: { failure: false, partial: false, success: true, great: true },
    componentsByDegree: { failure: [], partial: [], success: [component], great: [component] }
  };
}

function actionSystem({ sourceKind, traitIds, check, slot, outcome, costs = {}, targeting = {} }) {
  return {
    category: sourceKind === "maneuver" ? "maneuver" : "skill",
    traitIds,
    costs: {
      action: Number(costs.action ?? 1),
      movement: 0,
      intervention: 0,
      freeAction: Boolean(costs.freeAction),
      classResource: 0,
      classResourceMin: 0,
      classResourceMax: 0,
      additionalText: String(costs.additionalText ?? "")
    },
    targeting: {
      mode: targeting.mode ?? "single",
      relation: targeting.relation ?? slot.relation ?? "any",
      countMin: 1,
      countMax: targeting.mode === "multiple" ? 0 : 1,
      rangeMode: targeting.rangeMode ?? slot.rangeMode ?? "none",
      rangeCells: Number(targeting.rangeCells ?? slot.rangeCells ?? 0),
      requiresVisibility: false,
      text: ""
    },
    check,
    defenseProcedure: { directedDefense: false },
    profiles: {},
    outcomes: {},
    effectUuids: [],
    repeat: { count: 1, label: "Результат" },
    actionParts: [{
      id: "action",
      label: "Результат",
      traitIds,
      check,
      targetSlots: [slot],
      outcomeComponents: [outcome],
      repeat: { count: 1, label: "Результат" }
    }]
  };
}

export function systemActionDescriptor(actor, id) {
  const maneuverFormula = actorManeuverFormula(actor);
  const commonManeuver = {
    sourceKind: "maneuver",
    traitIds: ["action", "skill-action", "maneuver"],
    costs: { action: 1 }
  };

  const actions = {
    "maneuver-trip": {
      id: "maneuver-trip", name: "Сбить с ног", sourceKind: "maneuver",
      system: actionSystem({ ...commonManeuver,
        check: { enabled: true, formula: maneuverFormula, targetCharacteristic: "reflex" },
        slot: targetSlot({ relation: "enemy", rangeMode: "adjacent" }),
        outcome: manualOutcome({ type: "maneuver", label: "Сбить с ног", maneuverId: "trip", texts: {
          failure: FAILURE, partial: PARTIAL, success: "Цель Сбита с ног.", great: "Цель Сбита с ног."
        }})
      })
    },
    "maneuver-grab": {
      id: "maneuver-grab", name: "Захватить", sourceKind: "maneuver",
      system: actionSystem({ ...commonManeuver,
        check: { enabled: true, formula: maneuverFormula, targetCharacteristic: "fortitude" },
        slot: targetSlot({ relation: "enemy", rangeMode: "adjacent" }),
        outcome: manualOutcome({ type: "maneuver", label: "Захватить", maneuverId: "grab", texts: {
          failure: FAILURE, partial: PARTIAL, success: "Цель становится Захваченной вами.", great: "Цель становится Захваченной вами."
        }})
      })
    },
    "maneuver-move": {
      id: "maneuver-move", name: "Переместить", sourceKind: "maneuver",
      system: actionSystem({ ...commonManeuver,
        check: { enabled: true, formula: maneuverFormula, targetCharacteristic: "fortitude" },
        slot: targetSlot({ relation: "enemy", rangeMode: "adjacent" }),
        outcome: manualOutcome({ type: "maneuver", label: "Переместить", maneuverId: "move", texts: {
          failure: FAILURE, partial: PARTIAL,
          success: "Переместите цель на 1 клетку рядом с собой или на 1 клетку от себя.",
          great: "Переместите цель на 1 клетку рядом с собой или от себя; затем можете Сбить с ног или Захватить, если способны удерживать цель."
        }})
      })
    },
    "maneuver-push": {
      id: "maneuver-push", name: "Толкнуть", sourceKind: "maneuver",
      system: actionSystem({ ...commonManeuver,
        check: { enabled: true, formula: maneuverFormula, targetCharacteristic: "fortitude" },
        slot: targetSlot({ relation: "enemy", rangeMode: "adjacent" }),
        outcome: manualOutcome({ type: "maneuver", label: "Толкнуть", maneuverId: "push", texts: {
          failure: FAILURE, partial: PARTIAL,
          success: "Переместите цель на 1 клетку от себя.",
          great: "Переместите цель на 1 клетку от себя; затем цель Сбита с ног."
        }})
      })
    },
    "skill-escape-athletics": skillDescriptor({
      id: "skill-escape-athletics", name: "Вырваться — Атлетика", skillId: "athletics", targetCharacteristic: "fortitude",
      texts: { failure: FAILURE, partial: PARTIAL, success: "Выбранный Захват заканчивается.", great: "Выбранный Захват заканчивается." }
    }),
    "skill-escape-acrobatics": skillDescriptor({
      id: "skill-escape-acrobatics", name: "Вырваться — Акробатика", skillId: "acrobatics", targetCharacteristic: "fortitude",
      texts: { failure: FAILURE, partial: PARTIAL, success: "Выбранный Захват заканчивается.", great: "Выбранный Захват заканчивается." }
    }),
    "skill-slip": skillDescriptor({
      id: "skill-slip", name: "Проскользнуть", skillId: "acrobatics", targetCharacteristic: "reflex", costs: { action: 0, freeAction: true, additionalText: "во время Перемещения" },
      texts: {
        failure: "При попытке пройти через клетку существа Перемещение заканчивается перед ним; пройти через него нельзя.",
        partial: "Пройти через существо нельзя; оставшееся Перемещение можно закончить другим доступным путём.",
        success: "На этом Перемещении можно пройти через существо как через пересечённую местность.",
        great: "Как при Успехе; это существо не может использовать Быстрый удар против вас на этом Перемещении."
      }
    }),
    "skill-hide": skillDescriptor({
      id: "skill-hide", name: "Скрыться", skillId: "stealth", targetCharacteristic: "awareness", multiple: true,
      texts: { failure: FAILURE, partial: PARTIAL, success: "Вы Невидимы для этой цели, а ваша клетка ей неизвестна.", great: "Вы Невидимы для этой цели, а ваша клетка ей неизвестна." }
    }),
    "skill-first-aid": firstAidDescriptor(actor),
    "skill-distract": skillDescriptor({
      id: "skill-distract", name: "Отвлечение", skillId: "deception", targetCharacteristic: "awareness",
      texts: { failure: FAILURE, partial: PARTIAL, success: "Цель Застигнута врасплох до конца своего ближайшего хода.", great: "Цель Застигнута врасплох до конца своего ближайшего хода." }
    }),
    "skill-demoralize": skillDescriptor({
      id: "skill-demoralize", name: "Деморализовать", skillId: "intimidation", targetCharacteristic: "will",
      texts: { failure: FAILURE, partial: PARTIAL, success: "Цель получает −2 к трём порогам КЗ, Внимательности, Рефлексу, Стойкости, Воле и атакам до конца ближайшего хода.", great: "Цель получает −2 к трём порогам КЗ, Внимательности, Рефлексу, Стойкости, Воле и атакам до конца ближайшего хода." }
    })
  };
  return actions[id] ?? null;

  function skillDescriptor({ id, name, skillId, targetCharacteristic, texts, multiple = false, costs = { action: 1 } }) {
    const slot = targetSlot({ relation: "enemy", rangeMode: "none", multiple });
    const check = { enabled: true, formula: actorSkillFormula(actor, skillId), targetCharacteristic };
    return {
      id, name, sourceKind: "skill",
      system: actionSystem({ sourceKind: "skill", traitIds: ["action", "skill-action"], check, slot,
        outcome: manualOutcome({ label: name, texts }), costs,
        targeting: { mode: multiple ? "multiple" : "single", relation: "enemy" }
      })
    };
  }

  function firstAidDescriptor(actorRef) {
    const slot = targetSlot({ relation: "ally", rangeMode: "adjacent" });
    const check = { enabled: true, formula: actorSkillFormula(actorRef, "medicine"), targetCharacteristic: "armor", dc: 5 };
    return {
      id: "skill-first-aid", name: "Первая помощь", sourceKind: "skill",
      system: actionSystem({ sourceKind: "skill", traitIds: ["action", "skill-action", "healing"], check, slot,
        outcome: healingOutcome(), costs: { action: 1 }, targeting: { mode: "single", relation: "ally", rangeMode: "adjacent" }
      })
    };
  }
}

export const SYSTEM_ACTION_GROUPS = Object.freeze([
  {
    id: "maneuvers", label: "Боевые манёвры",
    actions: [
      ["maneuver-trip", "Сбить с ног"],
      ["maneuver-grab", "Захватить"],
      ["maneuver-move", "Переместить"],
      ["maneuver-push", "Толкнуть"]
    ]
  },
  {
    id: "skill-actions", label: "Основные действия навыков",
    actions: [
      ["skill-escape-athletics", "Вырваться · Атлетика"],
      ["skill-escape-acrobatics", "Вырваться · Акробатика"],
      ["skill-slip", "Проскользнуть"],
      ["skill-hide", "Скрыться"],
      ["skill-first-aid", "Первая помощь"],
      ["skill-distract", "Отвлечение"],
      ["skill-demoralize", "Деморализовать"]
    ]
  }
]);

export function systemActionGroupsForActor(actor) {
  return SYSTEM_ACTION_GROUPS.map(group => ({
    ...group,
    actions: group.actions.map(([id, label]) => {
      const descriptor = systemActionDescriptor(actor, id);
      return { id, label, formula: descriptor?.system?.check?.formula ?? "" };
    })
  }));
}

export async function startSystemActionByIdV2(actor, id, options = {}) {
  const descriptor = systemActionDescriptor(actor, id);
  if (!descriptor) return null;
  return startSystemActionV2(actor, descriptor, options);
}
