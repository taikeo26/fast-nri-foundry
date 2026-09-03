/**
 * Registry of the deliberately small set of gameplay hard blocks accepted by
 * the Fast NRI Foundry architecture. Rulebook restrictions which are not
 * listed here must remain warnings/manual control rather than gates.
 */

export const HARD_BLOCK_IDS = Object.freeze({
  heldItems: "HB-01",
  interventionChain: "HB-02",
  masteryRequiresProficiency: "HB-03",
  weaponCategoryByType: "HB-04",
  duplicateTargetSelection: "HB-05"
});

export const HARD_BLOCK_REGISTRY = Object.freeze({
  [HARD_BLOCK_IDS.heldItems]: Object.freeze({
    id: HARD_BLOCK_IDS.heldItems,
    key: "held-items",
    label: "Предметы в руках",
    scope: "Физическая конфигурация удерживаемых предметов и использование предмета, который должен быть в руках.",
    blocks: "Невозможную конфигурацию рук и использование требующего удержания предмета без нужного числа занятых им рук.",
    doesNotBlock: "Тактический выбор предмета, действия или экипировки по выгоде; прочие требования предметов без отдельной записи реестра.",
    ui: "Невозможное состояние не применяется; штатные команды рук дают понятную обратную связь.",
    enforcement: "equipment"
  }),
  [HARD_BLOCK_IDS.interventionChain]: Object.freeze({
    id: HARD_BLOCK_IDS.interventionChain,
    key: "intervention-chain",
    label: "Вмешательство не вызывает Вмешательство",
    scope: "Любое новое ответное действие, требующее Вмешательство, если исходный ActionContext уже происходит от Вмешательства.",
    blocks: "Самозащиту, Защиту союзника, Противодействие, Уворот, специальную защитную Ability и другое ответное Вмешательство, если они требуют нового Вмешательства.",
    doesNotBlock: "Нехватку запаса Вмешательств, спорный тайминг, повтор того же участника и последовательные Защиты обычного действия.",
    ui: "Вариант не является рабочим; обходной запуск останавливается с сообщением HB-02.",
    enforcement: "action-context"
  }),
  [HARD_BLOCK_IDS.masteryRequiresProficiency]: Object.freeze({
    id: HARD_BLOCK_IDS.masteryRequiresProficiency,
    key: "mastery-requires-proficiency",
    label: "Мастерство требует Владения",
    scope: "Структурированные списки Владений и Мастерств оружия Character Actor.",
    blocks: "Состояние, в котором typeId присутствует в Мастерствах, но отсутствует во Владениях.",
    doesNotBlock: "Ручное добавление/удаление Владений и Мастерств в допустимых сочетаниях.",
    ui: "Добавление Мастерства добавляет Владение; удаление Владения удаляет соответствующее Мастерство.",
    enforcement: "weapon-training"
  }),
  [HARD_BLOCK_IDS.weaponCategoryByType]: Object.freeze({
    id: HARD_BLOCK_IDS.weaponCategoryByType,
    key: "weapon-category-by-type",
    label: "Категория оружия привязана к типу",
    scope: "Структурированные typeId/categoryId Weapon Item.",
    blocks: "Несовместимую пару typeId/categoryId, которой нет в системном справочнике оружия.",
    doesNotBlock: "Вид атаки melee/ranged и прочие свойства Weapon.",
    ui: "Смена типа синхронизирует категорию; смена категории выбирает совместимый тип.",
    enforcement: "weapon-taxonomy"
  }),
  [HARD_BLOCK_IDS.duplicateTargetSelection]: Object.freeze({
    id: HARD_BLOCK_IDS.duplicateTargetSelection,
    key: "duplicate-target-selection",
    label: "Одна цель не добавляется дважды в один слот",
    scope: "Штатные команды добавления цели в конкретный ActionPart + TargetSlot, когда slot.allowDuplicates=false и мировая настройка HB-05 включена.",
    blocks: "Только новую повторную selection того же Token; если Token UUID отсутствует — того же Actor, уже присутствующего в этом TargetSlot.",
    doesNotBlock: "Ту же цель в другом ActionPart/TargetSlot; slots с allowDuplicates=true; существующие повторы; добавление повтора при выключенной настройке HB-05.",
    ui: "Повторная цель не добавляется, остальные новые цели добавляются штатно; пользователь получает короткое уведомление HB-05. Настройка мира может отключить этот UX-блок.",
    enforcement: "target-slot-selection",
    configurable: true,
    settingKey: "preventDuplicateTargetSelections",
    defaultEnabled: true
  })
});

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function interventionTrait(source = {}) {
  const directTraitIds = Array.from(source?.traitIds ?? []);
  const systemTraitIds = Array.from(source?.system?.traitIds ?? []);
  const directCost = Number(source?.costs?.intervention);
  const systemCost = Number(source?.system?.costs?.intervention);

  return Boolean(
    source?.intervention
    || source?.actionTraits?.intervention
    || source?.traits?.intervention
    || source?.system?.actionTraits?.intervention
    || directTraitIds.includes("intervention")
    || systemTraitIds.includes("intervention")
    || (Number.isFinite(directCost) && directCost > 0)
    || (Number.isFinite(systemCost) && systemCost > 0)
  );
}

export function hardBlockById(id) {
  return HARD_BLOCK_REGISTRY[String(id ?? "")] ?? null;
}

export function registeredHardBlocks() {
  return Object.values(HARD_BLOCK_REGISTRY);
}

export function actionContextOriginatesFromIntervention(actionContext = {}) {
  return Boolean(
    actionContext?.origin?.intervention
    || actionContext?.originActionContext?.intervention
    || interventionTrait(actionContext)
  );
}

/**
 * A candidate requires a *new* Intervention when its structured cost consumes
 * Intervention or when it is explicitly marked as an Intervention action.
 * Resource shortage itself is intentionally not part of this decision.
 */
export function actionRequiresIntervention({
  interventionCost = 0,
  actionTraits = {},
  item = null
} = {}) {
  return Boolean(
    finiteNonNegative(interventionCost) > 0
    || interventionTrait(actionTraits)
    || interventionTrait(item)
  );
}

export function evaluateInterventionHardBlock({
  sourceActionContext = {},
  interventionCost = 0,
  actionTraits = {},
  item = null,
  actionName = "ответное Вмешательство"
} = {}) {
  const rule = HARD_BLOCK_REGISTRY[HARD_BLOCK_IDS.interventionChain];
  const sourceIsIntervention = actionContextOriginatesFromIntervention(sourceActionContext);
  const requiresIntervention = actionRequiresIntervention({
    interventionCost,
    actionTraits,
    item
  });
  const blocked = sourceIsIntervention && requiresIntervention;

  return {
    id: rule.id,
    key: rule.key,
    label: rule.label,
    blocked,
    sourceIsIntervention,
    requiresIntervention,
    message: blocked
      ? `${rule.id}: «${rule.label}». ${String(actionName || "Новое ответное действие")} недоступно, потому что исходное действие уже происходит от Вмешательства.`
      : ""
  };
}

export function hardBlockDefenseCandidate(sourceActionContext, {
  interventionCost = 1,
  item = null,
  actionName = "Защита",
  actionTraits = { intervention: true }
} = {}) {
  return evaluateInterventionHardBlock({
    sourceActionContext,
    interventionCost,
    item,
    actionName,
    actionTraits
  });
}

function targetSelectionIdentity(value = {}) {
  const tokenUuid = String(value?.tokenUuid ?? "").trim();
  if (tokenUuid) return `token:${tokenUuid}`;
  const actorUuid = String(value?.actorUuid ?? "").trim();
  if (actorUuid) return `actor:${actorUuid}`;
  return "";
}

function sameTargetSelection(left = {}, right = {}) {
  const leftToken = String(left?.tokenUuid ?? "").trim();
  const rightToken = String(right?.tokenUuid ?? "").trim();
  if (leftToken && rightToken) return leftToken === rightToken;

  const leftActor = String(left?.actorUuid ?? "").trim();
  const rightActor = String(right?.actorUuid ?? "").trim();
  return Boolean(leftActor && rightActor && leftActor === rightActor);
}

/**
 * HB-05 is deliberately an operation-level UX block, not a persisted-state
 * invariant. It prevents accidental duplicate additions while leaving loaded
 * or manually-authored state untouched.
 */
export function evaluateDuplicateTargetSelectionHardBlock({
  enabled = true,
  allowDuplicates = false,
  existingSelections = [],
  candidate = null
} = {}) {
  const rule = HARD_BLOCK_REGISTRY[HARD_BLOCK_IDS.duplicateTargetSelection];
  const identity = targetSelectionIdentity(candidate);
  const duplicate = Boolean(identity) && Array.from(existingSelections ?? [])
    .some(selection => sameTargetSelection(selection, candidate));
  const blocked = Boolean(enabled) && !Boolean(allowDuplicates) && duplicate;

  return {
    id: rule.id,
    key: rule.key,
    label: rule.label,
    blocked,
    enabled: Boolean(enabled),
    allowDuplicates: Boolean(allowDuplicates),
    duplicate,
    identity,
    message: blocked
      ? `${rule.id}: «${rule.label}». Эта цель уже есть в данном слоте.`
      : ""
  };
}

export function filterDuplicateTargetSelectionsByHardBlock({
  enabled = true,
  allowDuplicates = false,
  existingSelections = [],
  candidates = []
} = {}) {
  const accepted = [];
  const blocked = [];
  const seen = Array.from(existingSelections ?? []);

  for (const candidate of Array.from(candidates ?? [])) {
    const decision = evaluateDuplicateTargetSelectionHardBlock({
      enabled,
      allowDuplicates,
      existingSelections: seen,
      candidate
    });
    if (decision.blocked) {
      blocked.push({ candidate, decision });
      continue;
    }
    accepted.push(candidate);
    seen.push(candidate);
  }

  return { accepted, blocked };
}

