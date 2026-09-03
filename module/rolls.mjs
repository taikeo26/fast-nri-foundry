import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";
import {
  CREATURE_TRAITS,
  HP_GAIN_DEFENSE_TRAITS,
  HP_GAIN_SOURCE_TRAITS,
  ITEM_PROPERTY_IDS,
  RESISTANCE_TRAITS
} from "./config.mjs";
import {
  actionHasDefenseProcedure,
  defenseActionConfig,
  defenseCostLabel,
  resolveDefenseCombatSource,
  resolveDefenseOptionsForToken
} from "./defense-actions.mjs";
import {
  itemIsEquipped,
  itemIsHeld,
  itemIsUsable,
  itemRequiresHands
} from "./equipment.mjs";
import {
  effectiveArmorForAction,
  effectiveDefenseCharacteristicForAction
} from "./target-state.mjs";
import {
  attackTypeLabel,
  defenseCharacteristicForRole,
  defenseCharacteristicLabel,
  inferWeaponAttackType,
  normalizeAttackType
} from "./attack-types.mjs";
import {
  actionContextForDefenseAction,
  actionContextFromAbility,
  actionContextFromMessage,
  actionContextFromWeapon,
  actionContextWithCheckResult,
  deriveActionContext,
  directedAttackTypeFromActionContext,
  normalizeActionContext
} from "./action-context.mjs";
import {
  abilityActionTraits,
  abilityCheckConfig,
  actionTraitsLabel,
  checkStructureWarnings,
  checkTargetCharacteristicLabel,
  directedAttackTypeFromTraits,
  normalizeActionTraits,
  normalizeCheckTargetCharacteristic
} from "./check-system.mjs";
import { hardBlockDefenseCandidate } from "./hard-blocks.mjs";
import {
  abilityConfiguredOutcomeKinds,
  abilityCosts,
  abilityHasDegreeProfiles,
  abilityImplementationRuntime,
  abilityImplementationRepeat,
  abilityIsSpell,
  abilityOutcomeChannelForDegree,
  abilityProfile
} from "./ability-authoring.mjs";
import { applyEffectToActor, effectChatCardHTML, resolveEffectDocuments } from "./effect-system.mjs";
import { formulaWithActorCombatTerm, resolveActorCombatTerm, resolveWeaponAttackTerm } from "./attack-term.mjs";
import { weaponCategoryLabel, weaponTypeLabel } from "./weapon-taxonomy.mjs";

const DEGREE_LABELS = {
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
};

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function normalizeTerm(value) {
  const term = String(value ?? "").trim();
  if (!term) return "";
  return term.replace(/^\+/, "").trim();
}

function composeFormula(baseFormula, modifiers = []) {
  const parts = [String(baseFormula).trim()];

  for (const modifier of modifiers) {
    const term = normalizeTerm(modifier.formula);
    if (!term) continue;

    if (term.startsWith("-")) parts.push(term);
    else parts.push(`+ ${term}`);
  }

  return parts.join(" ");
}

function getNaturalD20(roll) {
  const d20 = roll.dice.find(die => die.faces === 20);
  if (!d20) return null;

  const active = d20.results.find(result => result.active !== false && !result.discarded);
  return active?.result ?? null;
}

export function degreeVsDC(total, dc, naturalD20 = null) {
  if (naturalD20 === 1) return "failure";
  if (naturalD20 === 20) return "great";

  if (total < dc - 10) return "failure";
  if (total < dc) return "partial";
  if (total < dc + 10) return "success";
  return "great";
}

export function degreeVsArmor(total, armor, naturalD20 = null) {
  if (naturalD20 === 1) return "failure";

  const partial = Number(armor?.partial);
  const success = Number(armor?.success);
  const great = Number(armor?.great);

  if (![partial, success, great].every(Number.isFinite)) return null;

  if (total < partial) return "failure";
  if (total < success) return "partial";
  if (total < great) return "success";
  return "great";
}

function lowerDegree(degree, steps = 1) {
  const order = ["failure", "partial", "success", "great"];
  const index = order.indexOf(degree);
  if (index < 0) return degree ?? null;
  return order[Math.max(0, index - Math.max(0, Number(steps) || 0))];
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Future statuses may supply roll modifiers through:
 *
 * flags.fast-nri.rollModifiers = [
 *   { formula: "1d4", label: "Вдохновение", reason: "Статус" }
 * ]
 */
function collectAutomaticModifiers(actor) {
  const modifiers = [];

  for (const effect of actor?.effects ?? []) {
    if (effect.disabled) continue;

    const entries = effect.getFlag("fast-nri", "rollModifiers");
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const formula = normalizeTerm(entry?.formula);
      if (!formula) continue;

      modifiers.push({
        id: `${effect.id}-${modifiers.length}`,
        formula,
        label: entry?.label || effect.name,
        reason: entry?.reason || "",
        enabled: entry?.enabled !== false
      });
    }
  }

  return modifiers;
}

function buildDialogHTML({
  label,
  baseFormula,
  automaticModifiers,
  defaultDC,
  showDC = true,
  contextHTML = ""
}) {
  const automatic = automaticModifiers.length
    ? automaticModifiers.map((modifier, index) => `
        <label class="fast-nri-auto-mod-row">
          <input
            type="checkbox"
            class="fast-nri-auto-mod-toggle"
            data-index="${index}"
            ${modifier.enabled ? "checked" : ""}
          >
          <span class="fast-nri-roll-mod-name">${esc(modifier.label)}</span>
          <code>${esc(modifier.formula)}</code>
          <small>${esc(modifier.reason)}</small>
        </label>
      `).join("")
    : `<div class="fast-nri-roll-empty">Нет автоматических модификаторов.</div>`;

  return `
    <div class="fast-nri-roll-dialog">
      <header>
        <strong>${esc(label)}</strong>
      </header>

      ${contextHTML}

      <section class="fast-nri-roll-block">
        <label>Базовая формула</label>
        <code class="fast-nri-base-formula">${esc(baseFormula)}</code>
      </section>

      <section class="fast-nri-roll-block">
        <div class="fast-nri-roll-block-title">Автоматические эффекты</div>
        <div class="fast-nri-auto-modifiers">
          ${automatic}
        </div>
      </section>

      <section class="fast-nri-roll-block">
        <div class="fast-nri-roll-block-title">
          <span>Ручные модификаторы</span>
          <button type="button" class="fast-nri-add-manual-mod">
            <i class="fa-solid fa-plus"></i> Добавить
          </button>
        </div>

        <div class="fast-nri-manual-modifiers">
          <div class="fast-nri-manual-mod-row">
            <input class="fast-nri-manual-formula" type="text" placeholder="+1d4, -1d6, +2, -3">
            <input class="fast-nri-manual-reason" type="text" placeholder="Причина">
            <button type="button" class="fast-nri-remove-manual-mod" title="Удалить">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      </section>

      ${showDC ? `
        <section class="fast-nri-roll-dc-row">
          <label>
            Сложность
            <input
              class="fast-nri-roll-dc"
              type="number"
              step="1"
              placeholder="необязательно"
              value="${defaultDC ?? ""}"
            >
          </label>
          <small>Если оставить пустым — будет просто бросок без определения степени.</small>
        </section>
      ` : ""}

      <section class="fast-nri-final-formula-row">
        <span>Итоговая формула</span>
        <code class="fast-nri-final-formula">${esc(baseFormula)}</code>
      </section>
    </div>
  `;
}

function collectDialogState(dialog, baseFormula, automaticModifiers, showDC = true) {
  const root = dialog.element;

  const activeAutomatic = [];
  root.querySelectorAll(".fast-nri-auto-mod-toggle").forEach(checkbox => {
    if (!checkbox.checked) return;

    const index = Number(checkbox.dataset.index);
    const modifier = automaticModifiers[index];
    if (modifier) activeAutomatic.push(modifier);
  });

  const manual = [];
  root.querySelectorAll(".fast-nri-manual-mod-row").forEach(row => {
    const formula = row.querySelector(".fast-nri-manual-formula")?.value?.trim() ?? "";
    const reason = row.querySelector(".fast-nri-manual-reason")?.value?.trim() ?? "";

    if (formula) manual.push({ formula, reason });
  });

  let dc = null;
  if (showDC) {
    const dcRaw = root.querySelector(".fast-nri-roll-dc")?.value?.trim() ?? "";
    const parsed = dcRaw === "" ? null : Number(dcRaw);
    dc = Number.isFinite(parsed) ? parsed : null;
  }

  return {
    formula: composeFormula(baseFormula, [...activeAutomatic, ...manual]),
    automaticModifiers: activeAutomatic,
    manualModifiers: manual,
    dc
  };
}

function attachDialogListeners(dialog, baseFormula, automaticModifiers, showDC = true) {
  const root = dialog.element;
  const manualContainer = root.querySelector(".fast-nri-manual-modifiers");
  const finalFormula = root.querySelector(".fast-nri-final-formula");

  const updateFormula = () => {
    const state = collectDialogState(dialog, baseFormula, automaticModifiers, showDC);
    if (finalFormula) finalFormula.textContent = state.formula;
  };

  root.querySelector(".fast-nri-add-manual-mod")?.addEventListener("click", event => {
    event.preventDefault();

    const row = document.createElement("div");
    row.className = "fast-nri-manual-mod-row";
    row.innerHTML = `
      <input class="fast-nri-manual-formula" type="text" placeholder="+1d4, -1d6, +2, -3">
      <input class="fast-nri-manual-reason" type="text" placeholder="Причина">
      <button type="button" class="fast-nri-remove-manual-mod" title="Удалить">
        <i class="fa-solid fa-xmark"></i>
      </button>
    `;
    manualContainer?.append(row);

    row.querySelectorAll("input").forEach(input => input.addEventListener("input", updateFormula));
    row.querySelector(".fast-nri-remove-manual-mod")?.addEventListener("click", removeEvent => {
      removeEvent.preventDefault();
      row.remove();
      updateFormula();
    });
  });

  root.querySelectorAll(".fast-nri-remove-manual-mod").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      button.closest(".fast-nri-manual-mod-row")?.remove();

      if (!manualContainer?.children.length) {
        root.querySelector(".fast-nri-add-manual-mod")?.click();
      }

      updateFormula();
    });
  });

  root.querySelectorAll(
    ".fast-nri-auto-mod-toggle, .fast-nri-manual-formula, .fast-nri-manual-reason"
  ).forEach(input => {
    input.addEventListener("input", updateFormula);
    input.addEventListener("change", updateFormula);
  });

  updateFormula();
}

async function prepareRoll({
  actor,
  label,
  baseFormula,
  baseSources = [],
  defaultDC = null,
  showDC = true,
  contextHTML = "",
  additionalModifiers = []
}) {
  const contextual = (additionalModifiers ?? [])
    .map((modifier, index) => ({
      id: modifier?.id || `context-${index}`,
      formula: normalizeTerm(modifier?.formula),
      label: modifier?.label || "Модификатор",
      reason: modifier?.reason || "",
      enabled: modifier?.enabled !== false
    }))
    .filter(modifier => modifier.formula);

  const automaticModifiers = [
    ...collectAutomaticModifiers(actor),
    ...contextual
  ];
  const { DialogV2 } = foundry.applications.api;

  const result = await DialogV2.wait({
    window: {
      title: `Бросок: ${label}`
    },
    content: buildDialogHTML({
      label,
      baseFormula,
      automaticModifiers,
      defaultDC,
      showDC,
      contextHTML
    }),
    modal: true,
    rejectClose: false,
    render: (_event, dialog) => {
      attachDialogListeners(dialog, baseFormula, automaticModifiers, showDC);
    },
    buttons: [
      {
        action: "roll",
        label: "Бросить",
        icon: "fa-solid fa-dice-d20",
        default: true,
        callback: async (_event, _button, dialog) => {
          return collectDialogState(dialog, baseFormula, automaticModifiers, showDC);
        }
      },
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: async () => null
      }
    ]
  });

  if (!result?.formula) return null;

  let roll;
  try {
    roll = await new Roll(result.formula).evaluate();
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка формулы броска", error);
    ui.notifications.error(`Некорректная формула броска: ${result.formula}`);
    return null;
  }

  const normalizedBaseSources = (baseSources ?? [])
    .map((source, index) => ({
      id: source?.id || `base-${index}`,
      formula: normalizeTerm(source?.formula),
      label: String(source?.label ?? "Базовая часть"),
      reason: String(source?.reason ?? "")
    }))
    .filter(source => source.formula);

  return {
    ...result,
    roll,
    baseSources: normalizedBaseSources,
    naturalD20: getNaturalD20(roll)
  };
}

/**
 * Show the physical dice animation for a roll which is stored back into an
 * existing ChatMessage instead of being sent with Roll#toMessage().
 *
 * Dice So Nice normally hooks into chat roll creation. In-place Resolution
 * edits intentionally do not create a new ChatMessage, so they must call the
 * module API directly. The module remains optional: without game.dice3d the
 * roll still resolves and the existing card is updated normally.
 */
async function showInPlaceRollDice(roll, { synchronize = true } = {}) {
  if (!roll) return false;
  const dice3d = globalThis.game?.dice3d ?? null;
  if (!dice3d || typeof dice3d.showForRoll !== "function") return false;

  try {
    return Boolean(await dice3d.showForRoll(
      roll,
      game.user,
      Boolean(synchronize),
      null,
      false
    ));
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось показать 3D-анимацию in-place броска", error);
    return false;
  }
}

function degreeHTML(degree) {
  if (!degree) return "";

  const order = ["failure", "partial", "success", "great"];

  return `
    <div class="fast-nri-degree-section">
      <div class="fast-nri-degree-caption">Степень</div>

      <div class="fast-nri-chat-degrees">
        ${order.map(key => `
          <span
            class="fast-nri-chat-degree fast-nri-degree-option-${key} ${key === degree ? "selected" : ""}"
          >
            ${DEGREE_LABELS[key]}
          </span>
        `).join("")}
      </div>
    </div>
  `;
}

function rollSourcesHTML(result) {
  const rows = [];

  for (const source of result?.baseSources ?? []) {
    rows.push({ kind: "base", formula: source.formula, label: source.label || "Базовая часть", reason: source.reason || "" });
  }

  for (const modifier of result?.automaticModifiers ?? []) {
    rows.push({ kind: "automatic", formula: modifier.formula, label: modifier.label || "Автоматический модификатор", reason: modifier.reason || "" });
  }

  for (const modifier of result?.manualModifiers ?? []) {
    rows.push({ kind: "manual", formula: modifier.formula, label: modifier.reason || "Ручной модификатор", reason: modifier.reason ? "Добавлено вручную" : "" });
  }

  if (!rows.length) return "";
  const kindLabel = { base: "Основа", automatic: "Эффект", manual: "Вручную" };

  return `
    <section class="fast-nri-roll-sources">
      <div class="fast-nri-roll-sources-title">
        <i class="fa-solid fa-list-ul"></i>
        <span>Из чего состоит бросок</span>
      </div>
      <div class="fast-nri-roll-source-list">
        ${rows.map(row => `
          <div class="fast-nri-roll-source-row fast-nri-roll-source-${escAttr(row.kind)}">
            <span class="fast-nri-roll-source-kind">${esc(kindLabel[row.kind] ?? "")}</span>
            <code class="fast-nri-roll-source-formula">${esc(row.formula)}</code>
            <span class="fast-nri-roll-source-name">${esc(row.label)}</span>
            ${row.reason ? `<small class="fast-nri-roll-source-reason">${esc(row.reason)}</small>` : ""}
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function rollCardHeader(label, icon = "fa-dice-d20") {
  return `
    <div class="fast-nri-chat-roll-title">
      <i class="fa-solid ${icon}"></i>
      <strong>${esc(label)}</strong>
    </div>
  `;
}

export async function openPreRollDialog({
  actor,
  label,
  baseFormula,
  baseSources = [],
  defaultDC = null
}) {
  const result = await prepareRoll({
    actor,
    label,
    baseFormula,
    baseSources,
    defaultDC,
    showDC: true
  });

  if (!result) return null;

  const degree = result.dc === null
    ? null
    : degreeVsDC(result.roll.total, result.dc, result.naturalD20);

  const flavor = `
    <div class="fast-nri-chat-roll">
      ${rollCardHeader(label)}

      ${result.dc !== null ? `
        <div class="fast-nri-chat-roll-meta">
          <span class="fast-nri-chat-dc-label">Сложность</span>
          <strong class="fast-nri-chat-dc-value">${result.dc}</strong>
        </div>
      ` : ""}

      ${degreeHTML(degree)}
      ${rollSourcesHTML(result)}
    </div>
  `;

  await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor
  });

  return {
    roll: result.roll,
    formula: result.formula,
    dc: result.dc,
    naturalD20: result.naturalD20,
    degree
  };
}

export async function rollSkillCheck(actor, skill) {
  const die = String(skill?.value ?? "").trim();
  const baseFormula = die ? `1d20 + ${die}` : "1d20";

  const skillLabel = skill?.label ?? "Проверка навыка";

  return openPreRollDialog({
    actor,
    label: skillLabel,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: "Проверка" },
      ...(die ? [{ formula: die, label: skillLabel, reason: "Куб навыка" }] : [])
    ]
  });
}


export async function rollSpecializationCheck(actor, specialization) {
  const die = String(specialization?.die ?? "").trim();
  const name = String(specialization?.name ?? "").trim();
  const kindLabel = specialization?.kind === "secondary"
    ? "Дополнительная специализация"
    : "Основная специализация";
  const label = name || kindLabel;
  const baseFormula = die ? `1d20 + ${die}` : "1d20";

  return openPreRollDialog({
    actor,
    label,
    baseFormula,
    baseSources: [
      {
        formula: "1d20",
        label: "Базовый d20",
        reason: "Проверка специализации"
      },
      ...(die ? [{
        formula: die,
        label,
        reason: kindLabel
      }] : [])
    ]
  });
}

function getSingleTarget() {
  const targets = Array.from(game.user?.targets ?? []);
  if (targets.length !== 1) return null;
  return targets[0];
}

function actionTargetStateHTML(state, defenseLabel = "КЗ") {
  if (!state?.offGuard) return "";

  if (state.surrounding?.surrounded) {
    return `
      <div class="fast-nri-chat-target-state fast-nri-chat-target-surrounded">
        <i class="fa-solid fa-users"></i>
        <div>
          <strong>Цель окружена</strong>
          <small>Угрозы ${esc(state.surrounding.threats)} &gt; Строй ${esc(state.surrounding.formation)} · Застигнута врасплох · ${esc(defenseLabel)} −2</small>
        </div>
      </div>
    `;
  }

  return `
    <div class="fast-nri-chat-target-state fast-nri-chat-target-off-guard">
      <i class="fa-solid fa-shield-halved"></i>
      <div>
        <strong>Цель застигнута врасплох</strong>
        <small>${esc(defenseLabel)} −2</small>
      </div>
    </div>
  `;
}

function armorContextHTML(target, effectiveArmor = null, targetState = null) {
  if (!target?.actor) {
    return `
      <section class="fast-nri-roll-context fast-nri-roll-context-warning">
        <i class="fa-solid fa-crosshairs"></i>
        <div>
          <strong>Цель не выбрана</strong>
          <small>Атака будет брошена, но степень автоматически не рассчитывается.</small>
        </div>
      </section>
    `;
  }

  const armor = effectiveArmor ?? target.actor.system?.armor ?? {};
  return `
    <section class="fast-nri-roll-context">
      <i class="fa-solid fa-crosshairs"></i>
      <div>
        <strong>${esc(target.name)}</strong>
        <small>
          КЗ:
          ${esc(armor.partial ?? "—")} /
          ${esc(armor.success ?? "—")} /
          ${esc(armor.great ?? "—")}
          ${targetState?.offGuard ? " · Застигнут врасплох" : ""}
        </small>
      </div>
    </section>
  `;
}

function checkContextHTML(target, targetCharacteristic, resolved = null) {
  const characteristic = normalizeCheckTargetCharacteristic(targetCharacteristic) || "armor";
  if (characteristic === "armor") {
    return armorContextHTML(
      target,
      resolved?.armor ?? null,
      resolved?.state ?? null
    );
  }

  const label = checkTargetCharacteristicLabel(characteristic);
  if (!target?.actor) {
    return `
      <section class="fast-nri-roll-context fast-nri-roll-context-warning">
        <i class="fa-solid fa-crosshairs"></i>
        <div>
          <strong>Цель не выбрана</strong>
          <small>Проверка против ${esc(label)} будет брошена, но степень автоматически не рассчитывается.</small>
        </div>
      </section>
    `;
  }

  return `
    <section class="fast-nri-roll-context">
      <i class="fa-solid fa-crosshairs"></i>
      <div>
        <strong>${esc(target.name)}</strong>
        <small>
          ${esc(label)}: ${esc(resolved?.value ?? "—")}
          ${resolved?.state?.offGuard ? " · Застигнут врасплох" : ""}
        </small>
      </div>
    </section>
  `;
}

function checkMetaHTML(target, targetCharacteristic, resolved = null) {
  const characteristic = normalizeCheckTargetCharacteristic(targetCharacteristic) || "armor";
  if (characteristic === "armor") {
    return armorMetaHTML(
      target,
      resolved?.armor ?? null,
      resolved?.state ?? null
    );
  }

  if (!target?.actor) {
    return `
      <div class="fast-nri-chat-target fast-nri-chat-target-missing">
        <span>Цель не выбрана</span>
      </div>
    `;
  }

  const label = checkTargetCharacteristicLabel(characteristic);
  return `
    <div class="fast-nri-chat-target">
      <span class="fast-nri-chat-target-name">${esc(target.name)}</span>
      <span class="fast-nri-chat-armor">${esc(label)} ${esc(resolved?.value ?? "—")}</span>
    </div>
    ${actionTargetStateHTML(resolved?.state, label)}
  `;
}

function armorMetaHTML(target, effectiveArmor = null, targetState = null) {
  if (!target?.actor) {
    return `
      <div class="fast-nri-chat-target fast-nri-chat-target-missing">
        <span>Цель не выбрана</span>
      </div>
    `;
  }

  const armor = effectiveArmor ?? target.actor.system?.armor ?? {};
  return `
    <div class="fast-nri-chat-target">
      <span class="fast-nri-chat-target-name">${esc(target.name)}</span>
      <span class="fast-nri-chat-armor">
        КЗ ${esc(armor.partial ?? "—")} / ${esc(armor.success ?? "—")} / ${esc(armor.great ?? "—")}
      </span>
    </div>
    ${actionTargetStateHTML(targetState)}
  `;
}

function componentTraitIds(component, weapon, actor) {
  const traits = new Set(component?.traitIds ?? []);

  // Общие свойства источника Creature также считаются свойствами каждой
  // части его урона. Это позволяет, например, Уязвимости: Демон реагировать
  // на урон демона без дублирования свойства в каждом оружии.
  for (const id of actor?.system?.creatureTraitIds ?? []) traits.add(id);

  // Legacy: свойство Яд раньше могло стоять в общем списке свойств оружия.
  for (const id of weapon?.system?.propertyIds ?? []) {
    if (Object.hasOwn(CREATURE_TRAITS, id)) traits.add(id);
  }

  return Array.from(traits);
}

function weaponDamageComponents(actor, weapon, profile) {
  const configured = Array.from(weapon?.system?.damageComponents?.[profile] ?? [])
    .map(component => ({
      formula: String(component?.formula ?? "").trim(),
      damageType: ["physical", "magic"].includes(component?.damageType)
        ? component.damageType
        : "physical",
      traitIds: componentTraitIds(component, weapon, actor)
    }))
    .filter(component => component.formula);

  if (configured.length) return configured;

  const formula = String(weapon?.system?.damage?.[profile] ?? "0").trim() || "0";
  return [{
    formula,
    damageType: weapon?.system?.damageType === "magic" ? "magic" : "physical",
    traitIds: componentTraitIds({ traitIds: [] }, weapon, actor)
  }];
}

function plainDamageFormula(components) {
  return (components ?? []).map(component => `(${component.formula})`).join(" + ") || "0";
}

function componentFlavor(component) {
  const labels = [
    component.damageType === "magic" ? "Магический" : "Физический",
    ...(component.traitIds ?? []).map(id => CREATURE_TRAITS[id] ?? id)
  ];
  return Array.from(new Set(labels)).join(" • ");
}

function flavoredDamageFormula(components) {
  const chunks = [];

  for (const component of components ?? []) {
    const parsed = new Roll(component.formula);
    const flavor = componentFlavor(component);

    const formula = parsed.terms.map(term => {
      if (term?.operator) return term.operator;
      const raw = String(term?.formula ?? term?.expression ?? "").trim();
      if (!raw) return "";
      return `${raw}[${flavor}]`;
    }).filter(Boolean).join(" ");

    chunks.push(formula);
  }

  return chunks.join(" + ") || "0";
}

function damageComponentMap(components) {
  const map = new Map();
  for (const component of components ?? []) {
    map.set(componentFlavor(component), component);
  }
  return map;
}

function damageProfilesHTML(actor, weapon, degree, critical) {
  const profiles = [
    ["partial", "Частичный"],
    ["success", "Успех"],
    ["great", "Большой"]
  ];

  return `
    <section class="fast-nri-hit-damage">
      <div class="fast-nri-hit-damage-heading">
        <span>Профиль урона</span>
        ${critical ? `<strong class="fast-nri-critical-note">Крит: итоговый урон ×2</strong>` : ""}
      </div>

      <div class="fast-nri-hit-damage-buttons">
        ${profiles.map(([key, label]) => {
          const components = weaponDamageComponents(actor, weapon, key);
          const formula = plainDamageFormula(components);
          const selected = degree === key;

          return `
            <button
              type="button"
              class="fast-nri-hit-damage-button fast-nri-hit-damage-${key} ${selected ? "selected" : ""}"
              data-fast-nri-damage
              data-actor-uuid="${escAttr(actor.uuid)}"
              data-item-uuid="${escAttr(weapon.uuid)}"
              data-profile="${key}"
              data-formula="${escAttr(formula)}"
              data-critical="${critical ? "true" : "false"}"
              title="Бросить урон: ${escAttr(label)} — ${escAttr(formula)}"
            >
              <span class="fast-nri-hit-damage-degree">${esc(label)}</span>
              <strong class="fast-nri-hit-damage-formula">${esc(formula)}</strong>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function attackResultHTML(weapon, target, degree, rollTotal) {
  return `
    <section class="fast-nri-hit-summary">
      <div class="fast-nri-hit-weapon">
        <span class="fast-nri-hit-label">Оружие</span>
        <strong>${esc(weapon.name)}</strong>
      </div>

      ${target?.actor ? `
        <div class="fast-nri-hit-target">
          <span class="fast-nri-hit-label">Цель</span>
          <strong>${esc(target.name)}</strong>
        </div>
      ` : ""}

      <div class="fast-nri-hit-result">
        <span class="fast-nri-hit-label">Результат</span>
        <strong>${esc(rollTotal)}</strong>
      </div>

      ${degree ? `
        <div class="fast-nri-hit-degree">
          <span class="fast-nri-hit-label">Степень</span>
          <strong>${DEGREE_LABELS[degree]}</strong>
        </div>
      ` : ""}
    </section>
  `;
}

export async function rollWeaponAttack(actor, weapon) {
  if (!actor || !weapon || weapon.type !== "weapon") return null;

  if (!itemIsEquipped(weapon)) {
    ui.notifications.warn(`«${weapon.name}» не экипировано и сейчас не доступно для использования.`);
    return null;
  }

  if (itemRequiresHands(weapon) && !itemIsHeld(weapon)) {
    ui.notifications.warn(`«${weapon.name}» требует рук, но не отмечено как «В руках».`);
    return null;
  }

  if (!itemIsUsable(weapon)) return null;

  const attackType = inferWeaponAttackType(weapon);
  const attackTerm = resolveWeaponAttackTerm(actor, weapon);
  const attackTermFormula = String(attackTerm?.formula ?? "").trim();
  const baseFormula = attackTermFormula ? `1d20 + ${attackTermFormula}` : "1d20";
  const target = getSingleTarget();
  const baseActionContext = actionContextFromWeapon(actor, weapon, { target });
  const previewTargetDefense = target?.actor
    ? effectiveArmorForAction(target, actor)
    : null;

  if ((game.user?.targets?.size ?? 0) > 1) {
    ui.notifications.warn("Для одиночной атаки выбери одну цель. Бросок будет выполнен без автоматической степени.");
  }

  const result = await prepareRoll({
    actor,
    label: `Атака: ${weapon.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: "Атака" },
      ...(attackTermFormula ? [{
        formula: attackTermFormula,
        label: attackTerm?.label || "Модификатор атаки",
        reason: attackTerm?.reason || actor.name
      }] : [])
    ],
    showDC: false,
    contextHTML: armorContextHTML(
      target,
      previewTargetDefense?.armor ?? null,
      previewTargetDefense?.state ?? null
    )
  });

  if (!result) return null;

  // Re-read field state at the exact moment the attack resolves. The dialog
  // may have remained open while tokens or equipment changed.
  const targetDefense = target?.actor
    ? effectiveArmorForAction(target, actor)
    : null;
  const effectiveArmor = targetDefense?.armor ?? null;
  const targetState = targetDefense?.state ?? null;

  const degree = target?.actor
    ? degreeVsArmor(result.roll.total, effectiveArmor, result.naturalD20)
    : null;

  const critical = result.naturalD20 === 20;
  const actionContext = actionContextWithCheckResult(baseActionContext, {
    target,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    degree,
    critical,
    formula: result.formula
  });

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-attack-card">
      ${rollCardHeader("Попадание", "fa-swords")}
      ${attackResultHTML(weapon, target, degree, result.roll.total)}
      <div class="fast-nri-attack-type"><small>Вид атаки: <strong>${esc(attackTypeLabel(attackType))}</strong></small></div>
      <div class="fast-nri-attack-type"><small>Тип оружия: <strong>${esc(weaponTypeLabel(weapon.system?.typeId) || "не указан")}</strong>${weapon.system?.categoryId ? ` · ${esc(weaponCategoryLabel(weapon.system.categoryId))}` : ""}</small></div>
      <div class="fast-nri-attack-type"><small>Базовый член атаки: <strong>${esc(attackTerm?.label || "только d20")}</strong>${attackTerm?.reason ? ` · ${esc(attackTerm.reason)}` : ""}</small></div>
      ${armorMetaHTML(target, effectiveArmor, targetState)}

      ${critical ? `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-burst"></i>
          <strong>Натуральная 20</strong>
        </div>
      ` : ""}

      ${degreeHTML(degree)}
      ${damageProfilesHTML(actor, weapon, degree, critical)}
      ${rollSourcesHTML(result)}
    </div>
  `;

  const message = await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: "attack",
        actorUuid: actor.uuid,
        itemUuid: weapon.uuid,
        targetUuid: target?.document?.uuid ?? null,
        degree,
        critical,
        rollTotal: result.roll.total,
        naturalD20: result.naturalD20,
        attackType,
        attackTermKind: attackTerm?.kind ?? "unproficient",
        weaponTypeId: String(weapon.system?.typeId ?? ""),
        weaponCategoryId: String(weapon.system?.categoryId ?? ""),
        weaponProficient: Boolean(attackTerm?.proficient),
        weaponMastery: Boolean(attackTerm?.mastery),
        actionTraits: actionContext.traits,
        actionContext,
        offGuard: Boolean(targetState?.offGuard),
        surrounded: Boolean(targetState?.surrounding?.surrounded),
        surroundingThreats: targetState?.surrounding?.threats ?? null,
        surroundingFormation: targetState?.surrounding?.formation ?? null,
        armorPenalty: targetState?.defensePenalty ?? 0
      }
    }
  });

  return {
    roll: result.roll,
    formula: result.formula,
    naturalD20: result.naturalD20,
    target,
    degree,
    critical,
    attackType,
    actionContext,
    message
  };
}


function chatMessageFromElement(element) {
  const id = element
    ?.closest(".chat-message, .message")
    ?.dataset?.messageId ?? null;

  return id ? game.messages?.get(id) ?? null : null;
}

function activeDieResults(term) {
  if (!Number.isFinite(Number(term?.faces)) || !Array.isArray(term?.results)) return null;

  return term.results
    .filter(result => result?.active !== false && !result?.discarded)
    .map(result => {
      const value = Number(result?.result);
      if (!Number.isFinite(value)) return null;

      let label = String(value);
      let css = [];

      try {
        label = String(term.getResultLabel?.(result) ?? value);
      } catch (error) {
        console.warn("Быстрая НРИ | Не удалось получить native label куба", error);
      }

      try {
        css = Array.from(term.getResultCSS?.(result) ?? [])
          .filter(Boolean)
          .map(value => String(value))
          .filter(value => /^[A-Za-z0-9_-]+$/.test(value));
      } catch (error) {
        console.warn("Быстрая НРИ | Не удалось получить native CSS куба", error);
      }

      return {
        value,
        label,
        css
      };
    })
    .filter(Boolean);
}

/**
 * Быстрая НРИ 6.3:
 * - каждый обычный куб урона — отдельный куб урона;
 * - каждый положительный числовой бонус — отдельный фиксированный куб урона;
 * - штрафы кубами урона не считаются;
 * - защита работает с уже выпавшими/фиксированными результатами.
 */
function termDamageMeta(term, componentMap, fallback) {
  const flavor = String(term?.flavor ?? term?.options?.flavor ?? "").trim();
  const component = flavor ? componentMap.get(flavor) : null;

  return {
    damageType: component?.damageType ?? fallback.damageType ?? "physical",
    traitIds: Array.from(new Set(component?.traitIds ?? fallback.traitIds ?? []))
  };
}

/**
 * Каждый выпавший куб и каждый положительный фиксированный бонус — отдельная
 * часть урона. У части есть исходное значение, текущее значение после Защит,
 * тип и собственные свойства.
 */
function buildDamageState(roll, {
  components = [],
  damageType = "physical",
  traitIds = []
} = {}) {
  const parts = [];
  const penalties = [];
  let sign = 1;
  let supported = true;
  let sequence = 0;
  const componentMap = damageComponentMap(components);
  const fallback = { damageType, traitIds };

  for (const term of roll?.terms ?? []) {
    const operator = String(term?.operator ?? "").trim();

    if (operator) {
      if (operator === "+") sign = 1;
      else if (operator === "-") sign = -1;
      else supported = false;
      continue;
    }

    const meta = termDamageMeta(term, componentMap, fallback);
    const dieResults = activeDieResults(term);

    if (dieResults) {
      for (const dieResult of dieResults) {
        const entry = {
          id: `part-${sequence++}`,
          kind: "die",
          faces: Number(term.faces),
          value: dieResult.value,
          rolledValue: dieResult.value,
          currentValue: dieResult.value,
          nativeLabel: dieResult.label,
          nativeResultCSS: dieResult.css,
          damageType: meta.damageType,
          traitIds: meta.traitIds,
          defenseZeroed: false,
          immuneRemoved: false,
          removed: false
        };

        if (sign >= 0) parts.push(entry);
        else penalties.push({ ...entry, id: `penalty-${sequence++}` });
      }
      continue;
    }

    const numeric = finiteNumberOrNull(term?.number ?? term?.total);
    if (numeric !== null) {
      if (numeric > 0 && sign >= 0) {
        parts.push({
          id: `part-${sequence++}`,
          kind: "fixed",
          faces: null,
          value: numeric,
          rolledValue: numeric,
          currentValue: numeric,
          damageType: meta.damageType,
          traitIds: meta.traitIds,
          defenseZeroed: false,
          immuneRemoved: false,
          removed: false
        });
      } else if (numeric > 0 && sign < 0) {
        penalties.push({
          id: `penalty-${sequence++}`,
          kind: "fixed",
          faces: null,
          value: numeric,
          rolledValue: numeric,
          currentValue: numeric,
          damageType: meta.damageType,
          traitIds: meta.traitIds,
          defenseZeroed: false,
          immuneRemoved: false,
          removed: false
        });
      }
      continue;
    }

    if (term?.formula || term?.expression) supported = false;
  }

  const state = {
    supported,
    damageType,
    parts,
    penalties,
    originalRollTotal: Number(roll?.total) || 0,
    currentBaseTotal: 0,
    currentTotal: 0,
    fullCancel: false,
    effectDegree: null,
    originalEffectDegree: null,
    defense: null,
    defenseHistory: []
  };

  return recalculateDamageState(state);
}

function damagePartExcludedFromTotal(part) {
  return Boolean(
    part?.immuneRemoved
    || part?.manualRemoved
    || part?.profileZeroed
    || part?.defenseZeroed
  );
}

function damagePartCanBeEdited(part) {
  return Boolean(part?.kind === "die" && !damagePartExcludedFromTotal(part));
}

function recalculateDamageState(state) {
  const next = foundry.utils.deepClone(state);

  if (next.fullCancel) {
    next.currentBaseTotal = 0;
    next.currentTotal = 0;
    return next;
  }

  const positive = (next.parts ?? [])
    .filter(part => !damagePartExcludedFromTotal(part))
    .reduce((sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0), 0);

  const penalty = (next.penalties ?? [])
    .reduce((sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0), 0);

  next.currentBaseTotal = Math.max(0, positive - penalty);
  next.currentTotal = next.currentBaseTotal;
  return next;
}

function damagePartLabel(part) {
  const current = Number(part?.currentValue ?? part?.value) || 0;
  const original = Number(part?.rolledValue ?? part?.value) || 0;
  const excluded = damagePartExcludedFromTotal(part);
  const valueText = excluded
    ? `${current} (исключён)`
    : current === original ? `${original}` : `${original} → ${current}`;
  if (part?.kind === "die") return `d${part.faces}: ${valueText}`;
  return `фикс. +${valueText}`;
}

function damagePartShortLabel(part) {
  if (part?.kind === "die") return `d${part.faces}`;
  return `+${part?.value ?? 0}`;
}

function nativeDamageDieClasses(part) {
  if (part?.kind !== "die") return "";

  const classes = new Set([
    "roll",
    "die",
    `d${Number(part.faces) || 0}`,
    ...(part.nativeResultCSS ?? [])
  ]);

  return Array.from(classes)
    .filter(value => /^[A-Za-z0-9_-]+$/.test(value))
    .join(" ");
}

function damageTypeLabel(type) {
  return type === "magic" ? "Магический" : "Физический";
}

function damagePartTraitsHTML(part) {
  const labels = [
    damageTypeLabel(part?.damageType),
    ...(part?.traitIds ?? []).map(id => CREATURE_TRAITS[id] ?? id)
  ];

  return `<small class="fast-nri-damage-part-traits">${labels.map(esc).join(" · ")}</small>`;
}

function damagePartsHTML(state, { editable = true, title = "Кубы урона" } = {}) {
  if (!state?.supported) {
    return `
      <div class="fast-nri-damage-structure-warning">
        <i class="fa-solid fa-triangle-exclamation"></i>
        Не удалось безопасно разобрать формулу на отдельные кубы урона.
      </div>
    `;
  }

  const parts = (state.parts ?? []).map(part => {
    const current = Math.max(0, Number(part.currentValue ?? part.value) || 0);
    const original = Math.max(0, Number(part.rolledValue ?? part.value) || 0);
    const excluded = damagePartExcludedFromTotal(part);
    const changed = !excluded && current !== original;
    const statusClass = part.immuneRemoved
      ? "immune-removed"
      : part.manualRemoved
        ? "manual-removed"
        : part.profileZeroed
          ? "profile-zeroed"
          : part.defenseZeroed
            ? "defense-zeroed"
            : part.manualAdded
              ? "manual-added"
              : "";

    if (part.kind === "die") {
      const nativeLabel = part.nativeLabel ?? original;
      const nativeClasses = nativeDamageDieClasses(part);

      return `
        <span class="fast-nri-damage-part-stack ${statusClass}" title="${escAttr(damagePartLabel(part))}">
          <span class="fast-nri-damage-native-part">
            <span class="fast-nri-damage-native-type">${esc(damagePartShortLabel(part))}:</span>
            <span class="dice-tooltip fast-nri-inline-dice-tooltip">
              <section class="tooltip-part">
                <div class="dice">
                  <ol class="dice-rolls fast-nri-damage-native-rolls">
                    <li class="${escAttr(nativeClasses)}">${esc(nativeLabel)}</li>
                  </ol>
                </div>
              </section>
            </span>
            ${changed ? `<strong class="fast-nri-damage-part-current">→ ${esc(current)}</strong>` : ""}
          </span>
          ${damagePartTraitsHTML(part)}
        </span>
      `;
    }

    return `
      <span class="fast-nri-damage-part-stack ${statusClass}" title="${escAttr(damagePartLabel(part))}">
        <span class="fast-nri-damage-fixed-part">
          <span class="fast-nri-damage-native-type">${esc(damagePartShortLabel(part))}:</span>
          <strong class="fast-nri-fixed-result">${esc(original)}</strong>
          ${changed ? `<strong class="fast-nri-damage-part-current">→ ${esc(current)}</strong>` : ""}
        </span>
        ${damagePartTraitsHTML(part)}
      </span>
    `;
  }).join("");

  const penalty = (state.penalties ?? [])
    .reduce((sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0), 0);

  const total = Math.max(0, Number(state.currentTotal) || 0);

  const removableDice = (state.parts ?? []).some(part =>
    damagePartCanBeEdited(part)
    && (Number(part?.currentValue ?? part?.value) || 0) > 0
  );
  const restorableDice = (state.parts ?? []).some(part =>
    part?.kind === "die" && part?.manualRemoved && !part?.immuneRemoved
  );
  const rerollableDice = (state.parts ?? []).some(part =>
    damagePartCanBeEdited(part)
    && (Number(part?.currentValue ?? part?.value) || 0) > 0
  );

  return `
    <section class="fast-nri-damage-parts-block">
      <div class="fast-nri-damage-parts-heading">
        <div class="fast-nri-damage-parts-title">${esc(title)}</div>
        ${editable ? `<div class="fast-nri-damage-edit-actions" aria-label="Ручное управление уроном">
          <button
            type="button"
            class="fast-nri-damage-edit-button"
            data-fast-nri-damage-remove-die
            ${removableDice ? "" : "disabled"}
            title="Убрать выбранный выпавший куб урона"
            aria-label="Убрать куб урона"
          ><i class="fa-solid fa-minus"></i></button>
          <button
            type="button"
            class="fast-nri-damage-edit-button"
            data-fast-nri-damage-restore-die
            ${restorableDice ? "" : "disabled"}
            title="Вернуть ранее исключённый вручную куб с тем же результатом"
            aria-label="Вернуть куб урона"
          ><i class="fa-solid fa-rotate-left"></i></button>
          <button
            type="button"
            class="fast-nri-damage-edit-button"
            data-fast-nri-damage-reroll-die
            ${rerollableDice ? "" : "disabled"}
            title="Перебросить выбранный активный куб"
            aria-label="Перебросить куб урона"
          ><i class="fa-solid fa-dice"></i></button>
          <button
            type="button"
            class="fast-nri-damage-edit-button"
            data-fast-nri-damage-add
            title="Добавить куб или значение урона"
            aria-label="Добавить урон"
          ><i class="fa-solid fa-plus"></i></button>
        </div>` : ""}
      </div>
      <div class="fast-nri-damage-equation">
        <div class="fast-nri-damage-parts">
          ${parts || `<span class="fast-nri-roll-empty">Нет положительных кубов урона.</span>`}
        </div>
        ${penalty > 0 ? `<span class="fast-nri-damage-adjustment" title="Штраф применяется после Защитных действий">−${esc(penalty)}</span>` : ""}
        <span class="fast-nri-damage-equation-arrow" aria-hidden="true">→</span>
        <strong class="fast-nri-damage-equation-total" title="Текущий итоговый урон">${esc(total)}</strong>
      </div>
    </section>
  `;
}


function manualDamageSummaryHTML(state) {
  const history = Array.from(state?.manualDamageHistory ?? []);
  const latest = history.at(-1);
  if (!latest) return "";

  if (latest.kind === "removeDie") {
    return `
      <section class="fast-nri-manual-damage-summary">
        <i class="fa-solid fa-pen-to-square"></i>
        <span>Последняя ручная коррекция: убран <strong>d${esc(latest.faces)}: ${esc(latest.value)}</strong>.</span>
      </section>
    `;
  }

  if (latest.kind === "restoreDie") {
    return `
      <section class="fast-nri-manual-damage-summary">
        <i class="fa-solid fa-pen-to-square"></i>
        <span>Последняя ручная коррекция: возвращён <strong>d${esc(latest.faces)}: ${esc(latest.value)}</strong> без переброса.</span>
      </section>
    `;
  }

  if (latest.kind === "rerollDie") {
    return `
      <section class="fast-nri-manual-damage-summary">
        <i class="fa-solid fa-dice"></i>
        <span>Таргетный переброс: <strong>d${esc(latest.faces)}: ${esc(latest.previousValue)} → ${esc(latest.value)}</strong>.</span>
      </section>
    `;
  }

  if (latest.kind === "addDamage") {
    const labels = [
      damageTypeLabel(latest.damageType),
      ...(latest.traitIds ?? []).map(id => CREATURE_TRAITS[id] ?? id)
    ];
    return `
      <section class="fast-nri-manual-damage-summary">
        <i class="fa-solid fa-pen-to-square"></i>
        <span>
          Последняя ручная коррекция: добавлено <strong>${esc(latest.formula || "урон")}</strong>
          ${labels.length ? `· ${labels.map(esc).join(" · ")}` : ""}.
        </span>
      </section>
    `;
  }

  return "";
}

function defenseResultLabel(result) {
  if (result === "full-cancel") return "Полная отмена";
  if (result === "success") return "Успех";
  if (result === "failure") return "Провал";
  return "";
}

function resolutionEntryId(prefix = "resolution") {
  const random = globalThis.foundry?.utils?.randomID?.(12)
    ?? Math.random().toString(36).slice(2, 14);
  return `${prefix}-${Date.now()}-${random}`;
}

function defenseResolutionEntryHTML(defense, { pending = false, controls = false, targetUuid = null } = {}) {
  if (!defense) return "";
  const actionName = defense.actionName || "Защита";
  const removedParts = Array.isArray(defense.removedParts)
    ? defense.removedParts
    : defense.removedPart
      ? [defense.removedPart]
      : [];
  const beforeDegree = defense.effectDegreeBefore ?? defense.degreeBefore ?? null;
  const afterDegree = defense.effectDegreeAfter ?? defense.degreeAfter ?? null;
  const defenderName = defense.defenderTokenName ?? defense.tokenName ?? "Защитник";
  const protectedName = defense.protectedTokenName ?? null;
  const isAlly = defense.kind === "ally-defense" || (
    protectedName && protectedName !== defenderName
  );
  const rollFormula = String(defense.formula ?? "").trim();
  const natural = Number(defense.naturalD20);
  const resource = defense.resource ?? null;
  const undone = defense.status === "undone" || defense.undone === true;
  const targetAttr = targetUuid ? ` data-target-uuid="${escAttr(targetUuid)}"` : "";

  return `
    <section class="fast-nri-self-defense-summary fast-nri-self-defense-${escAttr(defense.result)} ${undone ? "is-undone" : ""}" data-defense-entry-id="${escAttr(defense.id ?? "")}">
      <div class="fast-nri-self-defense-heading">
        <i class="fa-solid fa-shield-halved"></i>
        <strong>${esc(actionName)} — ${undone ? "Отменена" : esc(defenseResultLabel(defense.result))}</strong>
        ${pending && !undone ? `<small>брошено · ожидает применения</small>` : ""}
        ${controls ? `<span class="fast-nri-defense-step-actions">
          <button type="button" data-fast-nri-defense-step-reroll data-defense-id="${escAttr(defense.id ?? "")}"${targetAttr} ${undone ? "disabled" : ""} title="Перебросить эту Защиту"><i class="fa-solid fa-dice-d20"></i><span>Переброс</span></button>
          <button type="button" data-fast-nri-defense-step-undo data-defense-id="${escAttr(defense.id ?? "")}"${targetAttr} ${undone ? "disabled" : ""} title="Отменить эту Защиту"><i class="fa-solid fa-rotate-left"></i><span>Отмена</span></button>
        </span>` : ""}
      </div>

      <small>
        ${esc(defenderName)}:
        ${rollFormula ? `${esc(rollFormula)} = ` : ""}<strong>${esc(defense.total)}</strong>
        ${Number.isFinite(natural) ? ` · d20: ${esc(natural)}` : ""}
        против исходного результата
        <strong>${esc(defense.attackTotal)}</strong>
        ${isAlly && protectedName ? ` · защищает ${esc(protectedName)}` : ""}
      </small>

      ${removedParts.length ? `
        <div>
          Обнулено частей урона:
          <strong>${removedParts.map(part => esc(damagePartLabel(part))).join(", ")}</strong>
        </div>
      ` : ""}

      ${beforeDegree && afterDegree && beforeDegree !== afterDegree ? `
        <div>
          Степень:
          <strong>${esc(DEGREE_LABELS[beforeDegree] ?? beforeDegree)}</strong>
          →
          <strong>${esc(DEGREE_LABELS[afterDegree] ?? afterDegree)}</strong>
        </div>
      ` : ""}

      ${defense.result === "full-cancel" ? `
        <div><strong>Исходное действие против защищаемой цели считается Провалом.</strong></div>
      ` : ""}

      ${resource ? defenseResourceHTML(resource, Boolean(defense.resourceUndone), { inlineDefenseId: defense.id }) : ""}
      ${defense.sourcesHTML ? `<details class="fast-nri-defense-inline-sources"><summary>Модификаторы Защиты</summary>${defense.sourcesHTML}</details>` : ""}
    </section>
  `;
}

function defenseHistoryHTML(history = [], { pending = false, controls = false, targetUuid = null } = {}) {
  return Array.from(history ?? []).map(defense => defenseResolutionEntryHTML(defense, { pending, controls, targetUuid })).join("");
}

function defenseSummaryHTML(state) {
  const history = Array.from(state?.defenseHistory ?? []);
  if (!history.length && state?.defense) history.push(state.defense);
  if (!history.length) return "";
  return `<div class="fast-nri-defense-inline-history">${defenseHistoryHTML(history)}</div>`;
}

function damageCardHTML({
  weaponName,
  sourceName = weaponName,
  profileLabel,
  targetName = "",
  critical = false,
  state,
  modifiersHTML = "",
  applicationEffectsHTML = "",
  hasApplicationEffects = false,
  allowDefense = true,
  allowDouble = true
}) {
  const baseDamage = Math.max(0, Number(state?.currentTotal) || 0);
  const doubledDamage = baseDamage * 2;
  const applicationHasEffects = Boolean(applicationEffectsHTML || hasApplicationEffects);
  const applyDisabled = Boolean(state?.fullCancel && !applicationHasEffects);

  return `
    <div class="fast-nri-chat-roll fast-nri-damage-card">
      ${rollCardHeader(`Урон: ${sourceName}`, "fa-burst")}

      <div class="fast-nri-chat-damage-profile-name">
        ${esc(profileLabel)}
      </div>
      ${targetName ? `<div class="fast-nri-chat-damage-target">Исходная цель: <strong>${esc(targetName)}</strong></div>` : ""}

      ${damagePartsHTML(state)}
      ${manualDamageSummaryHTML(state)}
      ${defenseSummaryHTML(state)}
      ${applicationEffectsHTML}

      ${critical ? `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-burst"></i>
          <strong>
            Исходная атака отмечена как критическая.
            Множитель выбирается только при нанесении урона.
          </strong>
        </div>
      ` : ""}

      <div class="fast-nri-damage-actions ${allowDefense && allowDouble ? "fast-nri-damage-actions-three" : ""}">
        ${allowDefense ? `
          <button
            type="button"
            class="fast-nri-defense-button"
            data-fast-nri-defense
            title="Использовать защитное действие"
          >
            <i class="fa-solid fa-shield-halved"></i>
            <span>Защита</span>
          </button>
        ` : ""}

        <button
          type="button"
          class="fast-nri-apply-damage-button"
          data-fast-nri-apply-damage
          data-damage="${escAttr(baseDamage)}"
          data-multiplier="1"
          ${applyDisabled ? "disabled" : ""}
          title="${applyDisabled
            ? "Действие полностью отменено"
            : `Применить этот пул только к текущим выделенным токенам`
          }"
        >
          <i class="fa-solid fa-heart-crack"></i>
          <span>${applyDisabled ? "Результат отменён" : applicationHasEffects ? "Применить к выделенным" : "Нанести выделенным"}</span>
        </button>

        ${allowDouble ? `
          <button
            type="button"
            class="fast-nri-apply-damage-button fast-nri-apply-damage-x2"
            data-fast-nri-apply-damage
            data-damage="${escAttr(doubledDamage)}"
            data-multiplier="2"
            ${applyDisabled ? "disabled" : ""}
            title="${applyDisabled
              ? "Действие полностью отменено"
              : `Применить этот пул ×2 только к текущим выделенным токенам`
            }"
          >
            <i class="fa-solid fa-xmark"></i>
            <span>${applyDisabled ? "×2 отменён" : applicationHasEffects ? "Применить ×2 к выделенным" : "Нанести ×2 выделенным"}</span>
          </button>
        ` : ""}
      </div>

      ${modifiersHTML}
    </div>
  `;
}


async function applicationEffectsFromUuids(uuids = []) {
  const normalized = Array.from(new Set(uuids ?? [])).filter(Boolean);
  const documents = await resolveEffectDocuments(normalized);
  const html = documents.length
    ? `<section class="fast-nri-application-effects"><div class="fast-nri-damage-parts-title">Эффекты результата</div><div class="fast-nri-ability-linked-effects">${documents.map(effect => effectChatCardHTML(effect, { compact: true })).join("")}</div></section>`
    : "";
  return { uuids: normalized, documents, html };
}

async function abilityApplicationEffects(runtime, degree = null) {
  if (!degree) return { uuids: [], documents: [], html: "" };
  const profile = abilityProfile(runtime, degree);
  return applicationEffectsFromUuids(profile?.effectUuids ?? []);
}

function effectOnlyApplicationCardHTML({ sourceName, profileLabel = "", targetName = "", profileHTML = "", effectsHTML = "" }) {
  return `
    <div class="fast-nri-chat-roll fast-nri-result-application-card">
      ${rollCardHeader(`Результат: ${sourceName}`, "fa-wand-magic-sparkles")}
      ${profileLabel ? `<div class="fast-nri-chat-damage-profile-name">${esc(profileLabel)}</div>` : ""}
      ${targetName ? `<div class="fast-nri-chat-damage-target">Исходная цель: <strong>${esc(targetName)}</strong></div>` : ""}
      ${profileHTML}
      ${effectsHTML}
      <div class="fast-nri-damage-actions">
        <button type="button" class="fast-nri-apply-damage-button" data-fast-nri-apply-result>
          <i class="fa-solid fa-check"></i><span>Применить к выделенным</span>
        </button>
      </div>
    </div>
  `;
}

function activeManualDamageParts(state) {
  return (state?.parts ?? []).filter(part =>
    !damagePartExcludedFromTotal(part)
    && (Number(part?.currentValue ?? part?.value) || 0) > 0
  );
}

export function manualDamageDefaultMeta(state) {
  const active = activeManualDamageParts(state);
  const pool = active.length ? active : Array.from(state?.parts ?? []);
  let largest = null;

  for (const part of pool) {
    const value = Math.max(0, Number(part?.currentValue ?? part?.rolledValue ?? part?.value) || 0);
    if (!largest || value > largest.value) largest = { part, value };
  }

  return {
    damageType: largest?.part?.damageType ?? state?.damageType ?? "physical",
    traitIds: Array.from(new Set(largest?.part?.traitIds ?? [])),
    sourcePartId: largest?.part?.id ?? null
  };
}

function manualDamageHistoryEntry(kind, details = {}) {
  return {
    kind,
    ...foundry.utils.deepClone(details)
  };
}

export function removeManualDamageDieFromState(state, partId) {
  const next = foundry.utils.deepClone(state ?? {});
  const part = (next.parts ?? []).find(candidate => candidate?.id === partId);
  if (!part || part.kind !== "die" || part.immuneRemoved) return null;
  if ((Number(part.currentValue ?? part.value) || 0) <= 0) return null;

  const before = Number(part.currentValue ?? part.value) || 0;
  // Исключение не превращает выпавший результат в 0. Значение сохраняется
  // для возврата, истории и Undo; из суммы его исключает флаг manualRemoved.
  part.manualRemoved = true;
  part.removed = true;

  next.manualDamageHistory = [
    ...(next.manualDamageHistory ?? []),
    manualDamageHistoryEntry("removeDie", {
      partId: part.id,
      faces: part.faces,
      value: before,
      damageType: part.damageType,
      traitIds: Array.from(part.traitIds ?? [])
    })
  ];

  return recalculateDamageState(next);
}

export function restoreManualDamageDieInState(state, partId) {
  const next = foundry.utils.deepClone(state ?? {});
  const part = (next.parts ?? []).find(candidate => candidate?.id === partId);
  if (!part || part.kind !== "die" || !part.manualRemoved || part.immuneRemoved) return null;

  part.manualRemoved = false;
  part.removed = false;
  next.manualDamageHistory = [
    ...(next.manualDamageHistory ?? []),
    manualDamageHistoryEntry("restoreDie", {
      partId: part.id,
      faces: part.faces,
      value: Number(part.currentValue ?? part.value) || 0,
      damageType: part.damageType,
      traitIds: Array.from(part.traitIds ?? [])
    })
  ];
  return recalculateDamageState(next);
}

export function rerollDamageDieInState(state, partId, nextValue, { phase = "application" } = {}) {
  const next = foundry.utils.deepClone(state ?? {});
  const part = (next.parts ?? []).find(candidate => candidate?.id === partId);
  const value = Math.max(0, Math.trunc(Number(nextValue) || 0));
  if (!part || part.kind !== "die" || !damagePartCanBeEdited(part) || value <= 0) return null;

  const previousValue = Number(part.currentValue ?? part.value) || 0;
  part.value = value;
  part.rolledValue = value;
  part.currentValue = value;
  part.nativeLabel = value;
  part.rerolled = true;
  next.manualDamageHistory = [
    ...(next.manualDamageHistory ?? []),
    manualDamageHistoryEntry("rerollDie", {
      partId: part.id,
      faces: part.faces,
      previousValue,
      value,
      phase
    })
  ];
  return recalculateDamageState(next);
}

function rekeyAddedDamageParts(existingState, addedState) {
  const used = new Set((existingState?.parts ?? []).map(part => String(part?.id ?? "")));
  let sequence = 0;

  return (addedState?.parts ?? []).map(part => {
    let id;
    do {
      id = `manual-part-${sequence++}`;
    } while (used.has(id));
    used.add(id);
    return {
      ...foundry.utils.deepClone(part),
      id,
      manualAdded: true,
      removed: false
    };
  });
}

export function appendManualDamageState(state, addedState, {
  formula = "",
  damageType = "physical",
  traitIds = []
} = {}) {
  if (!addedState?.supported || (addedState.penalties ?? []).length) return null;
  if (!(addedState.parts ?? []).length) return null;

  const next = foundry.utils.deepClone(state ?? {});
  const addedParts = rekeyAddedDamageParts(next, addedState);
  next.parts = [...(next.parts ?? []), ...addedParts];
  next.manualDamageHistory = [
    ...(next.manualDamageHistory ?? []),
    manualDamageHistoryEntry("addDamage", {
      formula,
      damageType,
      traitIds: Array.from(new Set(traitIds ?? [])),
      partIds: addedParts.map(part => part.id),
      rolledValues: addedParts.map(part => Number(part.rolledValue ?? part.value) || 0)
    })
  ];

  return recalculateDamageState(next);
}

function manualDamageDieChoiceLabel(part) {
  const labels = [
    damagePartLabel(part),
    damageTypeLabel(part?.damageType),
    ...(part?.traitIds ?? []).map(id => CREATURE_TRAITS[id] ?? id)
  ];
  return labels.filter(Boolean).join(" · ");
}

async function chooseManualDamageDie(state) {
  const dice = activeManualDamageParts(state).filter(part => part.kind === "die");
  if (!dice.length) {
    ui.notifications.info("В этой карточке нет выпавших кубов, которые можно убрать.");
    return null;
  }

  const { DialogV2 } = foundry.applications.api;
  const selected = await DialogV2.wait({
    classes: ["fast-nri-manual-damage-dialog"],
    window: { title: "Убрать куб урона" },
    content: `
      <div class="fast-nri-manual-damage-choice">
        <p>Выберите конкретный уже выпавший куб. Остальные результаты не перебрасываются.</p>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons: [
      ...dice.map((part, index) => ({
        action: `remove-die-${index}`,
        label: manualDamageDieChoiceLabel(part),
        icon: "fa-solid fa-dice",
        callback: async () => part.id
      })),
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: async () => null
      }
    ]
  });

  return selected || null;
}

function manualDamageTraitOptionsHTML(selectedIds = []) {
  const selected = new Set(selectedIds ?? []);
  return Object.entries(CREATURE_TRAITS)
    .filter(([id]) => !["physical", "magic"].includes(id))
    .map(([id, label]) => `
      <label class="fast-nri-manual-damage-trait-option">
        <input
          type="checkbox"
          value="${escAttr(id)}"
          data-fast-nri-manual-damage-trait
          ${selected.has(id) ? "checked" : ""}
        >
        <span>${esc(label)}</span>
      </label>
    `)
    .join("");
}

function collectManualDamageAddDialog(dialog) {
  const root = dialog.element;
  const formula = String(root.querySelector("[data-fast-nri-manual-damage-formula]")?.value ?? "").trim();
  const damageType = String(root.querySelector("[data-fast-nri-manual-damage-type]")?.value ?? "physical");
  const traitIds = Array.from(root.querySelectorAll("[data-fast-nri-manual-damage-trait]:checked"))
    .map(input => input.value);
  return { formula, damageType, traitIds };
}

function attachManualDamageAddDialog(dialog) {
  const root = dialog.element;
  const formulaInput = root.querySelector("[data-fast-nri-manual-damage-formula]");
  root.querySelectorAll("[data-fast-nri-manual-damage-die]").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      if (!formulaInput) return;
      formulaInput.value = String(button.dataset.fastNriManualDamageDie ?? "1d6");
      formulaInput.focus();
      formulaInput.select?.();
    });
  });
}

async function chooseRestorableManualDamageDie(state) {
  const dice = (state?.parts ?? []).filter(part => part?.kind === "die" && part?.manualRemoved && !part?.immuneRemoved);
  if (!dice.length) {
    ui.notifications.info("В этой карточке нет вручную исключённых кубов, которые можно вернуть.");
    return null;
  }
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    classes: ["fast-nri-manual-damage-dialog"],
    window: { title: "Вернуть куб урона" },
    content: `<div class="fast-nri-manual-damage-choice"><p>Куб вернётся с тем же сохранённым результатом, без нового броска.</p></div>`,
    modal: true,
    rejectClose: false,
    buttons: [
      ...dice.map((part, index) => ({
        action: `restore-die-${index}`,
        label: manualDamageDieChoiceLabel(part),
        icon: "fa-solid fa-rotate-left",
        callback: async () => part.id
      })),
      { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", callback: async () => null }
    ]
  });
}

async function chooseRerollableDamageDie(state) {
  const dice = activeManualDamageParts(state).filter(part => part.kind === "die");
  if (!dice.length) {
    ui.notifications.info("Нет активных кубов, доступных для таргетного переброса.");
    return null;
  }
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    classes: ["fast-nri-manual-damage-dialog"],
    window: { title: "Таргетный переброс" },
    content: `<div class="fast-nri-manual-damage-choice"><p>Перебрасывается только выбранный активный куб. Выбывшие кубы сначала нужно вернуть.</p></div>`,
    modal: true,
    rejectClose: false,
    buttons: [
      ...dice.map((part, index) => ({
        action: `reroll-die-${index}`,
        label: manualDamageDieChoiceLabel(part),
        icon: "fa-solid fa-dice",
        callback: async () => part.id
      })),
      { action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", callback: async () => null }
    ]
  });
}

async function chooseManualDamageAddition(state) {
  const defaults = manualDamageDefaultMeta(state);
  const { DialogV2 } = foundry.applications.api;
  const dice = [4, 6, 8, 10, 12, 20];

  return DialogV2.wait({
    classes: ["fast-nri-manual-damage-dialog"],
    window: { title: "Добавить урон" },
    content: `
      <div class="fast-nri-manual-damage-add">
        <p>Добавленные кубы бросаются отдельно. Уже выпавший урон не перебрасывается.</p>
        <div class="fast-nri-manual-damage-dice">
          ${dice.map(faces => `
            <button type="button" data-fast-nri-manual-damage-die="1d${faces}">1d${faces}</button>
          `).join("")}
        </div>
        <label>
          Кубы / значение
          <input
            type="text"
            value="1d6"
            placeholder="1d6, 2d8, 1d10+4"
            data-fast-nri-manual-damage-formula
          >
        </label>
        <div class="fast-nri-manual-damage-meta">
          <label>
            Тип урона
            <select data-fast-nri-manual-damage-type>
              <option value="physical" ${defaults.damageType === "physical" ? "selected" : ""}>Физический</option>
              <option value="magic" ${defaults.damageType === "magic" ? "selected" : ""}>Магический</option>
            </select>
          </label>
          <div class="fast-nri-manual-damage-traits-field">
            <span>Свойства</span>
            <div class="fast-nri-manual-damage-traits">
              ${manualDamageTraitOptionsHTML(defaults.traitIds)}
            </div>
          </div>
        </div>
        <small>
          Тип и свойства по умолчанию взяты у самой большой текущей части урона.
          Их можно изменить перед броском.
        </small>
      </div>
    `,
    modal: true,
    rejectClose: false,
    render: (_event, dialog) => attachManualDamageAddDialog(dialog),
    buttons: [
      {
        action: "add",
        label: "Добавить и бросить",
        icon: "fa-solid fa-plus",
        default: true,
        callback: async (_event, _button, dialog) => collectManualDamageAddDialog(dialog)
      },
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: async () => null
      }
    ]
  });
}

async function damageCardPresentationFromMessage(message, state) {
  const stored = message?.getFlag?.("fast-nri", "damageCardMeta") ?? {};
  const itemUuid = message?.getFlag?.("fast-nri", "itemUuid") ?? null;
  let sourceItem = null;
  if (itemUuid) {
    try {
      sourceItem = await fromUuid(itemUuid);
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось найти источник Damage-card", error);
    }
  }

  const sourceName = stored.sourceName || sourceItem?.name || "Урон";
  const profile = message?.getFlag?.("fast-nri", "profile") ?? null;
  const labels = { partial: "Частичный", success: "Успех", great: "Большой" };
  let profileLabel = stored.profileLabel || labels[profile] || profile || "";

  if (!profileLabel && message?.getFlag?.("fast-nri", "abilityOutcome")) {
    let runtime = sourceItem;
    if (sourceItem?.type === "ability") {
      const implementationId = message?.getFlag?.("fast-nri", "implementationId") ?? null;
      runtime = abilityImplementationRuntime(sourceItem, implementationId) ?? sourceItem;
    }
    profileLabel = abilityIsSpell(runtime) ? "Заклинание" : "Способность";
  }

  const actionContext = actionContextFromMessage(message);
  const allowDefense = stored.allowDefense ?? Boolean(
    message?.getFlag?.("fast-nri", "directedDefense")
    ?? actionHasDefenseProcedure(actionContext, "directed")
  );
  const targetCharacteristic = message?.getFlag?.("fast-nri", "targetCharacteristic")
    ?? actionContext?.check?.targetCharacteristic
    ?? null;
  const hasAttackResult = finiteNumberOrNull(message?.getFlag?.("fast-nri", "attackTotal")) !== null;
  const allowDouble = stored.allowDouble ?? Boolean(hasAttackResult && targetCharacteristic === "armor");

  return {
    sourceName,
    profileLabel,
    targetName: stored.targetName ?? message?.getFlag?.("fast-nri", "resultTargetName") ?? "",
    allowDefense,
    allowDouble,
    critical: Boolean(message?.getFlag?.("fast-nri", "critical")),
    modifiersHTML: message?.getFlag?.("fast-nri", "modifierNotesHTML") ?? "",
    actionContext
  };
}

async function damageMessageDataForUpdate(message, state, operation, { applicationEffectUuids = null } = {}) {
  const presentation = await damageCardPresentationFromMessage(message, state);
  const actionContext = normalizeActionContext(
    presentation.actionContext ?? normalizeActionContext({})
  );
  const baseFlags = foundry.utils.deepClone(message?.flags?.["fast-nri"] ?? {});
  const revision = Math.max(0, Number(baseFlags.damageRevision) || 0) + 1;
  const damageCardMeta = {
    sourceName: presentation.sourceName,
    profileLabel: presentation.profileLabel,
    targetName: presentation.targetName,
    allowDefense: presentation.allowDefense,
    allowDouble: presentation.allowDouble
  };

  const effectUuids = applicationEffectUuids === null
    ? Array.from(baseFlags.applicationEffectUuids ?? [])
    : Array.from(applicationEffectUuids ?? []);
  const applicationEffects = applicationEffectUuids === null
    ? await applicationEffectsFromUuids(baseFlags.applicationEffectUuids ?? [])
    : await applicationEffectsFromUuids(effectUuids);
  const flavor = damageCardHTML({
    sourceName: presentation.sourceName,
    profileLabel: presentation.profileLabel,
    targetName: presentation.targetName,
    critical: presentation.critical,
    state,
    modifiersHTML: presentation.modifiersHTML,
    applicationEffectsHTML: applicationEffects.html,
    allowDefense: presentation.allowDefense,
    allowDouble: presentation.allowDouble
  });

  return {
    flavor,
    flags: {
      ...baseFlags,
      kind: "damage",
      damageRevision: revision,
      damageEditOperation: foundry.utils.deepClone(operation ?? null),
      finalTotal: state.currentTotal,
      actionContext,
      actionTraits: actionContext.traits,
      targetCharacteristic: actionContext.check.targetCharacteristic || baseFlags.targetCharacteristic || null,
      damageCardMeta,
      applicationEffectUuids: effectUuids,
      damageState: state
    }
  };
}

async function updateDamageMessageInPlace(message, state, operation, options = {}) {
  const data = await damageMessageDataForUpdate(message, state, operation, options);
  const cardField = Array.from(message?.rolls ?? []).length ? "flavor" : "content";
  await message.update({
    [cardField]: data.flavor,
    "flags.fast-nri": data.flags
  });
  return { message, data };
}

export async function removeDamageDieFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message) return null;

  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "damageState"));
  if (!state?.supported) {
    ui.notifications.warn("Эту Damage-card нельзя безопасно редактировать по отдельным кубам.");
    return null;
  }

  const partId = await chooseManualDamageDie(state);
  if (!partId) return null;
  const next = removeManualDamageDieFromState(state, partId);
  if (!next) return null;

  const removedPart = (state.parts ?? []).find(part => part.id === partId) ?? null;
  await updateDamageMessageInPlace(message, next, {
    kind: "removeDie",
    partId,
    faces: removedPart?.faces ?? null,
    value: removedPart?.currentValue ?? removedPart?.value ?? null
  });
  return { message, sourceMessage: message, damageState: next };
}

export async function restoreDamageDieFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "damageState"));
  if (!state?.supported) return null;
  const partId = await chooseRestorableManualDamageDie(state);
  if (!partId) return null;
  const next = restoreManualDamageDieInState(state, partId);
  if (!next) return null;
  const restoredPart = (next.parts ?? []).find(part => part.id === partId) ?? null;
  await updateDamageMessageInPlace(message, next, {
    kind: "restoreDie",
    partId,
    faces: restoredPart?.faces ?? null,
    value: restoredPart?.currentValue ?? restoredPart?.value ?? null
  });
  return { message, sourceMessage: message, damageState: next };
}

export async function rerollDamageDieFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "damageState"));
  if (!state?.supported) {
    ui.notifications.warn("Эта карточка не поддерживает безопасный таргетный переброс кубов.");
    return null;
  }
  const partId = await chooseRerollableDamageDie(state);
  if (!partId) return null;
  const part = (state.parts ?? []).find(candidate => candidate.id === partId);
  if (!part || !damagePartCanBeEdited(part)) return null;
  const roll = await new Roll(`1d${Number(part.faces) || 6}`).evaluate();
  await showInPlaceRollDice(roll);
  const value = Number(roll.total) || 0;
  const phase = message.getFlag("fast-nri", "applicationPhase") === "final" ? "application" : "resolution";
  const next = rerollDamageDieInState(state, partId, value, { phase });
  if (!next) return null;
  await updateDamageMessageInPlace(message, next, {
    kind: "rerollDie",
    partId,
    faces: part.faces,
    previousValue: part.currentValue ?? part.value,
    value,
    phase
  });
  return { message, sourceMessage: message, roll, damageState: next };
}

export async function addDamageFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message) return null;

  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "damageState"));
  if (!state?.supported) {
    ui.notifications.warn("Эту Damage-card нельзя безопасно расширить структурированным уроном.");
    return null;
  }

  const selected = await chooseManualDamageAddition(state);
  if (!selected?.formula) return null;

  let roll;
  try {
    roll = await new Roll(selected.formula).evaluate();
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка формулы добавляемого урона", error);
    ui.notifications.error(`Некорректная формула урона: ${selected.formula}`);
    return null;
  }
  await showInPlaceRollDice(roll);

  const added = buildDamageState(roll, {
    damageType: selected.damageType,
    traitIds: selected.traitIds
  });
  if (!added.supported || (added.penalties ?? []).length || !(added.parts ?? []).length) {
    ui.notifications.error("Добавляемый урон должен состоять из положительных кубов и/или положительных значений.");
    return null;
  }

  const next = appendManualDamageState(state, added, selected);
  if (!next) return null;
  await updateDamageMessageInPlace(message, next, {
    kind: "addDamage",
    formula: selected.formula,
    damageType: selected.damageType,
    traitIds: selected.traitIds,
    rolledTotal: roll.total
  });
  return { message, sourceMessage: message, roll, damageState: next };
}

async function chooseDamagePart(parts, mode = "largest", actionName = "Защита") {
  const active = (parts ?? []).filter(part => !damagePartExcludedFromTotal(part) && (Number(part.currentValue ?? part.value) || 0) > 0);
  if (!active.length) return null;

  const values = active.map(part => Number(part.currentValue ?? part.value) || 0);
  const targetValue = mode === "smallest"
    ? Math.min(...values)
    : Math.max(...values);

  const tied = active.filter(
    part => (Number(part.currentValue ?? part.value) || 0) === targetValue
  );

  if (tied.length === 1) return tied[0];

  const { DialogV2 } = foundry.applications.api;
  const word = mode === "smallest" ? "маленьких" : "больших";

  const choice = await DialogV2.wait({
    window: {
      title: `${actionName}: выберите часть урона`
    },
    content: `
      <div class="fast-nri-defense-choice">
        <p>
          Несколько самых ${word} кубов имеют одинаковый результат
          <strong>${esc(targetValue)}</strong>.
          Выберите, какую часть удалить при успешной защите.
        </p>
        <p>
          Выбор выполняется <strong>до броска защиты</strong>,
          поэтому закрытие этого окна не позволяет перебрасывать уже
          совершённую проверку.
        </p>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons: [
      ...tied.map((part, index) => ({
        action: `part-${index}`,
        label: damagePartLabel(part),
        icon: "fa-solid fa-dice",
        callback: async () => part.id
      })),
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: async () => null
      }
    ]
  });

  if (!choice) return null;
  return tied.find(part => part.id === choice) ?? null;
}

async function chooseDamageParts(parts, count = 1, mode = "largest", actionName = "Защита") {
  const requested = Math.max(0, Math.trunc(Number(count) || 0));
  if (requested <= 0) return [];

  const working = foundry.utils.deepClone(parts ?? []);
  const selected = [];

  for (let index = 0; index < requested; index += 1) {
    const part = await chooseDamagePart(working, mode, actionName);
    if (!part) {
      const stillAvailable = working.some(candidate =>
        !damagePartExcludedFromTotal(candidate)
        && (Number(candidate.currentValue ?? candidate.value) || 0) > 0
      );
      if (stillAvailable) return null;
      break;
    }

    selected.push(part);
    const found = working.find(candidate => candidate.id === part.id);
    if (found) {
      found.defenseZeroed = true;
    }
  }

  return selected;
}

function normalizedProperty(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е");
}

function itemPropertySet(item) {
  const result = new Set();

  // Единственный источник свойств:
  // стабильные ID из system.propertyIds.
  for (const id of item?.system?.propertyIds ?? []) {
    if (ITEM_PROPERTY_IDS.includes(id)) result.add(id);
  }

  return result;
}

function itemHasProperty(item, propertyId) {
  return itemPropertySet(item).has(String(propertyId ?? "").trim());
}

function actorAbilityItems(actor) {
  return actor?.items?.contents ?? Array.from(actor?.items ?? []);
}

function defenseCombatTerm(actor, actionItem = null, role = "self") {
  return resolveDefenseCombatSource(actor, actionItem, role);
}

function equippedDefensiveItem(actor) {
  return actorAbilityItems(actor).find(item =>
    (item?.type === "weapon" || item?.type === "equipment")
    && itemIsEquipped(item)
    && itemIsHeld(item)
    && itemHasProperty(item, "defensive")
  ) ?? null;
}

function selfDefenseContextualModifiers(actor, weapon, effectDegree) {
  const modifiers = [];

  const defensiveItem = equippedDefensiveItem(actor);
  if (defensiveItem) {
    modifiers.push({
      id: `equipped-defensive-${defensiveItem.id}`,
      formula: "1d6",
      label: defensiveItem.name,
      reason: "Удерживаемый предмет: Защитное"
    });
  }

  if (itemHasProperty(weapon, "piercing")) {
    modifiers.push({
      id: "weapon-piercing",
      formula: "-5",
      label: "Пробивающий",
      reason: weapon?.name || "Исходная атака"
    });
  }

  if (itemHasProperty(weapon, "deadly") && effectDegree === "great") {
    modifiers.push({
      id: "weapon-deadly",
      formula: "-10",
      label: "Смертельное",
      reason: "Большой успех исходной атаки"
    });
  }

  return modifiers;
}

function selfDefenseRemovalMode(weapon) {
  return itemHasProperty(weapon, "steady") ? "smallest" : "largest";
}

async function confirmZeroDamageDefense(actionName = "Защита") {
  const { DialogV2 } = foundry.applications.api;

  return DialogV2.confirm({
    window: {
      title: `${actionName} при 0 урона`
    },
    content: `
      <div class="fast-nri-defense-choice">
        <p>
          Сейчас итоговый урон равен <strong>0</strong>.
          Направленная защита нужна только если остаётся результат Манёвра
          или другой отрицательный Эффект.
        </p>
        <p>
          Продолжить защиту ради отрицательного Эффекта?
        </p>
      </div>
    `
  });
}

function controlledSingleDefenderToken() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);

  if (controlled.length === 0) {
    ui.notifications.warn("Для защиты выдели один токен-защитник.");
    return null;
  }

  if (controlled.length > 1) {
    ui.notifications.warn("Для защиты должен быть выделен только один токен.");
    return null;
  }

  return controlled[0];
}


function outcomeComponentTraitIds(component, item, actor) {
  const traits = new Set(component?.traitIds ?? []);
  for (const id of actor?.system?.creatureTraitIds ?? []) traits.add(id);
  return Array.from(traits);
}

function abilityOutcomeChannel(item, kind, degree = null) {
  return abilityOutcomeChannelForDegree(item, kind, degree);
}

function abilityCheckDefenseHTML(actionContext) {
  const labels = [];
  if (actionHasDefenseProcedure(actionContext, "counteraction")) labels.push("Противодействие");
  if (actionHasDefenseProcedure(actionContext, "dodge")) labels.push("Уворот");
  if (!labels.length) return "";

  return `
    <div class="fast-nri-ability-outcome-actions fast-nri-check-defense-actions">
      <button
        type="button"
        data-fast-nri-check-defense
        title="Доступно: ${escAttr(labels.join(", "))}"
      >
        <i class="fa-solid fa-shield-halved"></i>
        <span>Защита</span>
      </button>
    </div>
  `;
}

function abilityFollowupButtonHTML(actor, item, kind, implementationId = null, repeatIndex = 0, profileDegree = null) {
  const labels = {
    damage: ["fa-burst", "Бросить урон"],
    healing: ["fa-heart-pulse", "Бросить лечение"],
    tempHp: ["fa-shield-heart", "Бросить временные HP"],
    application: ["fa-check", "Подготовить результат"]
  };
  const [icon, label] = labels[kind] ?? ["fa-dice", "Выполнить результат"];
  return `
    <button
      type="button"
      data-fast-nri-roll-ability-outcome
      data-source-attack="true"
      data-actor-uuid="${escAttr(actor.uuid)}"
      data-item-uuid="${escAttr(item.uuid)}"
      data-implementation-id="${escAttr(implementationId ?? "")}"
      data-repeat-index="${escAttr(repeatIndex)}"
      data-profile-degree="${escAttr(profileDegree ?? "")}"
      data-outcome-kind="${escAttr(kind)}"
    >
      <i class="fa-solid ${icon}"></i>
      <span>${label}</span>
    </button>
  `;
}

export function abilityAttackFollowupHTML(actor, item, degree = null, implementationId = null, repeatIndex = 0) {
  const runtime = abilityImplementationRuntime(item, implementationId);
  if (abilityHasDegreeProfiles(runtime)) {
    const rows = [];
    for (const [profileDegree, label] of Object.entries(DEGREE_LABELS)) {
      const profile = abilityProfile(runtime, profileDegree);
      if (!profile.enabled) continue;
      const kinds = abilityConfiguredOutcomeKinds(runtime, profileDegree);
      if (!kinds.length && !profile.effectUuids?.length && !String(profile.text ?? "").trim()) continue;
      const actionKinds = kinds.length ? kinds : (profile.effectUuids?.length ? ["application"] : []);
      const recommended = profileDegree === degree;
      rows.push(`<section class="fast-nri-degree-choice ${recommended ? "recommended" : ""}">
        <strong>${esc(label)}${recommended ? " · рассчитано" : ""}</strong>
        <div class="fast-nri-ability-outcome-actions">${actionKinds.map(kind => abilityFollowupButtonHTML(actor, item, kind, runtime?.implementationId ?? implementationId, repeatIndex, profileDegree)).join("")}</div>
      </section>`);
    }
    return rows.length ? `<div class="fast-nri-degree-choice-list">${rows.join("")}</div>` : "";
  }

  // Compatibility for outcomes without degree profiles.
  const kinds = degree
    ? abilityConfiguredOutcomeKinds(runtime, degree)
    : abilityOutcomeChannel(runtime, "damage").enabled ? ["damage"] : [];
  if (!kinds.length) return "";
  return `<div class="fast-nri-ability-outcome-actions">${kinds.map(kind => abilityFollowupButtonHTML(actor, item, kind, runtime?.implementationId ?? implementationId, repeatIndex)).join("")}</div>`;
}

function applyAbilityProfileDamageTransform(state, channel = {}) {
  if (!state?.supported) return state;

  const removeAll = Boolean(channel?.removeAll);
  const removeHighest = Math.max(0, Math.trunc(Number(channel?.removeHighest) || 0));
  const removeLowest = Math.max(0, Math.trunc(Number(channel?.removeLowest) || 0));
  if (!removeAll && removeHighest === 0 && removeLowest === 0) return state;

  const candidates = Array.from(state.parts ?? [])
    .filter(part => Math.max(0, Number(part.currentValue ?? part.value) || 0) > 0);
  const selected = new Set();

  if (removeAll) {
    for (const part of candidates) selected.add(part.id);
  } else {
    const ascending = [...candidates].sort((a, b) => {
      const delta = (Number(a.currentValue ?? a.value) || 0) - (Number(b.currentValue ?? b.value) || 0);
      return delta || String(a.id).localeCompare(String(b.id));
    });
    for (const part of ascending.slice(0, removeLowest)) selected.add(part.id);
    for (const part of ascending.slice(Math.max(0, ascending.length - removeHighest))) selected.add(part.id);
  }

  state.parts = Array.from(state.parts ?? []).map(part => selected.has(part.id)
    ? { ...part, profileZeroed: true }
    : part
  );
  state.profileDamageTransform = {
    removeAll,
    removeHighest,
    removeLowest,
    removedPartIds: Array.from(selected)
  };
  return recalculateDamageState(state);
}

function abilityOutcomeComponents(actor, item, kind, degree = null) {
  const channel = abilityOutcomeChannel(item, kind, degree);
  const raw = Array.from(channel.components ?? []);
  const components = raw.length
    ? raw
    : [{ formula: "1d6", damageType: "physical", traitIds: [] }];

  return components
    .map(component => ({
      formula: String(component?.formula ?? "").trim(),
      damageType: component?.damageType === "magic" ? "magic" : "physical",
      traitIds: outcomeComponentTraitIds(component, item, actor)
    }))
    .filter(component => component.formula);
}

async function enrichAbilityProfileHTML(item, degree) {
  if (!degree) return "";
  const profile = abilityProfile(item, degree);
  if (!profile.enabled) return "";

  const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation
    ?? globalThis.foundry?.applications?.ux?.TextEditor;
  let richText = String(profile.text ?? "").trim();
  if (richText && typeof editor?.enrichHTML === "function") {
    try {
      richText = await editor.enrichHTML(richText, { async: true });
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось обогатить текст профиля", error);
    }
  }

  const effects = await resolveEffectDocuments(profile.effectUuids);
  const effectCards = [];
  for (const effect of effects) {
    let descriptionHTML = String(effect.system?.description ?? "").trim();
    if (descriptionHTML && typeof editor?.enrichHTML === "function") {
      try {
        descriptionHTML = await editor.enrichHTML(descriptionHTML, { async: true });
      } catch (error) {
        console.warn("Быстрая НРИ | Не удалось обогатить текст Effect профиля", error);
      }
    }
    effectCards.push(effectChatCardHTML(effect, { compact: true, descriptionHTML }));
  }

  if (!richText && !effectCards.length) return "";
  return `
    <section class="fast-nri-chat-degree-profile active">
      <strong>Эффект степени: ${esc(DEGREE_LABELS[degree] ?? degree)}</strong>
      ${richText ? `<div class="fast-nri-chat-profile-text">${richText}</div>` : ""}
      ${effectCards.length ? `<div class="fast-nri-ability-linked-effects">${effectCards.join("")}</div>` : ""}
    </section>
  `;
}

function hpGainComponentFlavor(component) {
  const labels = (component?.traitIds ?? []).map(id => HP_GAIN_SOURCE_TRAITS[id] ?? id);
  return Array.from(new Set(labels)).join(" • ") || "Получение HP";
}

function plainHpGainFormula(components) {
  return (components ?? []).map(component => `(${component.formula})`).join(" + ") || "0";
}

function flavoredHpGainFormula(components) {
  const chunks = [];

  for (const component of components ?? []) {
    const parsed = new Roll(component.formula);
    const flavor = hpGainComponentFlavor(component);

    const formula = parsed.terms.map(term => {
      if (term?.operator) return term.operator;
      const raw = String(term?.formula ?? term?.expression ?? "").trim();
      if (!raw) return "";
      return `${raw}[${flavor}]`;
    }).filter(Boolean).join(" ");

    chunks.push(formula);
  }

  return chunks.join(" + ") || "0";
}

function hpGainComponentMap(components) {
  const map = new Map();
  for (const component of components ?? []) {
    map.set(hpGainComponentFlavor(component), component);
  }
  return map;
}

function termHpGainMeta(term, componentMap) {
  const flavor = String(term?.flavor ?? term?.options?.flavor ?? "").trim();
  const component = flavor ? componentMap.get(flavor) : null;
  return {
    traitIds: Array.from(new Set(component?.traitIds ?? []))
  };
}

function buildHpGainState(roll, { components = [] } = {}) {
  const parts = [];
  const penalties = [];
  const componentMap = hpGainComponentMap(components);
  let sign = 1;
  let supported = true;
  let sequence = 0;

  for (const term of roll?.terms ?? []) {
    const operator = String(term?.operator ?? "").trim();
    if (operator) {
      if (operator === "+") sign = 1;
      else if (operator === "-") sign = -1;
      else supported = false;
      continue;
    }

    const meta = termHpGainMeta(term, componentMap);
    const dieResults = activeDieResults(term);

    if (dieResults) {
      for (const dieResult of dieResults) {
        const entry = {
          id: `hp-part-${sequence++}`,
          kind: "die",
          faces: Number(term.faces),
          value: dieResult.value,
          rolledValue: dieResult.value,
          currentValue: dieResult.value,
          nativeLabel: dieResult.label,
          nativeResultCSS: dieResult.css,
          traitIds: meta.traitIds,
          immuneRemoved: false
        };
        if (sign >= 0) parts.push(entry);
        else penalties.push({ ...entry, id: `hp-penalty-${sequence++}` });
      }
      continue;
    }

    const numeric = finiteNumberOrNull(term?.number ?? term?.total);
    if (numeric !== null) {
      if (numeric > 0 && sign >= 0) {
        parts.push({
          id: `hp-part-${sequence++}`,
          kind: "fixed",
          faces: null,
          value: numeric,
          rolledValue: numeric,
          currentValue: numeric,
          traitIds: meta.traitIds,
          immuneRemoved: false
        });
      } else if (numeric > 0 && sign < 0) {
        penalties.push({
          id: `hp-penalty-${sequence++}`,
          kind: "fixed",
          faces: null,
          value: numeric,
          rolledValue: numeric,
          currentValue: numeric,
          traitIds: meta.traitIds,
          immuneRemoved: false
        });
      }
      continue;
    }

    if (term?.formula || term?.expression) supported = false;
  }

  const partsTotal = parts.reduce((sum, part) => sum + Math.max(0, Number(part.currentValue) || 0), 0);
  const penalty = penalties.reduce((sum, part) => sum + Math.max(0, Number(part.currentValue) || 0), 0);

  return {
    supported,
    parts,
    penalties,
    partsTotal,
    penalty,
    currentTotal: Math.max(0, partsTotal - penalty),
    originalRollTotal: Number(roll?.total) || 0
  };
}

function hpGainPartLabel(part) {
  if (part?.kind === "die") return `d${part.faces}: ${part.value}`;
  return `фикс. +${part?.value ?? 0}`;
}

function hpGainPartsHTML(state) {
  if (!state?.supported) {
    return `<div class="fast-nri-damage-structure-warning"><i class="fa-solid fa-triangle-exclamation"></i>Не удалось разобрать Получение HP на отдельные части.</div>`;
  }

  const parts = (state.parts ?? []).map(part => {
    const traits = (part.traitIds ?? []).map(id => HP_GAIN_SOURCE_TRAITS[id] ?? id);
    const traitsHTML = `<small class="fast-nri-damage-part-traits">${traits.length ? traits.map(esc).join(" · ") : "Без свойств"}</small>`;

    if (part.kind === "die") {
      const nativeClasses = nativeDamageDieClasses(part);
      return `
        <span class="fast-nri-damage-part-stack">
          <span class="fast-nri-damage-native-part" title="${escAttr(hpGainPartLabel(part))}">
            <span class="fast-nri-damage-native-type">d${esc(part.faces)}:</span>
            <span class="dice-tooltip fast-nri-inline-dice-tooltip">
              <section class="tooltip-part"><div class="dice"><ol class="dice-rolls fast-nri-damage-native-rolls">
                <li class="${escAttr(nativeClasses)}">${esc(part.nativeLabel ?? part.value)}</li>
              </ol></div></section>
            </span>
          </span>
          ${traitsHTML}
        </span>`;
    }

    return `
      <span class="fast-nri-damage-part-stack">
        <span class="fast-nri-damage-fixed-part" title="${escAttr(hpGainPartLabel(part))}">
          <span class="fast-nri-damage-native-type">+${esc(part.value)}:</span>
          <strong class="fast-nri-fixed-result">${esc(part.value)}</strong>
        </span>
        ${traitsHTML}
      </span>`;
  }).join("");

  return `
    <section class="fast-nri-damage-parts-block fast-nri-hp-gain-parts-block">
      <div class="fast-nri-damage-parts-title">Части Получения HP</div>
      <div class="fast-nri-damage-equation">
        <div class="fast-nri-damage-parts">${parts || `<span class="fast-nri-roll-empty">Нет положительных частей.</span>`}</div>
        ${state.penalty > 0 ? `<span class="fast-nri-damage-adjustment">−${esc(state.penalty)}</span>` : ""}
        <span class="fast-nri-damage-equation-arrow">→</span>
        <strong class="fast-nri-damage-equation-total">${esc(state.currentTotal)}</strong>
      </div>
    </section>`;
}

function hpGainRollCardHTML({ item, kind, state, modifiersHTML = "" }) {
  const healing = kind === "healing";
  const title = healing ? "Восстановление HP" : "Временные HP";
  const icon = healing ? "fa-heart-pulse" : "fa-shield-heart";
  const action = healing ? "data-fast-nri-apply-healing" : "data-fast-nri-apply-temp-hp";
  const button = healing ? "Восстановить HP" : "Дать временные HP";

  return `
    <div class="fast-nri-chat-roll fast-nri-hp-gain-card">
      ${rollCardHeader(`${title}: ${item.name}`, icon)}
      ${hpGainPartsHTML(state)}
      <div class="fast-nri-hp-gain-actions">
        <button type="button" ${action} data-amount="${escAttr(state.currentTotal)}">
          <i class="fa-solid ${icon}"></i>
          <span>${button}</span>
        </button>
      </div>
      ${modifiersHTML}
    </div>`;
}


function expandAbilityCheckFormula(actor, rawFormula) {
  return formulaWithActorCombatTerm(actor, rawFormula);
}

function abilityCheckFormulaSources(actor, rawFormula, expandedFormula, targetCharacteristic) {
  const raw = String(rawFormula ?? "").trim();
  const targetLabel = checkTargetCharacteristicLabel(targetCharacteristic);
  const label = `Проверка против ${targetLabel}`;

  if (raw.includes("{combatDie}") || raw.includes("@combatDie")) {
    const term = resolveActorCombatTerm(actor);
    return [{
      formula: expandedFormula,
      label,
      reason: term
        ? `Формула способности; ${term.label} ${term.formula}`
        : "Формула способности; боевой член отсутствует"
    }];
  }

  return [{
    formula: expandedFormula,
    label,
    reason: "Формула способности/заклинания"
  }];
}

function resolveAbilityCheckTarget(target, targetCharacteristic, actor) {
  if (!target?.actor) return null;

  if (targetCharacteristic === "armor") {
    return effectiveArmorForAction(target, actor);
  }

  return effectiveDefenseCharacteristicForAction(
    target,
    targetCharacteristic,
    actor
  );
}

function degreeForAbilityCheck(result, targetCharacteristic, resolvedTarget) {
  if (!resolvedTarget) return null;

  if (targetCharacteristic === "armor") {
    return degreeVsArmor(
      result.roll.total,
      resolvedTarget.armor,
      result.naturalD20
    );
  }

  const dc = finiteNumberOrNull(resolvedTarget.value);
  if (dc === null) return null;
  return degreeVsDC(result.roll.total, dc, result.naturalD20);
}


const MULTI_TARGET_ABILITY_KIND = "ability-multitarget";
const MULTI_TARGET_DEGREE_ORDER = ["failure", "partial", "success", "great"];

function multiTargetAbilityEligible(runtime, actionTraits) {
  return Boolean(actionTraits?.area && abilityHasDegreeProfiles(runtime));
}

function componentSignature(component) {
  return JSON.stringify({
    formula: String(component?.formula ?? "").replace(/\s+/g, "").trim(),
    damageType: component?.damageType === "magic" ? "magic" : "physical",
    traitIds: Array.from(new Set(component?.traitIds ?? [])).sort()
  });
}

function sharedAreaDamagePlan(actor, runtime) {
  const configured = [];
  for (const degree of ["great", "success", "partial", "failure"]) {
    const channel = abilityOutcomeChannel(runtime, "damage", degree);
    if (!channel?.enabled) continue;
    const components = abilityOutcomeComponents(actor, runtime, "damage", degree);
    if (!components.length) continue;
    configured.push({ degree, channel, components });
  }

  if (!configured.length) {
    return { compatible: true, degree: null, components: [], reason: null };
  }

  const canonical = configured[0];
  const signature = canonical.components.map(componentSignature).join("|");
  const incompatible = configured.find(entry => entry.components.map(componentSignature).join("|") !== signature);
  if (incompatible) {
    return {
      compatible: false,
      degree: canonical.degree,
      components: canonical.components,
      reason: "Профили степеней используют разные формулы урона. Общий пул нельзя безопасно бросить один раз."
    };
  }

  return {
    compatible: true,
    degree: canonical.degree,
    components: canonical.components,
    reason: null
  };
}

function tokenDocumentUuid(token) {
  return token?.document?.uuid ?? token?.uuid ?? null;
}

function multiTargetEntryForToken(token, { result, targetCharacteristic, sourceActor }) {
  if (!token?.actor) return null;
  const resolved = resolveAbilityCheckTarget(token, targetCharacteristic, sourceActor);
  const baseDegree = resolved ? degreeForAbilityCheck(result, targetCharacteristic, resolved) : null;
  const defenseValue = targetCharacteristic === "armor"
    ? finiteNumberOrNull(resolved?.armor)
    : finiteNumberOrNull(resolved?.value);
  return {
    tokenUuid: tokenDocumentUuid(token),
    actorUuid: token.actor.uuid ?? null,
    name: token.name || token.actor.name || "Цель",
    defenseValue,
    baseDegree,
    defendedDegree: null,
    manualDegree: null,
    pendingDefenses: [],
    appliedDefenseHistory: [],
    lastDefenseOutcome: null
  };
}

export function multiTargetFinalDegree(target = {}) {
  const manual = MULTI_TARGET_DEGREE_ORDER.includes(target?.manualDegree) ? target.manualDegree : null;
  const defended = MULTI_TARGET_DEGREE_ORDER.includes(target?.defendedDegree) ? target.defendedDegree : null;
  const base = MULTI_TARGET_DEGREE_ORDER.includes(target?.baseDegree) ? target.baseDegree : null;
  return manual ?? defended ?? base;
}

function multiTargetDefenseChain(target = {}) {
  return [
    ...(target?.appliedDefenseHistory ?? []),
    ...(target?.pendingDefenses ?? [])
  ];
}

/**
 * 0.5.62 live-QA bridge toward TargetResult.steps[].
 * Each defense is a chronological step inside the target row. The current
 * degree is always rebuilt from baseDegree + active defense steps; reroll and
 * undo therefore never require a new root ChatMessage.
 */
export function recalculateMultiTargetDefenseChain(target = {}) {
  const next = foundry.utils.deepClone(target ?? {});
  const chain = multiTargetDefenseChain(next).map(entry => foundry.utils.deepClone(entry));
  let degree = MULTI_TARGET_DEGREE_ORDER.includes(next.baseDegree) ? next.baseDegree : null;
  let lastOutcome = null;

  for (const defense of chain) {
    const undone = defense?.status === "undone" || defense?.undone === true;
    if (undone) continue;

    const requestedDegreeReduction = Math.max(
      1,
      Number(defense?.requestedDegreeReduction ?? defense?.degreeReduction ?? 1) || 1
    );
    const hasStoredTotals = finiteNumberOrNull(defense?.total) !== null
      && finiteNumberOrNull(defense?.attackTotal) !== null;
    const resolved = hasStoredTotals
      ? resolveCheckDefenseResult({
          degreeBefore: degree,
          defenseTotal: defense?.total,
          attackTotal: defense?.attackTotal,
          naturalD20: defense?.naturalD20,
          degreeReduction: requestedDegreeReduction
        })
      : (() => {
          const storedResult = defense?.result === "success" ? "success" : "failure";
          const degreeAfter = storedResult === "success"
            ? (Number(defense?.naturalD20) === 20 ? "failure" : lowerDegree(degree, requestedDegreeReduction))
            : degree;
          return {
            result: storedResult,
            degreeBefore: degree,
            degreeAfter,
            degreeReduction: storedResult === "success" ? requestedDegreeReduction : 0
          };
        })();
    defense.result = resolved.result;
    defense.degreeBefore = resolved.degreeBefore;
    defense.degreeAfter = resolved.degreeAfter;
    defense.degreeReduction = resolved.degreeReduction;
    defense.requestedDegreeReduction = requestedDegreeReduction;
    degree = resolved.degreeAfter ?? degree;
    lastOutcome = resolved.result;
  }

  next.defendedDegree = degree;
  next.lastDefenseOutcome = lastOutcome;
  next.appliedDefenseHistory = chain;
  next.pendingDefenses = [];
  return next;
}

export function applyPendingMultiTargetDefenses(target = {}) {
  // Compatibility alias for 0.5.61 cards. In 0.5.62 every defense step is
  // applied immediately inside its target row, so pending entries are simply
  // folded into the chronological chain and recalculated.
  return recalculateMultiTargetDefenseChain(target);
}

function multiTargetDegreeLabel(target) {
  const finalDegree = multiTargetFinalDegree(target);
  return finalDegree ? (DEGREE_LABELS[finalDegree] ?? finalDegree) : "Не определена";
}

function multiTargetManualMarker(target) {
  return MULTI_TARGET_DEGREE_ORDER.includes(target?.manualDegree)
    ? `<small class="fast-nri-multitarget-manual">вручную</small>`
    : "";
}

function multiTargetRowsHTML(state, actionContext) {
  const allowDefense = ["counteraction", "dodge"].some(procedure => actionHasDefenseProcedure(actionContext, procedure));
  const targetLabel = checkTargetCharacteristicLabel(state?.targetCharacteristic);
  return Array.from(state?.targets ?? []).map(target => {
    const defenseChain = multiTargetDefenseChain(target);
    return `
      <div class="fast-nri-multitarget-row" data-target-uuid="${escAttr(target.tokenUuid ?? "")}">
        <div class="fast-nri-multitarget-target">
          <strong>${esc(target.name)}</strong>
          ${Number.isFinite(target.defenseValue) ? `<small>${esc(targetLabel)} ${esc(target.defenseValue)}</small>` : ""}
        </div>
        <div class="fast-nri-multitarget-degree">
          <span>${esc(multiTargetDegreeLabel(target))}</span>
          ${multiTargetManualMarker(target)}
        </div>
        <div class="fast-nri-multitarget-row-actions">
          ${allowDefense ? `<button type="button" class="fast-nri-multitarget-defense-button" data-fast-nri-multitarget-defense data-target-uuid="${escAttr(target.tokenUuid ?? "")}" title="Бросить Защиту этой цели"><i class="fa-solid fa-shield-halved"></i><span>Защита</span></button>` : ""}
          <button type="button" class="fast-nri-multitarget-menu-button" data-fast-nri-multitarget-degree-menu data-target-uuid="${escAttr(target.tokenUuid ?? "")}" title="Вручную изменить итоговую степень"><i class="fa-solid fa-ellipsis"></i></button>
          <button type="button" class="fast-nri-multitarget-remove-button" data-fast-nri-multitarget-remove-target data-target-uuid="${escAttr(target.tokenUuid ?? "")}" title="Убрать цель из этой карточки"><i class="fa-solid fa-xmark"></i></button>
        </div>
        ${defenseChain.length ? `<div class="fast-nri-multitarget-defense-history"><div class="fast-nri-defense-chain-label">Цепочка Защит</div>${defenseHistoryHTML(defenseChain, { controls: true, targetUuid: target.tokenUuid })}</div>` : ""}
      </div>
    `;
  }).join("");
}

function multiTargetAbilityCardHTML({ item, runtime, state, sharedDamageState = null, modifiersHTML = "", actionContext }) {
  const targetLabel = checkTargetCharacteristicLabel(state?.targetCharacteristic);
  const targetCount = Array.from(state?.targets ?? []).length;
  return `
    <div class="fast-nri-chat-roll fast-nri-ability-multitarget-card">
      ${rollCardHeader(`${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`, "fa-wand-magic-sparkles")}
      <div class="fast-nri-attack-summary">
        <span>Общий результат: <strong>${esc(state.checkTotal)}</strong></span>
        <span>Против: <strong>${esc(targetLabel)}</strong></span>
        <span>Целей: <strong>${esc(targetCount)}</strong></span>
      </div>
      ${state.naturalD20 === 20 && state.targetCharacteristic === "armor" ? `<div class="fast-nri-critical-roll"><i class="fa-solid fa-burst"></i><strong>Натуральная 20 · критический урон после Защит</strong></div>` : ""}
      ${sharedDamageState?.supported ? damagePartsHTML(sharedDamageState, { editable: false, title: "Общий пул урона" }) : ""}
      <section class="fast-nri-multitarget-section">
        <div class="fast-nri-multitarget-heading"><strong>Цели и итоговые степени</strong><small>Степень считается независимо для каждой цели.</small></div>
        <div class="fast-nri-multitarget-list">
          ${multiTargetRowsHTML(state, actionContext) || `<div class="fast-nri-roll-empty">Цели пока не добавлены.</div>`}
        </div>
      </section>
      <div class="fast-nri-multitarget-target-actions">
        <button type="button" data-fast-nri-multitarget-add-targets title="Добавить текущие Foundry Targets"><i class="fa-solid fa-crosshairs"></i><span>Добавить цели</span></button>
        <button type="button" data-fast-nri-multitarget-add-controlled title="Добавить текущие выделенные токены"><i class="fa-solid fa-object-group"></i><span>Добавить выделенное</span></button>
      </div>
      <div class="fast-nri-multitarget-main-actions">
        <button type="button" data-fast-nri-multitarget-apply-results ${targetCount ? "" : "disabled"}><i class="fa-solid fa-burst"></i><span>Применить результаты</span></button>
      </div>
      ${state.lastResultsAppliedAt ? `<small class="fast-nri-multitarget-applied-note">Результаты уже создавались. Повторное применение разрешено после ручной проверки степеней.</small>` : ""}
      ${modifiersHTML}
    </div>
  `;
}

async function prepareSharedAreaDamage(actor, item, runtime, plan) {
  if (!plan?.components?.length) return { result: null, state: null, modifiersHTML: "" };
  const formula = flavoredDamageFormula(plan.components);
  const displayFormula = plainDamageFormula(plan.components);
  const result = await prepareRoll({
    actor,
    label: `Общий урон: ${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`,
    baseFormula: formula,
    baseSources: [{
      formula: displayFormula,
      label: runtime?.implementationName ? `${item.name} — ${runtime.implementationName}` : item.name,
      reason: "Общий пул урона многоцелевого действия"
    }],
    showDC: false
  });
  if (!result) return null;
  let state = buildDamageState(result.roll, {
    components: plan.components,
    damageType: plan.components[0]?.damageType ?? "physical",
    traitIds: plan.components[0]?.traitIds ?? []
  });
  state.originalEffectDegree = null;
  state.effectDegree = null;
  state = recalculateDamageState(state);
  return { result, state, modifiersHTML: rollSourcesHTML(result) };
}

async function updateMultiTargetMessage(message, { state = null, actionContext = null } = {}) {
  if (!message) return null;
  const nextState = state ?? foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const nextContext = actionContext ?? actionContextFromMessage(message);
  const actor = message.getFlag("fast-nri", "actorUuid") ? await fromUuid(message.getFlag("fast-nri", "actorUuid")) : null;
  const item = message.getFlag("fast-nri", "itemUuid") ? await fromUuid(message.getFlag("fast-nri", "itemUuid")) : null;
  if (!item || item.type !== "ability") return null;
  const runtime = abilityImplementationRuntime(item, message.getFlag("fast-nri", "implementationId") ?? null);
  const sharedDamageState = message.getFlag("fast-nri", "sharedDamageState") ?? null;
  const modifiersHTML = message.getFlag("fast-nri", "sharedDamageModifiersHTML") ?? "";
  const content = multiTargetAbilityCardHTML({ item, runtime, state: nextState, sharedDamageState, modifiersHTML, actionContext: nextContext });
  await message.update({
    flavor: content,
    "flags.fast-nri.multiTargetState": nextState,
    "flags.fast-nri.actionContext": nextContext
  });
  return { message, actor, item, runtime, state: nextState, actionContext: nextContext };
}

async function chooseManualMultiTargetDegree(target) {
  const { DialogV2 } = foundry.applications.api;
  const buttons = MULTI_TARGET_DEGREE_ORDER.map(degree => ({
    action: degree,
    label: DEGREE_LABELS[degree],
    callback: async () => degree
  }));
  buttons.push({ action: "auto", label: "Вернуть автоматическую степень", icon: "fa-solid fa-rotate-left", callback: async () => "__auto__" });
  buttons.push({ action: "cancel", label: "Отмена", icon: "fa-solid fa-xmark", callback: async () => null });
  return DialogV2.wait({
    window: { title: `Итоговая степень: ${target?.name ?? "цель"}` },
    content: `<div class="fast-nri-defense-choice"><p>Ручная степень перекрывает автоматический расчёт и все применённые Защиты для этой цели.</p></div>`,
    modal: true,
    rejectClose: false,
    buttons
  });
}

async function tokenPlaceableFromUuid(uuid) {
  if (!uuid) return null;
  const doc = await fromUuid(uuid);
  return doc?.object ?? doc ?? null;
}

export async function multiTargetDegreeMenuFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const target = Array.from(state.targets ?? []).find(entry => entry.tokenUuid === element?.dataset?.targetUuid);
  if (!target) return null;
  const selected = await chooseManualMultiTargetDegree(target);
  if (selected == null) return null;
  target.manualDegree = selected === "__auto__"
    ? null
    : MULTI_TARGET_DEGREE_ORDER.includes(selected) ? selected : target.manualDegree;
  return updateMultiTargetMessage(message, { state });
}

export async function multiTargetRemoveTargetFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const targetUuid = element?.dataset?.targetUuid;
  state.targets = Array.from(state.targets ?? []).filter(entry => entry.tokenUuid !== targetUuid);
  const context = actionContextFromMessage(message);
  const targetTokens = [];
  for (const entry of state.targets) {
    const token = await tokenPlaceableFromUuid(entry.tokenUuid);
    if (token) targetTokens.push(token);
  }
  const nextContext = deriveActionContext(context, { targets: targetTokens });
  return updateMultiTargetMessage(message, { state, actionContext: nextContext });
}

export async function multiTargetAddTargetsFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const sourceActor = message.getFlag("fast-nri", "actorUuid") ? await fromUuid(message.getFlag("fast-nri", "actorUuid")) : null;
  const rollStub = { roll: { total: state.checkTotal }, naturalD20: state.naturalD20 };
  const existing = new Set(Array.from(state.targets ?? []).map(entry => entry.tokenUuid));
  for (const token of Array.from(game.user?.targets ?? [])) {
    const uuid = tokenDocumentUuid(token);
    if (!uuid || existing.has(uuid)) continue;
    const entry = multiTargetEntryForToken(token, {
      result: rollStub,
      targetCharacteristic: state.targetCharacteristic,
      sourceActor
    });
    if (entry) {
      state.targets.push(entry);
      existing.add(uuid);
    }
  }
  const context = actionContextFromMessage(message);
  const targetTokens = [];
  for (const entry of state.targets ?? []) {
    const token = await tokenPlaceableFromUuid(entry.tokenUuid);
    if (token) targetTokens.push(token);
  }
  const nextContext = deriveActionContext(context, { targets: targetTokens });
  return updateMultiTargetMessage(message, { state, actionContext: nextContext });
}

export async function multiTargetAddControlledFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const sourceActor = message.getFlag("fast-nri", "actorUuid") ? await fromUuid(message.getFlag("fast-nri", "actorUuid")) : null;
  const rollStub = { roll: { total: state.checkTotal }, naturalD20: state.naturalD20 };
  const existing = new Set(Array.from(state.targets ?? []).map(entry => entry.tokenUuid));
  for (const token of Array.from(canvas?.tokens?.controlled ?? [])) {
    const uuid = tokenDocumentUuid(token);
    if (!uuid || existing.has(uuid)) continue;
    const entry = multiTargetEntryForToken(token, {
      result: rollStub,
      targetCharacteristic: state.targetCharacteristic,
      sourceActor
    });
    if (entry) {
      state.targets.push(entry);
      existing.add(uuid);
    }
  }
  const context = actionContextFromMessage(message);
  const targetTokens = [];
  for (const entry of state.targets ?? []) {
    const token = await tokenPlaceableFromUuid(entry.tokenUuid);
    if (token) targetTokens.push(token);
  }
  const nextContext = deriveActionContext(context, { targets: targetTokens });
  return updateMultiTargetMessage(message, { state, actionContext: nextContext });
}

export async function multiTargetApplyDefensesFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  state.targets = Array.from(state.targets ?? []).map(target => applyPendingMultiTargetDefenses(target));
  return updateMultiTargetMessage(message, { state });
}

export async function multiTargetDefenseFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const actionContext = actionContextFromMessage(message);
  if (!actionContext) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const target = Array.from(state.targets ?? []).find(entry => entry.tokenUuid === element?.dataset?.targetUuid);
  if (!target) return null;
  const protectedToken = await tokenPlaceableFromUuid(target.tokenUuid);
  if (!protectedToken?.actor) {
    ui.notifications.error("Не удалось найти токен цели для Защиты.");
    return null;
  }
  const defenderToken = controlledSingleDefenderToken();
  if (!defenderToken?.actor) return null;
  const defender = defenderToken.actor;
  const role = sameTokenOrActor(defenderToken, protectedToken) ? "self" : "ally";
  const procedures = ["counteraction", "dodge"].filter(procedure => actionHasDefenseProcedure(actionContext, procedure));
  if (!procedures.length) {
    ui.notifications.info("Для этой многоцелевой проверки нет доступной стандартной Защиты.");
    return null;
  }
  const defenseHistory = [
    ...(target.appliedDefenseHistory ?? []),
    ...(target.pendingDefenses ?? [])
  ];
  const method = await chooseDefenseMethod({
    actor: defender,
    defenderToken,
    protectedToken,
    role,
    defenseHistory,
    actionContext,
    procedures
  });
  if (!method) return null;
  if (!enforceDefenseMethodHardBlock(actionContext, method)) return null;
  if (method.warnings.length) ui.notifications.warn(`${method.actionName}: ${method.warnings.join("; ")}.`);

  const procedure = method.procedure;
  const characteristic = procedure === "dodge"
    ? "reflex"
    : normalizeCheckTargetCharacteristic(state.targetCharacteristic);
  if (!characteristic || characteristic === "armor") {
    ui.notifications.error("Не удалось определить характеристику Защиты.");
    return null;
  }
  let dodgeMovement = null;
  if (procedure === "dodge") {
    dodgeMovement = await chooseDodgeMovement(method.actionName);
    if (!dodgeMovement) return null;
  }
  const sourceActor = message.getFlag("fast-nri", "actorUuid") ? await fromUuid(message.getFlag("fast-nri", "actorUuid")) : null;
  const sourceItem = message.getFlag("fast-nri", "itemUuid") ? await fromUuid(message.getFlag("fast-nri", "itemUuid")) : null;
  const characteristicState = effectiveDefenseCharacteristicForAction(defenderToken, characteristic, sourceActor);
  const characteristicValue = finiteNumberOrNull(characteristicState.value);
  if (characteristicValue === null) {
    ui.notifications.error(`У цели нет корректного значения «${checkTargetCharacteristicLabel(characteristic)}».`);
    return null;
  }
  const combatSource = defenseCombatTerm(defender, method.item, role);
  const baseFormula = combatSource?.formula
    ? `1d20 + ${characteristicValue} + ${combatSource.formula}`
    : `1d20 + ${characteristicValue}`;
  const selectedClassResourceCost = await chooseDefenseClassResourceCost(defender, method.item);
  if (selectedClassResourceCost === null) return null;
  const contextualModifiers = selfDefenseContextualModifiers(defender, sourceItem, multiTargetFinalDegree(target))
    .filter(modifier => modifier.id !== "weapon-deadly");
  const result = await prepareRoll({
    actor: defender,
    label: `${method.actionName}: ${defenderToken.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: method.actionName },
      { formula: String(characteristicValue), label: checkTargetCharacteristicLabel(characteristic), reason: defender.name },
      ...(combatSource ? [combatSource] : [])
    ],
    showDC: false,
    additionalModifiers: contextualModifiers
  });
  if (!result) return null;
  await showInPlaceRollDice(result.roll);
  const attackTotal = finiteNumberOrNull(state.checkTotal);
  if (attackTotal === null) return null;
  let degreeReduction = Math.max(1, Number(method.config.effectDegreeReduction) || 1);
  const preliminarySuccess = result.naturalD20 === 20 || (result.naturalD20 !== 1 && result.roll.total >= attackTotal);
  if (procedure === "dodge" && preliminarySuccess && result.naturalD20 !== 20 && multiTargetFinalDegree(target)) {
    degreeReduction = Number(await chooseDodgeDegreeReduction(method.actionName)) || 1;
  }
  const resolved = resolveCheckDefenseResult({
    degreeBefore: multiTargetFinalDegree(target),
    defenseTotal: result.roll.total,
    attackTotal,
    naturalD20: result.naturalD20,
    degreeReduction
  });
  result.resolvedResult = resolved.result;
  const resource = await spendDefenseClassResource(defender, method.item, selectedClassResourceCost);
  const defenseActionContext = actionContextForDefenseAction(actionContext, {
    actor: defender,
    item: method.item,
    defenderToken,
    protectedToken,
    actionName: method.actionName,
    procedure,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    parentMessageId: message.id
  });
  const defenseEntry = {
    id: resolutionEntryId("defense"),
    kind: "multi-target-check-defense",
    procedure,
    actionName: method.actionName,
    abilityUuid: method.item?.uuid ?? null,
    actorUuid: defender.uuid,
    role,
    defenderTokenUuid: tokenDocumentUuid(defenderToken),
    defenderTokenName: defenderToken.name || defender.name,
    protectedTokenUuid: tokenDocumentUuid(protectedToken),
    protectedActorUuid: protectedToken.actor?.uuid ?? null,
    protectedTokenName: protectedToken.name || protectedToken.actor?.name || target.name,
    characteristic,
    formula: result.formula,
    attackTotal,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    result: resolved.result,
    degreeBefore: multiTargetFinalDegree(target),
    degreeAfter: resolved.degreeAfter,
    degreeReduction: resolved.degreeReduction || degreeReduction,
    requestedDegreeReduction: degreeReduction,
    dodgeMovement,
    interventionCost: Math.max(0, Number(method.config.interventionCost) || 0),
    resource: foundry.utils.deepClone(resource),
    resourceUndone: false,
    sourcesHTML: rollSourcesHTML(result),
    actionContext: defenseActionContext
  };
  target.appliedDefenseHistory = [
    ...(target.appliedDefenseHistory ?? []),
    ...(target.pendingDefenses ?? []),
    defenseEntry
  ];
  target.pendingDefenses = [];
  Object.assign(target, recalculateMultiTargetDefenseChain(target));

  await updateMultiTargetMessage(message, { state });
  return { message, defenseMessage: null, defense: defenseEntry, roll: result.roll };
}

function multiTargetDefenseStep(state, targetUuid, defenseId) {
  const target = Array.from(state?.targets ?? []).find(entry => entry?.tokenUuid === targetUuid) ?? null;
  if (!target) return { target: null, defense: null };
  const defense = multiTargetDefenseChain(target).find(entry => entry?.id === defenseId) ?? null;
  return { target, defense };
}

async function restoreDefenseStepResource(defense) {
  if (!defense || defense.resourceUndone) return null;
  const resource = defense.resource ?? {};
  const spent = Math.max(0, Number(resource.spent) || 0);
  if (!(spent > 0)) {
    defense.resourceUndone = true;
    return null;
  }
  const actorUuid = defense.actorUuid ?? defense.defenderActorUuid ?? null;
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  if (!actor) {
    ui.notifications.warn("Не удалось автоматически вернуть классовый ресурс отменённой Защиты.");
    return null;
  }
  const current = Math.max(0, Number(actor.system?.classResource?.value) || 0);
  const restored = current + spent;
  await actor.update({ "system.classResource.value": restored });
  defense.resourceUndone = true;
  defense.resourceRestoredTo = restored;
  return { actor, restored, restoredAmount: spent };
}

export async function multiTargetDefenseStepUndoFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const targetUuid = String(element?.dataset?.targetUuid ?? "").trim();
  const defenseId = String(element?.dataset?.defenseId ?? "").trim();
  if (!targetUuid || !defenseId) return null;

  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const { target, defense } = multiTargetDefenseStep(state, targetUuid, defenseId);
  if (!target || !defense) {
    ui.notifications.error("Не удалось найти этот шаг Защиты в строке цели.");
    return null;
  }
  if (defense.status === "undone" || defense.undone === true) return null;

  await restoreDefenseStepResource(defense);
  defense.status = "undone";
  defense.undone = true;
  defense.undoneAt = Date.now();
  Object.assign(target, recalculateMultiTargetDefenseChain(target));
  await updateMultiTargetMessage(message, { state });
  return { message, target, defense };
}

export async function multiTargetDefenseStepRerollFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const targetUuid = String(element?.dataset?.targetUuid ?? "").trim();
  const defenseId = String(element?.dataset?.defenseId ?? "").trim();
  if (!targetUuid || !defenseId) return null;

  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  const { target, defense } = multiTargetDefenseStep(state, targetUuid, defenseId);
  if (!target || !defense) {
    ui.notifications.error("Не удалось найти этот шаг Защиты в строке цели.");
    return null;
  }
  if (defense.status === "undone" || defense.undone === true) {
    ui.notifications.info("Отменённую Защиту сначала нельзя перебрасывать: выполните новую Защиту этой цели.");
    return null;
  }
  const formula = String(defense.formula ?? "").trim();
  if (!formula) {
    ui.notifications.error("Для этой Защиты не сохранена формула переброса.");
    return null;
  }

  let roll;
  try {
    roll = await new Roll(formula).evaluate();
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка переброса шага Защиты", error);
    ui.notifications.error(`Некорректная сохранённая формула Защиты: ${formula}`);
    return null;
  }
  await showInPlaceRollDice(roll);
  defense.previousRolls = [
    ...(defense.previousRolls ?? []),
    { total: defense.total, naturalD20: defense.naturalD20, rerolledAt: Date.now() }
  ];
  defense.total = roll.total;
  defense.naturalD20 = getNaturalD20(roll);
  defense.rerollCount = Math.max(0, Number(defense.rerollCount) || 0) + 1;
  Object.assign(target, recalculateMultiTargetDefenseChain(target));
  await updateMultiTargetMessage(message, { state });
  return { message, target, defense, roll };
}

async function multiTargetResultContent({ item, runtime, target, degree, damageState = null, critical = false, profileHTML = "", hasApplicationEffects = false }) {
  const targetHeader = `<section class="fast-nri-multitarget-result-target"><strong>${esc(target.name)}</strong><span>Итоговая степень: <strong>${esc(DEGREE_LABELS[degree] ?? degree)}</strong></span></section>`;
  if (damageState?.supported) {
    const damageHTML = damageCardHTML({
      sourceName: item.name,
      profileLabel: `${abilityIsSpell(runtime) ? "Заклинание" : "Способность"} · ${DEGREE_LABELS[degree] ?? degree}`,
      targetName: target.name,
      critical,
      state: damageState,
      modifiersHTML: "",
      hasApplicationEffects,
      allowDefense: false,
      allowDouble: Boolean(critical)
    });
    return `<div class="fast-nri-multitarget-result-card">${damageHTML}${profileHTML}</div>`;
  }
  return `<div class="fast-nri-chat-roll fast-nri-multitarget-result-card fast-nri-result-application-card">${rollCardHeader(`Результат: ${item.name}`, "fa-wand-magic-sparkles")}${targetHeader}${profileHTML || `<div class="fast-nri-roll-empty">Для этой степени нет автоматического урона или Effect.</div>`}<div class="fast-nri-damage-actions"><button type="button" class="fast-nri-apply-damage-button" data-fast-nri-apply-result><i class="fa-solid fa-check"></i><span>Применить к выделенным</span></button></div></div>`;
}

export async function multiTargetApplyResultsFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== MULTI_TARGET_ABILITY_KIND) return null;
  const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
  state.targets = Array.from(state.targets ?? []).map(target => recalculateMultiTargetDefenseChain(target));
  const actor = message.getFlag("fast-nri", "actorUuid") ? await fromUuid(message.getFlag("fast-nri", "actorUuid")) : null;
  const item = message.getFlag("fast-nri", "itemUuid") ? await fromUuid(message.getFlag("fast-nri", "itemUuid")) : null;
  if (!actor || !item || item.type !== "ability") return null;
  const runtime = abilityImplementationRuntime(item, message.getFlag("fast-nri", "implementationId") ?? null);
  const sharedDamageState = message.getFlag("fast-nri", "sharedDamageState") ?? null;
  const baseContext = actionContextFromMessage(message);
  const created = [];
  for (const target of Array.from(state.targets ?? [])) {
    const degree = multiTargetFinalDegree(target);
    if (!degree) {
      ui.notifications.warn(`${target.name}: итоговая степень не определена; результат не создан.`);
      continue;
    }
    const token = await tokenPlaceableFromUuid(target.tokenUuid);
    const targetContext = deriveActionContext(baseContext, {
      targets: token ? [token] : [],
      check: { ...baseContext.check, degree },
      parentMessageId: message.id
    });
    let damageState = null;
    const damageChannel = abilityOutcomeChannel(runtime, "damage", degree);
    if (sharedDamageState?.supported && damageChannel?.enabled) {
      damageState = foundry.utils.deepClone(sharedDamageState);
      damageState = applyAbilityProfileDamageTransform(damageState, damageChannel);
      damageState.originalEffectDegree = degree;
      damageState.effectDegree = degree;
      damageState = recalculateDamageState(damageState);
    }
    const profileHTML = await enrichAbilityProfileHTML(runtime, degree);
    const applicationEffects = await abilityApplicationEffects(runtime, degree);
    const content = await multiTargetResultContent({
      item,
      runtime,
      target,
      degree,
      damageState,
      critical: Boolean(state.critical),
      profileHTML,
      hasApplicationEffects: applicationEffects.uuids.length > 0
    });
    const flags = {
      kind: damageState?.supported ? "damage" : "ability-result",
      actorUuid: actor.uuid,
      itemUuid: item.uuid,
      implementationId: runtime?.implementationId ?? null,
      abilityOutcome: true,
      outcomeKind: damageState?.supported ? "damage" : "effect",
      targetUuid: target.tokenUuid,
      resultTargetUuid: target.tokenUuid,
      resultTargetName: target.name,
      degree,
      attackDegree: degree,
      automaticAttackDegree: target.baseDegree,
      critical: Boolean(state.critical),
      targetCharacteristic: state.targetCharacteristic,
      actionTraits: targetContext.traits,
      actionContext: targetContext,
      applicationPhase: "final",
      applicationEffectUuids: applicationEffects.uuids,
      sourceAttackMessageId: message.id,
      area: true,
      directedDefense: false,
      damageCardMeta: damageState?.supported ? {
        sourceName: item.name,
        profileLabel: `${abilityIsSpell(runtime) ? "Заклинание" : "Способность"} · ${DEGREE_LABELS[degree] ?? degree}`,
        targetName: target.name,
        allowDefense: false,
        allowDouble: Boolean(state.critical)
      } : null,
      damageRevision: 0,
      rolledTotal: damageState?.originalRollTotal ?? null,
      finalTotal: damageState?.currentTotal ?? null,
      damageState
    };
    const resultMessage = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content,
      flags: { "fast-nri": flags }
    });
    created.push(resultMessage);
  }

  state.lastResultsAppliedAt = Date.now();
  state.lastResultsMessageIds = created.map(entry => entry?.id).filter(Boolean);
  await updateMultiTargetMessage(message, { state });
  return created;
}

export async function rollAbilityCheck(actor, item, { actionContext: inheritedActionContext = null, parentMessageId = null, implementationId = null, repeatIndex = 0, declaredTargets = null } = {}) {
  if (!actor || !item || item.type !== "ability") return null;

  const runtime = abilityImplementationRuntime(item, implementationId);
  const config = abilityCheckConfig(runtime);
  if (!config.enabled) return null;
  const parentMessage = parentMessageId ? globalThis.game?.messages?.get?.(parentMessageId) ?? null : null;
  const periodicRemovalEffectUuid = parentMessage?.getFlag("fast-nri", "periodicRemovalEffectUuid") ?? null;
  const periodicRemovalSourceTickMessageId = parentMessage?.getFlag("fast-nri", "periodicRemovalSourceTickMessageId") ?? null;

  const targetCharacteristic = normalizeCheckTargetCharacteristic(config.targetCharacteristic) || "armor";
  const actionTraits = abilityActionTraits(runtime);
  const attackType = directedAttackTypeFromTraits(actionTraits);
  const baseActionContext = actionContextFromAbility(actor, item, {
    originActionContext: inheritedActionContext,
    implementationId: runtime?.implementationId ?? implementationId
  });
  const structureWarnings = checkStructureWarnings({
    targetCharacteristic,
    traits: actionTraits
  });

  if (structureWarnings.length) {
    ui.notifications.warn(`${item.name}: ${structureWarnings.join("; ")}.`);
  }

  // Standard Directed Defense is a consequence of a directed non-area KZ
  // attack. Other checks may later expose their own counteraction procedure,
  // but must not accidentally inherit Self Defense from the legacy attack card.
  const directedDefense = actionHasDefenseProcedure(baseActionContext, "directed");

  if (config.directedDefense && !directedDefense) {
    ui.notifications.warn(
      `${item.name}: стандартная Направленная защита доступна только для направленной ` +
      `Атаки против КЗ без Области действия и с ровно одним признаком Ближняя/Дистанционная.`
    );
  }

  const rawFormula = String(config.formula ?? "1d20 + {combatDie}");
  const formula = expandAbilityCheckFormula(actor, rawFormula);
  const requestedMultiTarget = multiTargetAbilityEligible(runtime, actionTraits);
  const sharedDamagePlan = requestedMultiTarget ? sharedAreaDamagePlan(actor, runtime) : null;
  const multiTargetWorkflow = Boolean(requestedMultiTarget && sharedDamagePlan?.compatible !== false);
  if (requestedMultiTarget && sharedDamagePlan?.compatible === false) {
    ui.notifications.warn(`${item.name}: ${sharedDamagePlan.reason} Используется старый пошаговый результат.`);
  }

  const explicitDeclaredTargets = Array.isArray(declaredTargets);
  const declaredTargetTokens = [];
  if (explicitDeclaredTargets) {
    for (const ref of declaredTargets) {
      const token = await tokenPlaceableFromUuid(ref?.tokenUuid ?? null);
      if (token?.actor) declaredTargetTokens.push(token);
    }
  }

  const target = multiTargetWorkflow
    ? null
    : explicitDeclaredTargets
      ? (declaredTargetTokens[0] ?? null)
      : getSingleTarget();
  const previewTarget = resolveAbilityCheckTarget(target, targetCharacteristic, actor);

  const directedTargetCount = explicitDeclaredTargets
    ? declaredTargetTokens.length
    : (game.user?.targets?.size ?? 0);
  if (!multiTargetWorkflow && directedTargetCount > 1) {
    ui.notifications.warn(
      "Для направленной проверки в списке несколько существ. Для расчёта степени используется первое; список можно исправить в первой карточке."
    );
  }

  const targetLabel = checkTargetCharacteristicLabel(targetCharacteristic);
  const result = await prepareRoll({
    actor,
    label: `Проверка: ${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`,
    baseFormula: formula,
    baseSources: abilityCheckFormulaSources(actor, rawFormula, formula, targetCharacteristic),
    showDC: false,
    contextHTML: checkContextHTML(target, targetCharacteristic, previewTarget)
  });

  if (!result) return null;

  if (multiTargetWorkflow) {
    const sharedDamage = await prepareSharedAreaDamage(actor, item, runtime, sharedDamagePlan);
    if (sharedDamage === null) return null;

    // Если Check запущен из первой карточки реализации, её видимый список
    // существ является явным входом Resolution. Прямые/legacy вызовы без
    // такого списка сохраняют прежний fallback на текущие Foundry Targets.
    const selectedTargets = explicitDeclaredTargets
      ? declaredTargetTokens
      : Array.from(game.user?.targets ?? []);
    const targetEntries = selectedTargets
      .map(token => multiTargetEntryForToken(token, { result, targetCharacteristic, sourceActor: actor }))
      .filter(Boolean);
    const critical = targetCharacteristic === "armor" && result.naturalD20 === 20;
    const actionContext = deriveActionContext(baseActionContext, {
      targets: selectedTargets,
      check: {
        ...baseActionContext.check,
        formula: result.formula,
        total: result.roll.total,
        naturalD20: result.naturalD20,
        degree: null,
        critical
      },
      parentMessageId
    });
    const multiTargetState = {
      version: 1,
      targetCharacteristic,
      checkTotal: result.roll.total,
      naturalD20: result.naturalD20,
      critical,
      targets: targetEntries,
      lastResultsAppliedAt: null,
      lastResultsMessageIds: []
    };
    const sourcesHTML = `${rollSourcesHTML(result)}${sharedDamage?.modifiersHTML ?? ""}`;
    const flavor = multiTargetAbilityCardHTML({
      item,
      runtime,
      state: multiTargetState,
      sharedDamageState: sharedDamage?.state ?? null,
      modifiersHTML: sourcesHTML,
      actionContext
    });
    const message = await result.roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor,
      flags: {
        "fast-nri": {
          kind: MULTI_TARGET_ABILITY_KIND,
          actorUuid: actor.uuid,
          itemUuid: item.uuid,
          implementationId: runtime?.implementationId ?? implementationId ?? null,
          repeatIndex,
          critical,
          rollTotal: result.roll.total,
          naturalD20: result.naturalD20,
          targetCharacteristic,
          actionTraits,
          actionContext,
          attackType,
          area: true,
          multiTargetState,
          sharedDamageState: sharedDamage?.state ?? null,
          sharedDamageModifiersHTML: sourcesHTML,
          sharedDamageFormula: sharedDamage?.result?.formula ?? null,
          sharedDamageRollTotal: sharedDamage?.result?.roll?.total ?? null
        }
      }
    });
    return {
      message,
      roll: result.roll,
      total: result.roll.total,
      naturalD20: result.naturalD20,
      degree: null,
      critical,
      targetUuid: null,
      targetCharacteristic,
      actionTraits,
      actionContext,
      implementationId: runtime?.implementationId ?? implementationId ?? null,
      repeatIndex,
      directedDefense: false,
      attackType,
      multiTarget: true
    };
  }

  // Resolve from the latest Scene state after the pre-roll dialog closes.
  const resolvedTarget = resolveAbilityCheckTarget(target, targetCharacteristic, actor);
  const targetState = resolvedTarget?.state ?? null;
  const degree = target?.actor
    ? degreeForAbilityCheck(result, targetCharacteristic, resolvedTarget)
    : null;

  // Natural 20 is a damage multiplier only for KZ Attacks. Against the four
  // defensive characteristics it is already handled by degreeVsDC as Great.
  const critical = targetCharacteristic === "armor" && result.naturalD20 === 20;
  const actionContext = actionContextWithCheckResult(baseActionContext, {
    target,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    degree,
    critical,
    formula: result.formula,
    parentMessageId
  });
  const traitsLabel = actionTraitsLabel(actionTraits);
  const profileHTML = await enrichAbilityProfileHTML(runtime, degree);

  const natural20HTML = result.naturalD20 === 20
    ? targetCharacteristic === "armor"
      ? `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-burst"></i>
          <strong>Натуральная 20 · урон ×2 после Защит</strong>
        </div>
      `
      : `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-burst"></i>
          <strong>Натуральная 20 · Большой успех</strong>
        </div>
      `
    : "";

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-attack-card fast-nri-ability-check-card">
      ${rollCardHeader(`Проверка: ${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`, "fa-wand-magic-sparkles")}
      <div class="fast-nri-attack-summary">
        <span>Результат: <strong>${esc(result.roll.total)}</strong></span>
        <span>Против: <strong>${esc(targetLabel)}</strong></span>
        ${target?.name ? `<span>Цель: <strong>${esc(target.name)}</strong></span>` : ""}
      </div>
      ${checkMetaHTML(target, targetCharacteristic, resolvedTarget)}
      ${natural20HTML}
      <div class="fast-nri-attack-type"><small>Признаки действия: <strong>${esc(traitsLabel)}</strong></small></div>
      ${degreeHTML(degree)}
      ${profileHTML}
      ${abilityCheckDefenseHTML(actionContext)}
      ${abilityAttackFollowupHTML(actor, item, degree, runtime?.implementationId ?? implementationId, repeatIndex)}
      ${rollSourcesHTML(result)}
    </div>
  `;

  const message = await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: "ability-check",
        actorUuid: actor.uuid,
        itemUuid: item.uuid,
        periodicRemovalEffectUuid,
        periodicRemovalSourceTickMessageId,
        implementationId: runtime?.implementationId ?? implementationId ?? null,
        repeatIndex,
        targetUuid: target?.document?.uuid ?? null,
        degree,
        critical,
        rollTotal: result.roll.total,
        naturalD20: result.naturalD20,
        targetCharacteristic,
        actionTraits,
        actionContext,
        defenseHistory: [],
        // Compatibility bridge for 0.5.51 damage/defense messages.
        attackType,
        area: Boolean(actionTraits.area),
        directedDefense,
        offGuard: Boolean(targetState?.offGuard),
        surrounded: Boolean(targetState?.surrounding?.surrounded),
        surroundingThreats: targetState?.surrounding?.threats ?? null,
        surroundingFormation: targetState?.surrounding?.formation ?? null,
        armorPenalty: targetState?.defensePenalty ?? 0
      }
    }
  });

  return {
    message,
    roll: result.roll,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    degree,
    critical,
    targetUuid: target?.document?.uuid ?? null,
    targetCharacteristic,
    actionTraits,
    actionContext,
    implementationId: runtime?.implementationId ?? implementationId ?? null,
    repeatIndex,
    directedDefense,
    attackType
  };
}

/** Compatibility alias for macros or modules written against <= 0.5.51. */
export async function rollAbilityAttackCheck(actor, item) {
  return rollAbilityCheck(actor, item);
}

export async function rollAbilityOutcome(actor, item, requestedKind = null, sourceAttack = null, sourceActionContext = null, implementationId = null, repeatIndex = 0, requestedDegree = null) {
  if (!actor || !item || item.type !== "ability") return null;

  const runtime = abilityImplementationRuntime(item, implementationId ?? sourceAttack?.implementationId ?? sourceActionContext?.source?.implementationId ?? null);
  let actionContext = normalizeActionContext(
    sourceAttack?.actionContext
      ?? sourceActionContext
      ?? actionContextFromAbility(actor, item, { implementationId: runtime?.implementationId ?? implementationId })
  );

  if (sourceAttack && !sourceAttack?.actionContext) {
    actionContext = actionContextWithCheckResult(actionContext, {
      total: sourceAttack.total,
      naturalD20: sourceAttack.naturalD20,
      degree: sourceAttack.degree,
      critical: Boolean(sourceAttack.critical),
      parentMessageId: sourceAttack?.message?.id ?? null
    });
  } else if (sourceAttack?.message?.id) {
    actionContext = deriveActionContext(actionContext, {
      parentMessageId: sourceAttack.message.id
    });
  }

  const fallbackKind = String(runtime.system?.outcome?.kind ?? "none");
  const kind = String(requestedKind ?? fallbackKind);

  if (!["damage", "healing", "tempHp", "application"].includes(kind)) {
    ui.notifications.info(`${item.name}: автоматический результат не настроен.`);
    return null;
  }

  const outcomeDegree = requestedDegree ?? sourceAttack?.degree ?? actionContext.check?.degree ?? null;
  const applicationEffects = await abilityApplicationEffects(runtime, outcomeDegree);
  if (kind === "application") {
    if (!applicationEffects.uuids.length) {
      ui.notifications.info(`${item.name}: для этой степени нет структурированных Effect.`);
      return null;
    }
    const profileHTML = await enrichAbilityProfileHTML(runtime, outcomeDegree);
    const flavor = effectOnlyApplicationCardHTML({
      sourceName: item.name,
      profileLabel: DEGREE_LABELS[outcomeDegree] ?? outcomeDegree ?? "",
      targetName: actionContext.targets?.[0]?.name ?? "",
      profileHTML,
      effectsHTML: applicationEffects.html
    });
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: flavor,
      flags: {
        "fast-nri": {
          kind: "application-result",
          actorUuid: actor.uuid,
          itemUuid: item.uuid,
          implementationId: runtime?.implementationId ?? implementationId ?? null,
          repeatIndex,
          degree: outcomeDegree,
          actionContext,
          applicationPhase: "final",
          applicationEffectUuids: applicationEffects.uuids,
          damageState: null
        }
      }
    });
  }

  const channel = abilityOutcomeChannel(runtime, kind, outcomeDegree);
  if (!channel.enabled) {
    ui.notifications.info(`${item.name}: этот результат не включён.`);
    return null;
  }

  const components = abilityOutcomeComponents(actor, runtime, kind, outcomeDegree);
  if (!components.length) {
    ui.notifications.warn(`${item.name}: добавь хотя бы один компонент результата.`);
    return null;
  }

  if (kind === "damage") {
    const formula = flavoredDamageFormula(components);
    const displayFormula = plainDamageFormula(components);
    const result = await prepareRoll({
      actor,
      label: `Урон: ${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`,
      baseFormula: formula,
      baseSources: [{
        formula: displayFormula,
        label: runtime?.implementationName ? `${item.name} — ${runtime.implementationName}` : item.name,
        reason: abilityIsSpell(runtime) ? "Урон заклинания" : "Урон способности"
      }],
      showDC: false
    });
    if (!result) return null;

    let state = buildDamageState(result.roll, {
      components,
      damageType: components[0]?.damageType ?? "physical",
      traitIds: components[0]?.traitIds ?? []
    });
    state = applyAbilityProfileDamageTransform(state, channel);

    // Если у способности была исходная Атака против КЗ, её степень
    // становится исходной степенью Эффекта для Направленной защиты.
    state.originalEffectDegree = sourceAttack?.degree ?? null;
    state.effectDegree = sourceAttack?.degree ?? null;
    state = recalculateDamageState(state);

    const modifiersHTML = rollSourcesHTML(result);
    const sourceTargetCharacteristic = actionContext.check.targetCharacteristic
      || normalizeCheckTargetCharacteristic(sourceAttack?.targetCharacteristic)
      || (sourceAttack ? "armor" : "");
    const sourceActionTraits = actionContext.traits;
    const sourceAttackType = directedAttackTypeFromActionContext(actionContext)
      || normalizeAttackType(sourceAttack?.attackType);
    const directedDefense = actionHasDefenseProcedure(actionContext, "directed");
    const allowDouble = Boolean(sourceAttack && sourceTargetCharacteristic === "armor");

    const flavor = damageCardHTML({
      sourceName: item.name,
      profileLabel: abilityIsSpell(runtime) ? "Заклинание" : "Способность",
      critical: Boolean(sourceAttack?.critical),
      state,
      modifiersHTML,
      applicationEffectsHTML: applicationEffects.html,
      allowDefense: directedDefense,
      allowDouble
    });

    return result.roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor,
      flags: {
        "fast-nri": {
          kind: "damage",
          actorUuid: actor.uuid,
          itemUuid: item.uuid,
          implementationId: runtime?.implementationId ?? implementationId ?? null,
          repeatIndex,
          abilityOutcome: true,
          outcomeKind: kind,
          critical: Boolean(sourceAttack?.critical),
          attackTotal: sourceAttack?.total ?? null,
          attackNaturalD20: sourceAttack?.naturalD20 ?? null,
          attackDegree: sourceAttack?.degree ?? null,
          automaticAttackDegree: sourceAttack?.automaticDegree ?? actionContext.check?.degree ?? sourceAttack?.degree ?? null,
          targetCharacteristic: sourceTargetCharacteristic || null,
          actionTraits: sourceActionTraits,
          actionContext,
          attackType: sourceAttackType,
          area: Boolean(sourceActionTraits.area),
          originalTargetUuid: sourceAttack?.targetUuid ?? null,
          sourceAttackMessageId: sourceAttack?.message?.id ?? null,
          directedDefense,
          damageCardMeta: {
            sourceName: item.name,
            profileLabel: abilityIsSpell(runtime) ? "Заклинание" : "Способность",
            allowDefense: directedDefense,
            allowDouble
          },
          damageRevision: 0,
          applicationPhase: "final",
          applicationEffectUuids: applicationEffects.uuids,
          rolledTotal: result.roll.total,
          finalTotal: state.currentTotal,
          modifierNotesHTML: modifiersHTML,
          damageState: state
        }
      }
    });
  }

  const formula = flavoredHpGainFormula(components);
  const displayFormula = plainHpGainFormula(components);
  const title = kind === "healing" ? "Восстановление HP" : "Временные HP";
  const result = await prepareRoll({
    actor,
    label: `${title}: ${item.name}${runtime?.implementationName ? ` — ${runtime.implementationName}` : ""}`,
    baseFormula: formula,
    baseSources: [{
      formula: displayFormula,
      label: runtime?.implementationName ? `${item.name} — ${runtime.implementationName}` : item.name,
      reason: "Получение HP"
    }],
    showDC: false
  });
  if (!result) return null;

  const state = buildHpGainState(result.roll, { components });
  const modifiersHTML = rollSourcesHTML(result);
  const flavor = hpGainRollCardHTML({ item, kind, state, modifiersHTML });

  return result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: kind === "healing" ? "healing" : "temp-hp",
        actorUuid: actor.uuid,
        itemUuid: item.uuid,
        implementationId: runtime?.implementationId ?? implementationId ?? null,
        repeatIndex,
        outcomeKind: kind,
        actionContext,
        hpGainState: state,
        rolledTotal: result.roll.total,
        modifierNotesHTML: modifiersHTML
      }
    }
  });
}

export async function rollDamageFromChat(element) {
  const actorUuid = element?.dataset?.actorUuid;
  const itemUuid = element?.dataset?.itemUuid;
  const profile = element?.dataset?.profile;
  const fallbackFormula = String(element?.dataset?.formula ?? "").trim();
  const critical = element?.dataset?.critical === "true";

  if (!actorUuid || !itemUuid) return;

  const actor = await fromUuid(actorUuid);
  const weapon = await fromUuid(itemUuid);

  if (!actor || !weapon) {
    ui.notifications.error("Не удалось найти персонажа или оружие для броска урона.");
    return;
  }

  const components = weaponDamageComponents(actor, weapon, profile);
  const formula = flavoredDamageFormula(components) || fallbackFormula || "0";
  const displayFormula = plainDamageFormula(components) || fallbackFormula || "0";

  const attackMessage = chatMessageFromElement(element);
  let actionContext = actionContextFromMessage(attackMessage)
    ?? actionContextFromWeapon(actor, weapon);
  const attackTotal = finiteNumberOrNull(
    attackMessage?.getFlag("fast-nri", "rollTotal")
    ?? attackMessage?.rolls?.[0]?.total
  );
  const attackNaturalD20 = finiteNumberOrNull(
    attackMessage?.getFlag("fast-nri", "naturalD20")
  );
  const automaticAttackDegree = attackMessage?.getFlag("fast-nri", "degree") ?? null;
  const confirmedAttackDegree = ["partial", "success", "great"].includes(profile)
    ? profile
    : automaticAttackDegree;
  const originalTargetUuid = actionContext.targets?.[0]?.tokenUuid
    ?? attackMessage?.getFlag("fast-nri", "targetUuid")
    ?? null;
  actionContext = deriveActionContext(actionContext, {
    check: {
      ...actionContext.check,
      total: attackTotal,
      naturalD20: attackNaturalD20,
      degree: confirmedAttackDegree,
      critical
    },
    parentMessageId: attackMessage?.id ?? null
  });
  const attackType = directedAttackTypeFromActionContext(actionContext)
    || normalizeAttackType(attackMessage?.getFlag("fast-nri", "attackType"))
    || inferWeaponAttackType(weapon);

  const labels = {
    partial: "Частичный",
    success: "Успех",
    great: "Большой"
  };

  const result = await prepareRoll({
    actor,
    label: `Урон: ${weapon.name} — ${labels[profile] ?? profile}`,
    baseFormula: formula,
    baseSources: [{ formula: displayFormula, label: `${weapon.name}: ${labels[profile] ?? profile}`, reason: "Профиль урона" }],
    showDC: false,
    contextHTML: critical ? `
      <section class="fast-nri-roll-context fast-nri-roll-context-critical">
        <i class="fa-solid fa-burst"></i>
        <div>
          <strong>Критический бросок атаки</strong>
          <small>В карточке урона будут отдельные кнопки обычного урона и ×2.</small>
        </div>
      </section>
    ` : ""
  });

  if (!result) return null;

  let damageState = buildDamageState(result.roll, {
    components,
    damageType: weapon.system?.damageType || "physical",
    traitIds: componentTraitIds({ traitIds: [] }, weapon, actor)
  });

  // Нажатый профиль является явным подтверждением игроком исходной
  // степени для этого Damage workflow. Это сохраняет работу защиты,
  // даже если target исходной атаки отсутствовал или был выбран ошибочно.
  damageState.originalEffectDegree = confirmedAttackDegree;
  damageState.effectDegree = confirmedAttackDegree;
  damageState = recalculateDamageState(damageState);

  const modifiersHTML = rollSourcesHTML(result);
  const allowDefense = actionHasDefenseProcedure(actionContext, "directed");
  const allowDouble = true;

  const flavor = damageCardHTML({
    weaponName: weapon.name,
    profileLabel: labels[profile] ?? profile,
    critical,
    state: damageState,
    modifiersHTML,
    allowDefense,
    allowDouble
  });

  const message = await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: "damage",
        actorUuid: actor.uuid,
        itemUuid: weapon.uuid,
        profile,
        critical,
        attackTotal,
        attackNaturalD20,
        attackDegree: confirmedAttackDegree,
        automaticAttackDegree,
        attackType,
        targetCharacteristic: actionContext.check.targetCharacteristic,
        actionTraits: actionContext.traits,
        actionContext,
        originalTargetUuid,
        sourceAttackMessageId: attackMessage?.id ?? null,
        damageCardMeta: {
          sourceName: weapon.name,
          profileLabel: labels[profile] ?? profile,
          allowDefense,
          allowDouble
        },
        damageRevision: 0,
        rolledTotal: result.roll.total,
        finalTotal: damageState.currentTotal,
        modifierNotesHTML: modifiersHTML,
        damageState
      }
    }
  });

  return {
    message,
    roll: result.roll,
    profile,
    critical,
    damageState,
    finalTotal: damageState.currentTotal
  };
}

function sameTokenOrActor(a, b) {
  if (!a || !b) return false;
  if (a?.id && b?.id && a.id === b.id) return true;
  if (a?.document?.uuid && b?.document?.uuid && a.document.uuid === b.document.uuid) return true;
  return Boolean(a.actor?.uuid && b.actor?.uuid && a.actor.uuid === b.actor.uuid);
}

function defenseMethodHardBlock(actionContext, method) {
  return hardBlockDefenseCandidate(actionContext, {
    interventionCost: Math.max(0, Number(method?.config?.interventionCost) || 0),
    item: method?.item ?? null,
    actionName: method?.actionName ?? "Защита",
    actionTraits: method?.item?.system?.actionTraits
      ?? (Number(method?.config?.interventionCost) > 0 ? { intervention: true } : {})
  });
}

function enforceDefenseMethodHardBlock(actionContext, method) {
  const hardBlock = defenseMethodHardBlock(actionContext, method);
  if (!hardBlock.blocked) return true;
  ui.notifications.error(hardBlock.message);
  return false;
}

function defenseMethodOptions({
  actor,
  defenderToken,
  protectedToken,
  role,
  defenseHistory = [],
  actionContext,
  procedures = null
}) {
  // The selected Token is the authority for available special defenses.
  // Do not search another Actor or a cached source: every click re-reads the
  // embedded Ability Items of the currently controlled defender Token.
  return resolveDefenseOptionsForToken({
    defenderToken,
    protectedToken,
    role,
    actionContext,
    defenseHistory,
    procedures
  });
}

async function chooseDefenseMethod({
  actor,
  defenderToken,
  protectedToken,
  role,
  defenseHistory = [],
  actionContext,
  procedures = null
}) {
  const { DialogV2 } = foundry.applications.api;
  const options = defenseMethodOptions({
    actor,
    defenderToken,
    protectedToken,
    role,
    defenseHistory,
    actionContext,
    procedures
  });

  const targetName = protectedToken?.name || protectedToken?.actor?.name || actor.name;
  const title = role === "self"
    ? `Защита: ${defenderToken.name}`
    : `Защита союзника: ${targetName}`;

  const buttons = options.map((option, index) => {
    const unavailable = option.reasons.length
      ? ` — недоступно: ${option.reasons.join("; ")}`
      : "";
    const warningMark = option.warnings.length ? " ⚠" : "";

    return {
      action: `defense-method-${index}`,
      label: `${option.actionName} — ${option.costLabel}${warningMark}${unavailable}`,
      icon: "fa-solid fa-shield-halved",
      class: option.disabled
        ? "fast-nri-defense-method-button is-unavailable"
        : "fast-nri-defense-method-button",
      disabled: option.disabled,
      tooltip: [
        ...option.reasons.map(reason => `Недоступно: ${reason}`),
        ...option.warnings.map(warning => `Предупреждение: ${warning}`)
      ].join("\n"),
      callback: async () => option.id
    };
  });

  buttons.push({
    action: "cancel",
    label: "Отмена",
    icon: "fa-solid fa-xmark",
    class: "fast-nri-defense-method-cancel",
    callback: async () => null
  });

  const selected = await DialogV2.wait({
    classes: ["fast-nri-defense-method-dialog"],
    window: {
      title
    },
    content: `
      <div class="fast-nri-defense-method-intro">
        <div><strong>Защитник:</strong> ${esc(defenderToken.name)}</div>
        <div><strong>Защищаемая цель:</strong> ${esc(targetName)}</div>
        <p>Показаны все стандартные и специальные способы защиты, подходящие текущему ActionContext.</p>
        ${options.length ? "" : "<p><strong>У персонажа нет настроенных способов защиты этой цели.</strong></p>"}
        <small>
          Вмешательство, Движение и Воздействие не списываются автоматически.
          Предупреждение о нехватке ресурса не блокирует действие.
        </small>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons
  });

  if (!selected) return null;
  return options.find(option => option.id === selected) ?? null;
}

async function chooseDefenseClassResourceCost(actor, item) {
  if (!item || item.type !== "ability") return 0;
  const costs = abilityCosts(item);
  const min = costs.classResourceMin;
  const max = costs.classResourceMax;
  if (max <= min) return min;

  const { DialogV2 } = foundry.applications.api;
  const choices = [];
  for (let amount = min; amount <= max; amount += 1) {
    choices.push({
      action: `defense-cost-${amount}`,
      label: `${amount}`,
      callback: async () => amount
    });
  }
  choices.push({ action: "cancel", label: "Отмена", callback: async () => null });

  return DialogV2.wait({
    window: { title: `${item.name}: расход ресурса` },
    content: `<p>Выберите количество «${esc(actor.system?.classResource?.label || "Классового ресурса")}": <strong>${min}–${max}</strong>.</p>`,
    modal: true,
    rejectClose: false,
    buttons: choices
  });
}

async function spendDefenseClassResource(actor, item, selectedCost = null) {
  const configured = abilityCosts(item);
  const defaultCost = configured.classResourceMin;
  const cost = Math.max(0, Number(selectedCost ?? defaultCost) || 0);
  const resource = actor?.system?.classResource ?? {};
  const before = Math.max(0, Number(resource.value) || 0);
  const max = Math.max(0, Number(resource.max) || 0);

  if (!(cost > 0)) {
    return {
      cost: 0,
      label: resource.label || "Классовый ресурс",
      before,
      after: before,
      spent: 0,
      shortage: 0,
      max
    };
  }

  const shortage = Math.max(0, cost - before);
  if (shortage > 0) {
    ui.notifications.warn(
      `${actor.name}: недостаточно ресурса «${resource.label || "Классовый ресурс"}». ` +
      `Нужно ${cost}, доступно ${before}. Защита не блокируется.`
    );
  }

  const after = Math.max(0, before - cost);
  const spent = before - after;

  try {
    await actor.update({
      "system.classResource.value": after
    });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка списания ресурса защитной способности", error);
    ui.notifications.error("Не удалось изменить классовый ресурс; защита всё равно разрешена.");
    return {
      cost,
      label: resource.label || "Классовый ресурс",
      before,
      after: before,
      spent: 0,
      shortage,
      max,
      updateFailed: true
    };
  }

  return {
    cost,
    label: resource.label || "Классовый ресурс",
    before,
    after,
    spent,
    shortage,
    max
  };
}

function defenseResourceHTML(resource, undone = false, { inlineDefenseId = null } = {}) {
  if (!(Number(resource?.cost) > 0)) return "";
  const undoAttribute = inlineDefenseId
    ? `data-fast-nri-undo-inline-defense-resource data-defense-id="${escAttr(inlineDefenseId)}"`
    : "data-fast-nri-undo-defense-resource";

  return `
    <div class="fast-nri-resource-use ${undone ? "undone" : ""}">
      <div class="fast-nri-resource-use-text">
        <span class="fast-nri-resource-label">${esc(resource.label || "Классовый ресурс")}</span>
        <strong>−${esc(resource.cost)}</strong>
        <small>${esc(resource.before)} → ${esc(resource.after)}</small>
        ${resource.shortage > 0
          ? `<small class="fast-nri-resource-shortage">не хватает ${esc(resource.shortage)}</small>`
          : ""
        }
      </div>

      ${undone || !(resource.spent > 0) ? "" : `
        <button
          type="button"
          class="fast-nri-undo-resource-button"
          ${undoAttribute}
          title="Вернуть списанный классовый ресурс"
        >
          <i class="fa-solid fa-rotate-left"></i>
          <span>Вернуть</span>
        </button>
      `}
    </div>
  `;
}

function defenseRollFlavorHTML({
  actionName,
  defenderTokenName,
  protectedTokenName,
  role,
  attackTotal,
  defenseTotal,
  defenseResult,
  result,
  sourcesHTML = "",
  resource,
  resourceUndone = false
}) {
  return `
    <div class="fast-nri-chat-roll fast-nri-defense-roll-card">
      ${rollCardHeader(`${actionName}: ${defenderTokenName}`, "fa-shield-halved")}
      <div class="fast-nri-defense-roll-result">
        ${role === "ally"
          ? `<span>Защищаемая цель: <strong>${esc(protectedTokenName)}</strong></span>`
          : ""
        }
        <span>Исходный результат: <strong>${esc(attackTotal)}</strong></span>
        <span>Защита: <strong>${esc(defenseTotal)}</strong></span>
        <span>Результат: <strong>${esc(defenseResultLabel(defenseResult))}</strong></span>
      </div>
      ${defenseResourceHTML(resource, resourceUndone)}
      ${result ? rollSourcesHTML(result) : sourcesHTML}
    </div>
  `;
}

export async function undoDefenseResource(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== "defense-roll") {
    ui.notifications.error("Не удалось найти данные защитного броска.");
    return null;
  }

  if (message.getFlag("fast-nri", "resourceUndone")) {
    ui.notifications.info("Ресурс уже возвращён.");
    return null;
  }

  const actor = await fromUuid(message.getFlag("fast-nri", "defenderActorUuid"));
  if (!actor) {
    ui.notifications.error("Не удалось найти защищавшего персонажа.");
    return null;
  }

  const spent = Math.max(0, Number(message.getFlag("fast-nri", "resourceSpent")) || 0);
  if (!(spent > 0)) {
    ui.notifications.info("Для этой защиты ресурс фактически не списывался.");
    return null;
  }

  const current = Math.max(0, Number(actor.system?.classResource?.value) || 0);
  const restored = current + spent;

  await actor.update({ "system.classResource.value": restored });

  const resource = {
    cost: Number(message.getFlag("fast-nri", "resourceCost")) || 0,
    label: message.getFlag("fast-nri", "resourceLabel") || "Классовый ресурс",
    before: Number(message.getFlag("fast-nri", "resourceBefore")) || 0,
    after: Number(message.getFlag("fast-nri", "resourceAfter")) || 0,
    spent,
    shortage: Number(message.getFlag("fast-nri", "resourceShortage")) || 0
  };

  const stored = message.getFlag("fast-nri", "defenseDisplay") ?? {};
  const flavor = defenseRollFlavorHTML({
    ...stored,
    result: null,
    resource,
    resourceUndone: true
  });

  await message.update({
    flavor,
    "flags.fast-nri.resourceUndone": true,
    "flags.fast-nri.resourceRestoredTo": restored
  });

  return { actor, restored, restoredAmount: spent };
}


async function undoInlineDefenseResource(element) {
  const message = chatMessageFromElement(element);
  const defenseId = String(element?.dataset?.defenseId ?? "").trim();
  if (!message || !defenseId) {
    ui.notifications.error("Не удалось найти встроенный результат Защиты.");
    return null;
  }

  const kind = message.getFlag("fast-nri", "kind");
  let entry = null;
  let commit = null;

  if (kind === "damage") {
    const state = foundry.utils.deepClone(message.getFlag("fast-nri", "damageState") ?? {});
    entry = Array.from(state.defenseHistory ?? []).find(candidate => candidate?.id === defenseId) ?? null;
    if (entry) {
      commit = async () => {
        if (state.defense?.id === defenseId) state.defense = foundry.utils.deepClone(entry);
        await updateDamageMessageInPlace(message, state, { kind: "undoDefenseResource", defenseId });
      };
    }
  } else if (kind === "ability-check") {
    const history = foundry.utils.deepClone(message.getFlag("fast-nri", "defenseHistory") ?? []);
    entry = history.find(candidate => candidate?.id === defenseId) ?? null;
    if (entry) {
      commit = async () => {
        const context = actionContextFromMessage(message);
        const sourceActor = context?.source?.actorUuid ? await fromUuid(context.source.actorUuid) : null;
        const sourceItem = context?.source?.itemUuid ? await fromUuid(context.source.itemUuid) : null;
        const profileHTML = sourceItem?.type === "ability" && context?.check?.degree
          ? await enrichAbilityProfileHTML(sourceItem, context.check.degree)
          : "";
        await message.update({
          flavor: checkAfterDefenseCardHTML({
            sourceActor,
            sourceItem,
            actionContext: context,
            defense: history.at(-1) ?? null,
            defenseHistory: history,
            profileHTML
          }),
          "flags.fast-nri.defenseHistory": history
        });
      };
    }
  } else if (kind === MULTI_TARGET_ABILITY_KIND) {
    const state = foundry.utils.deepClone(message.getFlag("fast-nri", "multiTargetState") ?? {});
    for (const target of Array.from(state.targets ?? [])) {
      const histories = [target.appliedDefenseHistory ?? [], target.pendingDefenses ?? []];
      for (const history of histories) {
        const found = Array.from(history).find(candidate => candidate?.id === defenseId);
        if (found) {
          entry = found;
          break;
        }
      }
      if (entry) break;
    }
    if (entry) commit = async () => updateMultiTargetMessage(message, { state });
  }

  if (!entry || !commit) {
    ui.notifications.error("В этой карточке не найден сохранённый шаг Защиты.");
    return null;
  }
  if (entry.resourceUndone) {
    ui.notifications.info("Ресурс этой Защиты уже возвращён.");
    return null;
  }

  const resource = entry.resource ?? {};
  const spent = Math.max(0, Number(resource.spent) || 0);
  if (!(spent > 0)) {
    ui.notifications.info("Для этой Защиты ресурс фактически не списывался.");
    return null;
  }
  const actorUuid = entry.actorUuid ?? entry.defenderActorUuid ?? null;
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  if (!actor) {
    ui.notifications.error("Не удалось найти защищавшего персонажа.");
    return null;
  }

  const current = Math.max(0, Number(actor.system?.classResource?.value) || 0);
  const restored = current + spent;
  await actor.update({ "system.classResource.value": restored });
  entry.resourceUndone = true;
  entry.resourceRestoredTo = restored;
  await commit();
  return { actor, restored, restoredAmount: spent };
}


export function checkDefenseParticipants(defenderToken, userTargets = []) {
  if (!defenderToken) return { error: "no-defender", protectedToken: null, role: null };

  const targets = Array.from(userTargets ?? []);
  if (targets.length > 1) {
    return { error: "too-many-targets", protectedToken: null, role: null };
  }

  const requestedTarget = targets[0] ?? defenderToken;
  const role = sameTokenOrActor(defenderToken, requestedTarget) ? "self" : "ally";
  return {
    error: null,
    protectedToken: role === "self" ? defenderToken : requestedTarget,
    role
  };
}

export function resolveCheckDefenseResult({
  degreeBefore = null,
  defenseTotal = null,
  attackTotal = null,
  naturalD20 = null,
  degreeReduction = 1
} = {}) {
  const hasDegree = Object.prototype.hasOwnProperty.call(DEGREE_LABELS, degreeBefore);
  let result = "failure";
  let degreeAfter = hasDegree ? degreeBefore : null;
  let appliedDegreeReduction = 0;

  if (naturalD20 === 1) {
    return { result, degreeBefore: hasDegree ? degreeBefore : null, degreeAfter, degreeReduction: 0 };
  }

  if (naturalD20 === 20) {
    result = "success";
    degreeAfter = hasDegree ? "failure" : null;
    appliedDegreeReduction = hasDegree ? 99 : 0;
    return { result, degreeBefore: hasDegree ? degreeBefore : null, degreeAfter, degreeReduction: appliedDegreeReduction };
  }

  const defense = finiteNumberOrNull(defenseTotal);
  const attack = finiteNumberOrNull(attackTotal);
  if (defense !== null && attack !== null && defense >= attack) {
    result = "success";
    if (hasDegree) {
      appliedDegreeReduction = Math.max(1, Number(degreeReduction) || 1);
      degreeAfter = lowerDegree(degreeBefore, appliedDegreeReduction);
    }
  }

  return {
    result,
    degreeBefore: hasDegree ? degreeBefore : null,
    degreeAfter,
    degreeReduction: appliedDegreeReduction
  };
}

async function chooseDodgeMovement(actionName = "Уворот") {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    window: { title: `${actionName}: способ перемещения` },
    content: `
      <div class="fast-nri-defense-choice">
        <p>Выберите вариант Уворота. Foundry не перемещает токен автоматически.</p>
        <small>После броска выполните выбранное перемещение вручную до применения результата исходного действия.</small>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "step",
        label: "Увернуться · 1 соседняя клетка",
        icon: "fa-solid fa-person-walking-arrow-right",
        callback: async () => "step"
      },
      {
        action: "leap",
        label: "Отпрыгнуть · 2 клетки по прямой · Сбит с ног",
        icon: "fa-solid fa-person-falling",
        callback: async () => "leap"
      },
      {
        action: "cancel",
        label: "Отмена",
        icon: "fa-solid fa-xmark",
        callback: async () => null
      }
    ]
  });
}

async function chooseDodgeDegreeReduction(actionName = "Уворот") {
  const { DialogV2 } = foundry.applications.api;
  return DialogV2.wait({
    window: { title: `${actionName}: итог перемещения` },
    content: `
      <div class="fast-nri-defense-choice">
        <p>Укажите итог выбранного вручную перемещения.</p>
        <small>Это выбор пользователя, а не автоматическая проверка геометрии системой.</small>
      </div>
    `,
    modal: true,
    rejectClose: false,
    buttons: [
      {
        action: "inside",
        label: "Остался под действием атаки · степень −1",
        icon: "fa-solid fa-location-dot",
        callback: async () => 1
      },
      {
        action: "safe",
        label: "Достиг безопасного места · степень −2",
        icon: "fa-solid fa-person-running",
        callback: async () => 2
      }
    ]
  });
}

function checkDefenseRollFlavorHTML({
  actionName,
  procedure,
  defenderTokenName,
  protectedTokenName,
  role,
  characteristic,
  attackTotal,
  defenseTotal,
  defenseResult,
  degreeBefore,
  degreeAfter,
  dodgeMovement = null,
  result,
  resource
}) {
  const procedureLabel = procedure === "dodge" ? "Уворот" : "Противодействие";
  const movementLabel = dodgeMovement === "step"
    ? "Увернуться: 1 соседняя клетка"
    : dodgeMovement === "leap"
      ? "Отпрыгнуть: 2 клетки по прямой; затем Сбит с ног"
      : "";

  return `
    <div class="fast-nri-chat-roll fast-nri-defense-roll-card fast-nri-check-defense-roll-card">
      ${rollCardHeader(`${actionName}: ${defenderTokenName}`, "fa-shield-halved")}
      <div class="fast-nri-defense-roll-result">
        ${role === "ally" ? `<span>Защищаемая цель: <strong>${esc(protectedTokenName)}</strong></span>` : ""}
        <span>Процедура: <strong>${esc(procedureLabel)}</strong></span>
        <span>Характеристика: <strong>${esc(checkTargetCharacteristicLabel(characteristic))}</strong></span>
        <span>Исходный результат: <strong>${esc(attackTotal)}</strong></span>
        <span>Защита: <strong>${esc(defenseTotal)}</strong></span>
        <span>Результат: <strong>${esc(defenseResultLabel(defenseResult))}</strong></span>
        ${degreeBefore ? `<span>Степень: <strong>${esc(DEGREE_LABELS[degreeBefore] ?? degreeBefore)}</strong> → <strong>${esc(DEGREE_LABELS[degreeAfter] ?? degreeAfter)}</strong></span>` : ""}
        ${movementLabel ? `<span>Перемещение: <strong>${esc(movementLabel)}</strong></span>` : ""}
      </div>
      ${procedure === "dodge" && result?.naturalD20 === 1 ? `
        <div class="fast-nri-damage-structure-warning">
          Натуральная 1: не перемещайтесь и примените состояние «Сбит с ног» вручную.
        </div>
      ` : ""}
      ${procedure === "dodge" && result?.naturalD20 !== 1 ? `
        <small>Перемещение Уворота выполняется вручную; система фиксирует выбранный итог, но не двигает токен.</small>
      ` : ""}
      ${defenseResourceHTML(resource, false)}
      ${rollSourcesHTML(result)}
    </div>
  `;
}

function checkAfterDefenseCardHTML({ sourceActor, sourceItem, actionContext, defense = null, defenseHistory = [], profileHTML = "" }) {
  const context = normalizeActionContext(actionContext);
  const targetLabel = checkTargetCharacteristicLabel(context.check.targetCharacteristic);
  const targetName = context.targets?.[0]?.name ?? "";
  const traitsLabel = actionTraitsLabel(context.traits);
  const history = Array.from(defenseHistory ?? []);
  if (!history.length && defense) history.push(defense);
  const latest = defense ?? history.at(-1) ?? null;
  const followup = sourceActor && sourceItem?.type === "ability" && context.check.degree
    ? abilityAttackFollowupHTML(sourceActor, sourceItem, context.check.degree, context.source?.implementationId ?? null)
    : "";

  return `
    <div class="fast-nri-chat-roll fast-nri-attack-card fast-nri-ability-check-card fast-nri-check-after-defense-card">
      ${rollCardHeader(`Проверка: ${sourceItem?.name ?? context.source?.name ?? "Действие"}`, "fa-shield-halved")}
      <div class="fast-nri-attack-summary">
        <span>Исходный результат: <strong>${esc(context.check.total)}</strong></span>
        <span>Против: <strong>${esc(targetLabel)}</strong></span>
        ${targetName ? `<span>Цель: <strong>${esc(targetName)}</strong></span>` : ""}
      </div>
      ${history.length ? `<div class="fast-nri-defense-inline-history">${defenseHistoryHTML(history)}</div>` : ""}
      ${latest?.degreeAfter ? `<div class="fast-nri-attack-summary"><span>Итоговая степень для цели: <strong>${esc(DEGREE_LABELS[latest.degreeAfter] ?? latest.degreeAfter)}</strong></span></div>` : ""}
      ${latest && !latest.degreeAfter ? `<div class="fast-nri-attack-summary"><span>Итог Защиты для цели: <strong>${esc(defenseResultLabel(latest.result))}</strong></span></div>` : ""}
      <div class="fast-nri-attack-type"><small>Признаки действия: <strong>${esc(traitsLabel)}</strong></small></div>
      ${degreeHTML(context.check.degree)}
      ${profileHTML}
      ${abilityCheckDefenseHTML(context)}
      ${followup}
    </div>
  `;
}

export async function checkDefenseFromChat(element) {
  const message = chatMessageFromElement(element);
  if (!message || message.getFlag("fast-nri", "kind") !== "ability-check") {
    ui.notifications.error("Не удалось найти исходную проверку для Защитного действия.");
    return null;
  }

  const actionContext = actionContextFromMessage(message);
  if (!actionContext) {
    ui.notifications.error("В этой карточке нет ActionContext 0.5.53. Повторите исходную проверку.");
    return null;
  }

  const availableProcedures = ["counteraction", "dodge"].filter(procedure =>
    actionHasDefenseProcedure(actionContext, procedure)
  );
  if (!availableProcedures.length) {
    ui.notifications.info("Для этой проверки нет стандартного Противодействия или Уворота.");
    return null;
  }

  const defenderToken = controlledSingleDefenderToken();
  if (!defenderToken) return null;
  const defender = defenderToken.actor;
  if (!defender) return null;

  const participants = checkDefenseParticipants(
    defenderToken,
    Array.from(game.user?.targets ?? [])
  );
  if (participants.error === "too-many-targets") {
    ui.notifications.warn("Для одной Защиты выбери не больше одной защищаемой цели.");
    return null;
  }
  const protectedToken = participants.protectedToken;
  const role = participants.role;
  const defenseHistory = Array.from(message.getFlag("fast-nri", "defenseHistory") ?? []);
  const method = await chooseDefenseMethod({
    actor: defender,
    defenderToken,
    protectedToken,
    role,
    defenseHistory,
    actionContext,
    procedures: availableProcedures
  });
  if (!method) return null;
  if (!enforceDefenseMethodHardBlock(actionContext, method)) return null;

  if (method.warnings.length) {
    ui.notifications.warn(`${method.actionName}: ${method.warnings.join("; ")}.`);
  }

  const procedure = method.procedure;
  const characteristic = procedure === "dodge"
    ? "reflex"
    : normalizeCheckTargetCharacteristic(actionContext.check.targetCharacteristic);
  if (!characteristic || characteristic === "armor") {
    ui.notifications.error("Не удалось определить защитную характеристику для этой процедуры.");
    return null;
  }

  let dodgeMovement = null;
  if (procedure === "dodge") {
    dodgeMovement = await chooseDodgeMovement(method.actionName);
    if (!dodgeMovement) return null;
  }

  const sourceActor = actionContext.source?.actorUuid
    ? await fromUuid(actionContext.source.actorUuid)
    : null;
  const sourceItem = actionContext.source?.itemUuid
    ? await fromUuid(actionContext.source.itemUuid)
    : null;

  const characteristicState = effectiveDefenseCharacteristicForAction(
    defenderToken,
    characteristic,
    sourceActor
  );
  const characteristicValue = finiteNumberOrNull(characteristicState.value);
  if (characteristicValue === null) {
    ui.notifications.error(
      `У выбранного токена нет корректного значения «${checkTargetCharacteristicLabel(characteristic)}».`
    );
    return null;
  }

  const combatSource = defenseCombatTerm(defender, method.item, role);
  const baseFormula = combatSource?.formula
    ? `1d20 + ${characteristicValue} + ${combatSource.formula}`
    : `1d20 + ${characteristicValue}`;

  const selectedClassResourceCost = await chooseDefenseClassResourceCost(defender, method.item);
  if (selectedClassResourceCost === null) return null;

  const contextualModifiers = selfDefenseContextualModifiers(
    defender,
    sourceItem,
    actionContext.check.degree
  ).filter(modifier => modifier.id !== "weapon-deadly");

  const result = await prepareRoll({
    actor: defender,
    label: `${method.actionName}: ${defenderToken.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: method.actionName },
      {
        formula: String(characteristicValue),
        label: checkTargetCharacteristicLabel(characteristic),
        reason: characteristicState.state?.offGuard
          ? `${defender.name} · Застигнут врасплох −2`
          : defender.name
      },
      ...(combatSource ? [combatSource] : [])
    ],
    showDC: false,
    additionalModifiers: contextualModifiers,
    contextHTML: `
      <section class="fast-nri-roll-context fast-nri-defense-roll-context">
        <i class="fa-solid fa-shield-halved"></i>
        <div>
          <strong>${esc(method.actionName)}</strong>
          <small>
            ${esc(checkTargetCharacteristicLabel(characteristic))} ·
            исходный результат ${esc(actionContext.check.total)} ·
            ${esc(defenseCostLabel(method.item ?? method.config, defender))}
          </small>
        </div>
      </section>
    `
  });
  if (!result) return null;
  await showInPlaceRollDice(result.roll);

  const attackTotal = finiteNumberOrNull(actionContext.check.total);
  if (attackTotal === null) {
    ui.notifications.error("В ActionContext отсутствует результат исходной проверки.");
    return null;
  }

  const degreeBefore = actionContext.check.degree;
  const hasDegree = Object.prototype.hasOwnProperty.call(DEGREE_LABELS, degreeBefore);
  let requestedDegreeReduction = Math.max(1, Number(method.config.effectDegreeReduction) || 1);
  const preliminarySuccess = result.naturalD20 === 20
    || (result.naturalD20 !== 1 && result.roll.total >= attackTotal);
  if (procedure === "dodge" && preliminarySuccess && hasDegree && result.naturalD20 !== 20) {
    requestedDegreeReduction = Number(await chooseDodgeDegreeReduction(method.actionName)) || 1;
  }

  const resolvedDefense = resolveCheckDefenseResult({
    degreeBefore,
    defenseTotal: result.roll.total,
    attackTotal,
    naturalD20: result.naturalD20,
    degreeReduction: requestedDegreeReduction
  });
  const defenseResult = resolvedDefense.result;
  const degreeAfter = resolvedDefense.degreeAfter;
  const degreeReduction = resolvedDefense.degreeReduction;

  const resource = await spendDefenseClassResource(defender, method.item, selectedClassResourceCost);
  const defenseEntry = {
    kind: "check-defense",
    procedure,
    actionName: method.actionName,
    abilityUuid: method.item?.uuid ?? null,
    actorUuid: defender.uuid,
    defenderTokenUuid: defenderToken.document?.uuid ?? null,
    defenderTokenName: defenderToken.name || defender.name,
    protectedTokenUuid: protectedToken.document?.uuid ?? null,
    protectedActorUuid: protectedToken.actor?.uuid ?? null,
    protectedTokenName: protectedToken.name || protectedToken.actor?.name,
    characteristic,
    attackTotal,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    result: defenseResult,
    degreeBefore,
    degreeAfter,
    degreeReduction,
    dodgeMovement,
    interventionCost: Math.max(0, Number(method.config.interventionCost) || 0)
  };
  const nextContext = deriveActionContext(actionContext, {
    targets: [protectedToken],
    check: {
      ...actionContext.check,
      degree: degreeAfter
    }
  });
  const defenseActionContext = actionContextForDefenseAction(actionContext, {
    actor: defender,
    item: method.item,
    defenderToken,
    protectedToken,
    actionName: method.actionName,
    procedure,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    parentMessageId: message.id
  });
  Object.assign(defenseEntry, {
    id: resolutionEntryId("defense"),
    formula: result.formula,
    resource: foundry.utils.deepClone(resource),
    resourceUndone: false,
    sourcesHTML: rollSourcesHTML(result),
    actionContext: defenseActionContext
  });
  const nextHistory = [...defenseHistory, defenseEntry];

  const derivedProfileHTML = sourceItem?.type === "ability" && nextContext.check.degree
    ? await enrichAbilityProfileHTML(sourceItem, nextContext.check.degree)
    : "";

  const flavor = checkAfterDefenseCardHTML({
    sourceActor,
    sourceItem,
    actionContext: nextContext,
    defense: defenseEntry,
    defenseHistory: nextHistory,
    profileHTML: derivedProfileHTML
  });
  const baseFlags = foundry.utils.deepClone(message?.flags?.["fast-nri"] ?? {});
  await message.update({
    flavor,
    "flags.fast-nri": {
      ...baseFlags,
      kind: "ability-check",
      actorUuid: actionContext.source.actorUuid,
      itemUuid: actionContext.source.itemUuid,
      targetUuid: nextContext.targets?.[0]?.tokenUuid ?? null,
      degree: degreeAfter,
      originalDegree: baseFlags.originalDegree ?? baseFlags.degree ?? degreeBefore,
      critical: Boolean(nextContext.check.critical),
      rollTotal: nextContext.check.total,
      naturalD20: nextContext.check.naturalD20,
      targetCharacteristic: nextContext.check.targetCharacteristic,
      actionTraits: nextContext.traits,
      actionContext: nextContext,
      defenseHistory: nextHistory,
      attackType: directedAttackTypeFromActionContext(nextContext),
      area: Boolean(nextContext.traits.area),
      directedDefense: Boolean(nextContext.defenseProcedures.directed)
    }
  });

  return {
    sourceMessage: message,
    defenseMessage: null,
    message,
    roll: result.roll,
    actionContext: nextContext,
    defense: defenseEntry
  };
}

export async function defenseFromChat(element) {
  const message = chatMessageFromElement(element);

  if (!message || message.getFlag("fast-nri", "kind") !== "damage") {
    ui.notifications.error("Не удалось найти исходный бросок урона.");
    return null;
  }

  const defenderToken = controlledSingleDefenderToken();
  if (!defenderToken) return null;

  const defender = defenderToken.actor;
  if (!defender) {
    ui.notifications.error("У выбранного токена нет Actor.");
    return null;
  }

  const targets = Array.from(game.user?.targets ?? []);
  if (targets.length > 1) {
    ui.notifications.warn("Для защиты выбери не больше одной защищаемой цели.");
    return null;
  }

  const requestedTarget = targets[0] ?? defenderToken;
  const role = sameTokenOrActor(defenderToken, requestedTarget) ? "self" : "ally";
  const protectedToken = role === "self" ? defenderToken : requestedTarget;

  let damageState = foundry.utils.deepClone(
    message.getFlag("fast-nri", "damageState")
  );

  if (!damageState) {
    ui.notifications.error("В этом сообщении нет структурированного результата урона.");
    return null;
  }

  if (!damageState.supported) {
    ui.notifications.error("Эту формулу урона пока нельзя безопасно обработать Направленной защитой.");
    return null;
  }

  const sourceItem = await fromUuid(message.getFlag("fast-nri", "itemUuid"));
  let actionContext = actionContextFromMessage(message);

  // Compatibility for already existing chat messages: rebuild context only
  // from structured flags/document fields. Runtime prose inference is not used.
  if (!actionContext) {
    const sourceActorUuid = message.getFlag("fast-nri", "actorUuid");
    const sourceActor = sourceActorUuid ? await fromUuid(sourceActorUuid) : null;
    const storedTraits = message.getFlag("fast-nri", "actionTraits");
    const storedAttackType = normalizeAttackType(message.getFlag("fast-nri", "attackType"));
    const base = sourceItem?.type === "weapon"
      ? actionContextFromWeapon(sourceActor, sourceItem)
      : sourceItem?.type === "ability"
        ? actionContextFromAbility(sourceActor, sourceItem, { implementationId: message.getFlag("fast-nri", "implementationId") ?? null })
        : normalizeActionContext({});

    actionContext = deriveActionContext(base, {
      targets: message.getFlag("fast-nri", "originalTargetUuid")
        ? [{ tokenUuid: message.getFlag("fast-nri", "originalTargetUuid") }]
        : base.targets,
      traits: storedTraits ?? {
        melee: storedAttackType === "melee",
        ranged: storedAttackType === "ranged"
      },
      check: {
        ...base.check,
        enabled: true,
        targetCharacteristic: message.getFlag("fast-nri", "targetCharacteristic")
          ?? base.check.targetCharacteristic
          ?? "armor",
        total: message.getFlag("fast-nri", "attackTotal"),
        naturalD20: message.getFlag("fast-nri", "attackNaturalD20"),
        degree: message.getFlag("fast-nri", "attackDegree")
      },
      defenseProcedures: {
        ...base.defenseProcedures,
        directed: Boolean(
          message.getFlag("fast-nri", "directedDefense")
          ?? base.defenseProcedures.directed
        )
      }
    });
  }

  const attackType = directedAttackTypeFromActionContext(actionContext);
  const actionTraits = actionContext.traits;

  const method = await chooseDefenseMethod({
    actor: defender,
    defenderToken,
    protectedToken,
    role,
    defenseHistory: damageState?.defenseHistory ?? [],
    actionContext,
    procedures: ["directed"]
  });
  if (!method) return null;
  if (!enforceDefenseMethodHardBlock(actionContext, method)) return null;

  const actionItem = method.item;
  const actionRuntime = method.runtime ?? actionItem;
  const actionImplementationId = method.implementationId ?? null;
  const actionConfig = method.config;
  const actionName = method.actionName;

  if (method.warnings.length) {
    ui.notifications.warn(`${actionName}: ${method.warnings.join("; ")}.`);
  }

  if (actionConfig.movementMode === "moveAdjacent") {
    ui.notifications.info(
      `${actionName}: перемещение токена остаётся ручным. После выбора проверьте маршрут и свободную клетку рядом с целью.`
    );
  }

  const attackTotal = finiteNumberOrNull(message.getFlag("fast-nri", "attackTotal"));
  const attackNaturalD20 = finiteNumberOrNull(message.getFlag("fast-nri", "attackNaturalD20"));

  if (attackTotal === null) {
    ui.notifications.error("Не удалось определить результат исходного действия для проверки защиты.");
    return null;
  }

  if (damageState.currentTotal <= 0) {
    const continueForEffect = await confirmZeroDamageDefense(actionName);
    if (!continueForEffect) return null;
  }

  const removalMode = actionConfig.damageSelectionMode === "largest"
    ? "largest"
    : actionConfig.damageSelectionMode === "smallest"
      ? "smallest"
      : selfDefenseRemovalMode(sourceItem);
  const remainingBeforeRoll = (damageState.parts ?? []).filter(part => !part.removed);
  const selectedRemovalParts = await chooseDamageParts(
    remainingBeforeRoll,
    actionConfig.removeDamageParts,
    removalMode,
    actionName
  );
  if (selectedRemovalParts === null) return null;

  const sourceActor = actionContext.source?.actorUuid
    ? await fromUuid(actionContext.source.actorUuid)
    : sourceItem?.parent?.documentName === "Actor"
      ? sourceItem.parent
      : null;

  const selfDefenseOverride = role === "self"
    ? String(actionConfig.selfDefenseCharacteristic ?? "").trim()
      || String(defender.system?.selfDefenseCharacteristicOverride ?? "").trim()
    : "";

  const defenseCharacteristic = defenseCharacteristicForRole({
    role,
    attackType,
    selfDefenseOverride
  });

  if (!defenseCharacteristic) {
    ui.notifications.error(
      role === "self"
        ? "6.3: невозможно определить характеристику Самозащиты. У исходной атаки должен быть вид Ближняя или Дистанционная, либо частное исключение."
        : "Не удалось определить характеристику Направленной защиты."
    );
    return null;
  }

  const characteristicState = effectiveDefenseCharacteristicForAction(
    defenderToken,
    defenseCharacteristic,
    sourceActor
  );
  const characteristicValue = finiteNumberOrNull(characteristicState.value);
  if (characteristicValue === null) {
    ui.notifications.error(
      `У выбранного токена нет корректного значения «${defenseCharacteristicLabel(defenseCharacteristic)}».`
    );
    return null;
  }

  const combatSource = defenseCombatTerm(defender, actionRuntime, role);
  const baseFormula = combatSource?.formula
    ? `1d20 + ${characteristicValue} + ${combatSource.formula}`
    : `1d20 + ${characteristicValue}`;

  const interventionCost = Math.max(0, Number(actionConfig.interventionCost) || 0);
  const interventions = finiteNumberOrNull(defender.system?.resources?.intervention);
  if (
    interventionCost > 0
    && interventions !== null
    && interventions < interventionCost
  ) {
    ui.notifications.warn(
      `${defenderToken.name}: в листе ${interventions} Вмешательств, требуется ${interventionCost}. ` +
      `Защита не блокируется; базовый ресурс ведётся вручную.`
    );
  }

  const selectedClassResourceCost = await chooseDefenseClassResourceCost(defender, actionRuntime);
  if (selectedClassResourceCost === null) return null;

  const contextualModifiers = selfDefenseContextualModifiers(
    defender,
    sourceItem,
    damageState.originalEffectDegree
  );

  const result = await prepareRoll({
    actor: defender,
    label: `${actionName}: ${defenderToken.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: "Направленная защита" },
      {
        formula: String(characteristicValue),
        label: defenseCharacteristicLabel(defenseCharacteristic),
        reason: characteristicState.state?.offGuard
          ? `${defender.name} · Застигнут врасплох −2`
          : defender.name
      },
      ...(combatSource ? [combatSource] : [])
    ],
    showDC: false,
    additionalModifiers: contextualModifiers,
    contextHTML: `
      <section class="fast-nri-roll-context fast-nri-defense-roll-context">
        <i class="fa-solid fa-shield-halved"></i>
        <div>
          <strong>${esc(actionName)}</strong>
          <small>
            ${role === "ally" ? `Цель: ${esc(protectedToken.name)} · ` : ""}
            Исходный результат: ${esc(attackTotal)}
            ${role === "self" ? ` · ${esc(attackTypeLabel(attackType))} → ${esc(defenseCharacteristicLabel(defenseCharacteristic))}` : ""}
            · Удаление: ${esc(actionConfig.removeDamageParts)}
            · Снижение Эффекта: ${esc(actionConfig.effectDegreeReduction)}
            · ${esc(defenseCostLabel(actionItem ?? actionConfig, defender))}
          </small>
        </div>
      </section>
    `
  });

  if (!result) return null;
  await showInPlaceRollDice(result.roll);

  let defenseResult = "failure";
  if (result.naturalD20 === 1) {
    defenseResult = "failure";
  } else if (result.naturalD20 === 20) {
    defenseResult = attackNaturalD20 === 20 ? "success" : "full-cancel";
  } else if (result.roll.total >= attackTotal) {
    defenseResult = "success";
  }

  const effectDegreeBefore = damageState.effectDegree ?? null;
  let effectDegreeAfter = effectDegreeBefore;
  let removedParts = [];

  if (defenseResult === "full-cancel") {
    damageState.fullCancel = true;
    damageState.effectDegree = "failure";
    effectDegreeAfter = "failure";
  } else if (defenseResult === "success") {
    removedParts = selectedRemovalParts ?? [];
    const removedIds = new Set(removedParts.map(part => part.id));

    if (removedIds.size) {
      damageState.parts = damageState.parts.map(part => removedIds.has(part.id)
        ? {
            ...part,
            defenseZeroed: true,
            removed: false
          }
        : part
      );
    }

    effectDegreeAfter = lowerDegree(
      effectDegreeBefore,
      actionConfig.effectDegreeReduction
    );
    damageState.effectDegree = effectDegreeAfter;
  }

  const resource = await spendDefenseClassResource(defender, actionRuntime, selectedClassResourceCost);

  damageState.defense = {
    kind: role === "self" ? "self-defense" : "ally-defense",
    actionName,
    abilityUuid: actionItem?.uuid ?? null,
    implementationId: actionImplementationId,
    tokenUuid: defenderToken.document?.uuid ?? null,
    actorUuid: defender.uuid,
    tokenName: defenderToken.name || defender.name || "Защитник",
    protectedTokenUuid: protectedToken?.document?.uuid ?? null,
    protectedActorUuid: protectedToken?.actor?.uuid ?? null,
    protectedTokenName: protectedToken?.name || protectedToken?.actor?.name || "Цель",
    interventionCost,
    classResourceCost: resource.cost,
    formula: result.formula,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    attackTotal,
    attackNaturalD20,
    attackType,
    characteristic: defenseCharacteristic,
    result: defenseResult,
    removedPartId: removedParts[0]?.id ?? null,
    removedPart: removedParts[0] ? foundry.utils.deepClone(removedParts[0]) : null,
    removedPartIds: removedParts.map(part => part.id),
    removedParts: removedParts.map(part => foundry.utils.deepClone(part)),
    removalMode,
    removeDamageParts: actionConfig.removeDamageParts,
    effectDegreeReduction: actionConfig.effectDegreeReduction,
    contextualModifiers: result.automaticModifiers
      .filter(modifier => String(modifier.id ?? "").startsWith("context-")
        || String(modifier.id ?? "").startsWith("equipped-defensive-")
        || String(modifier.id ?? "").startsWith("weapon-")),
    effectDegreeBefore,
    effectDegreeAfter
  };

  const defenseActionContext = actionContextForDefenseAction(actionContext, {
    actor: defender,
    item: actionRuntime,
    defenderToken,
    protectedToken,
    actionName,
    procedure: "directed",
    total: result.roll.total,
    naturalD20: result.naturalD20,
    parentMessageId: message.id
  });
  Object.assign(damageState.defense, {
    id: resolutionEntryId("defense"),
    defenderTokenName: defenderToken.name || defender.name || "Защитник",
    resource: foundry.utils.deepClone(resource),
    resourceUndone: false,
    sourcesHTML: rollSourcesHTML(result),
    actionContext: defenseActionContext
  });
  damageState.defenseHistory = [
    ...(damageState.defenseHistory ?? []),
    foundry.utils.deepClone(damageState.defense)
  ];
  damageState = recalculateDamageState(damageState);

  const sourceRuntime = sourceItem?.type === "ability"
    ? abilityImplementationRuntime(sourceItem, message.getFlag("fast-nri", "implementationId") ?? null)
    : null;
  const applicationEffects = sourceRuntime
    ? await abilityApplicationEffects(sourceRuntime, damageState.effectDegree)
    : { uuids: [], html: "" };

  await updateDamageMessageInPlace(
    message,
    damageState,
    { kind: "defense", defenseId: damageState.defense.id },
    { applicationEffectUuids: applicationEffects.uuids }
  );
  await message.update({
    "flags.fast-nri.attackDegree": damageState.effectDegree,
    "flags.fast-nri.attackType": attackType,
    "flags.fast-nri.applicationPhase": "final"
  });

  return {
    message,
    sourceMessage: message,
    defenseMessage: null,
    defenderToken,
    protectedToken,
    actionItem,
    actionName,
    roll: result.roll,
    result: defenseResult,
    damageState
  };
}

// Backward-compatible export for older callers/macros.
export async function selfDefenseFromChat(element) {
  return defenseFromChat(element);
}

export function damageApplicationTargets({ controlledTokens = [] } = {}) {
  // Application намеренно НЕ использует Foundry Targets и не восстанавливает
  // получателя из ActionContext/resultTargetUuid. Получатель определяется
  // только текущим ручным выделением Token в момент нажатия Apply.
  const controlled = Array.from(controlledTokens ?? []).filter(Boolean);
  const seen = new Set();

  return controlled.filter(token => {
    const key = token?.document?.uuid ?? token?.uuid ?? token?.id ?? token;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function currentDamageApplicationTargets() {
  const tokens = damageApplicationTargets({
    controlledTokens: canvas?.tokens?.controlled ?? []
  });

  if (!tokens.length) {
    ui.notifications.warn("Выдели один или несколько токенов, к которым нужно применить результат.");
  }

  return tokens;
}

function partMatchIds(part) {
  return new Set([
    part?.damageType === "magic" ? "magic" : "physical",
    ...(part?.traitIds ?? [])
  ]);
}

function actorResistanceEntries(actor) {
  const selected = new Set(actor?.system?.resistanceIds ?? []);
  const legacy = {
    universal: Number(actor?.system?.resistances?.universal) || 0,
    physical: Number(actor?.system?.resistances?.physical) || 0,
    magic: Number(actor?.system?.resistances?.magic) || 0
  };

  for (const [id, value] of Object.entries(legacy)) {
    if (value > 0) selected.add(id);
  }

  return Array.from(selected).map(id => ({
    id,
    label: RESISTANCE_TRAITS[id] ?? CREATURE_TRAITS[id] ?? id,
    value: Math.max(0, Number(actor?.system?.resistanceValues?.[id]) || legacy[id] || 0)
  })).filter(entry => entry.value > 0);
}

function actorVulnerabilityEntries(actor) {
  return Array.from(actor?.system?.vulnerabilityIds ?? []).map(id => ({
    id,
    label: CREATURE_TRAITS[id] ?? id,
    value: Math.max(0, Number(actor?.system?.vulnerabilityValues?.[id]) || 0)
  })).filter(entry => entry.value > 0);
}

export function resolveDamageAgainstActor(state, actor, multiplier = 1) {
  const safeMultiplier = multiplier === 2 ? 2 : 1;
  const sourceParts = (state?.parts ?? []).map(part => foundry.utils.deepClone(part));

  // Полная отмена Защитой прекращает нанесение урона целиком.
  // Никакие свойства старых частей не должны заново оживить урон
  // через Уязвимость при нажатии «Нанести».
  if (state?.fullCancel) {
    return {
      multiplier: safeMultiplier,
      sourceParts,
      survivingParts: [],
      immuneParts: [],
      activeMatchIds: [],
      partsTotal: 0,
      penalty: 0,
      afterPenalty: 0,
      afterMultiplier: 0,
      matchingResistances: [],
      matchingVulnerabilities: [],
      resistance: null,
      vulnerability: null,
      finalDamage: 0,
      fullCancel: true
    };
  }

  const immunityIds = new Set(actor?.system?.immunityIds ?? []);
  const survivingParts = [];
  const immuneParts = [];

  for (const part of sourceParts) {
    // Ручное исключение и профильное удаление означают, что части уже нет
    // в Application-пуле. Защитой исключённая часть численно не наносит
    // урон, но её свойства сохраняются по действующему правилу урона.
    if (part.manualRemoved || part.profileZeroed) continue;

    const matches = partMatchIds(part);
    const immunityId = Array.from(immunityIds).find(id => matches.has(id)) ?? null;

    if (immunityId) {
      part.immuneRemoved = true;
      part.immunityId = immunityId;
      immuneParts.push(part);
    } else {
      part.immuneRemoved = false;
      survivingParts.push(part);
    }
  }

  // После Иммунитетов НЕ создаются отдельные группы урона.
  // Все оставшиеся части формируют одно нанесение:
  // 1) их значения складываются в одну сумму;
  // 2) их типы и свойства объединяются в один набор совпадений;
  // 3) на ВСЁ нанесение выбирается ровно одна максимальная Устойчивость
  //    и ровно одна максимальная Уязвимость.
  //
  // Часть, исключённая Самозащитой, остаётся здесь и сохраняет свои
  // тип/свойства, но не участвует в числовой сумме. Поэтому она может
  // активировать Устойчивость или Уязвимость. Иммунитет удаляет её свойства.
  const activeMatchIds = new Set();
  for (const part of survivingParts) {
    for (const id of partMatchIds(part)) activeMatchIds.add(id);
  }

  const matchingResistances = actorResistanceEntries(actor)
    .filter(entry => entry.id === "universal"
      ? survivingParts.length > 0
      : activeMatchIds.has(entry.id))
    .sort((a, b) => b.value - a.value);

  const matchingVulnerabilities = actorVulnerabilityEntries(actor)
    .filter(entry => activeMatchIds.has(entry.id))
    .sort((a, b) => b.value - a.value);

  const resistance = matchingResistances[0] ?? null;
  const vulnerability = matchingVulnerabilities[0] ?? null;

  const partsTotal = survivingParts
    .filter(part => !part.defenseZeroed)
    .reduce(
      (sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0),
      0
    );

  const penalty = (state?.penalties ?? []).reduce(
    (sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0),
    0
  );

  const afterPenalty = Math.max(0, partsTotal - penalty);
  const afterMultiplier = afterPenalty * safeMultiplier;

  // Устойчивость и Уязвимость применяются ОДИН РАЗ ко всей сумме
  // оставшегося нанесения, а не отдельно к кубам, типам или группам.
  //
  // Устойчивость сначала снижает сумму минимум до 0.
  // Уязвимость применяется после неё и может снова создать положительный
  // урон, даже если Защиты/Устойчивость снизили числовую сумму до 0.
  const afterResistance = Math.max(0, afterMultiplier - (resistance?.value ?? 0));
  const finalDamage = Math.max(0, afterResistance + (vulnerability?.value ?? 0));

  return {
    multiplier: safeMultiplier,
    sourceParts,
    survivingParts,
    immuneParts,
    activeMatchIds: Array.from(activeMatchIds),
    partsTotal,
    penalty,
    afterPenalty,
    afterMultiplier,
    matchingResistances,
    matchingVulnerabilities,
    resistance,
    vulnerability,
    finalDamage,
    fullCancel: false
  };
}

function damageResolutionHTML(resolution, { tempAbsorbed = 0, hpLost = 0 } = {}) {
  const immuneRows = (resolution?.immuneParts ?? []).map(part => {
    const immunityId = part.immunityId;
    const label = CREATURE_TRAITS[immunityId] ?? immunityId;
    return `<div>Иммунитет: <strong>${esc(label)}</strong> — ${esc(damagePartLabel(part))} удалён</div>`;
  }).join("");

  return `
    <div class="fast-nri-damage-resolution">
      ${immuneRows}
      <div>После Защит и Иммунитетов: <strong>${esc(resolution.afterPenalty)}</strong></div>
      ${resolution.multiplier === 2 ? `<div>Крит ×2: <strong>${esc(resolution.afterMultiplier)}</strong></div>` : ""}
      ${resolution.resistance ? `<div>Лучшая Устойчивость на всё нанесение: <strong>${esc(resolution.resistance.label)} −${esc(resolution.resistance.value)}</strong></div>` : ""}
      ${resolution.vulnerability ? `<div>Лучшая Уязвимость на всё нанесение: <strong>${esc(resolution.vulnerability.label)} +${esc(resolution.vulnerability.value)}</strong></div>` : ""}
      <div>Итоговый урон: <strong>${esc(resolution.finalDamage)}</strong></div>
      ${tempAbsorbed > 0 ? `<div>Временные HP: <strong>−${esc(tempAbsorbed)}</strong></div>` : ""}
      ${hpLost > 0 ? `<div>Обычные HP: <strong>−${esc(hpLost)}</strong></div>` : ""}
    </div>
  `;
}

function applicationEffectOperationHTML(operations = []) {
  if (!operations.length) return "";
  const rows = operations.map(operation => {
    const status = operation.applied
      ? operation.created ? "наложен" : "обновлён"
      : `не применён${operation.reason ? `: ${operation.reason}` : ""}`;
    return `<div><strong>${esc(operation.name || "Effect")}</strong> — ${esc(status)}</div>`;
  }).join("");
  return `<section class="fast-nri-application-effect-result"><div class="fast-nri-damage-parts-title">Эффекты</div>${rows}</section>`;
}

async function applyApplicationEffectsToActor(effectUuids, actor, actionContext) {
  const operations = [];
  for (const uuid of Array.from(new Set(effectUuids ?? [])).filter(Boolean)) {
    let sourceEffect = null;
    try { sourceEffect = await fromUuid(uuid); }
    catch (error) { console.warn(`Быстрая НРИ | Не удалось найти Effect ${uuid}`, error); }
    if (!sourceEffect || sourceEffect.type !== "effect") {
      operations.push({ sourceEffectUuid: uuid, name: uuid, applied: false, reason: "источник не найден" });
      continue;
    }

    const before = new Map(
      Array.from(actor?.items ?? [])
        .filter(item => item?.type === "effect")
        .map(item => [item.id, foundry.utils.deepClone(item.toObject())])
    );

    let embedded = null;
    try {
      embedded = await applyEffectToActor(sourceEffect, actor, { actionContext });
    } catch (error) {
      console.error("Быстрая НРИ | Ошибка применения Effect в Application transaction", error);
    }

    if (!embedded) {
      operations.push({ sourceEffectUuid: uuid, name: sourceEffect.name, applied: false, reason: "условия применения не выполнены" });
      continue;
    }

    const beforeSnapshot = before.get(embedded.id) ?? null;
    operations.push({
      sourceEffectUuid: uuid,
      name: sourceEffect.name,
      applied: true,
      embeddedEffectId: embedded.id,
      created: !beforeSnapshot,
      beforeSnapshot,
      afterSnapshot: foundry.utils.deepClone(embedded.toObject())
    });
  }
  return operations;
}

async function undoApplicationEffects(actor, operations = []) {
  const results = [];
  for (const operation of [...operations].reverse()) {
    if (!operation?.applied || !operation.embeddedEffectId) continue;
    const embedded = actor?.items?.get?.(operation.embeddedEffectId)
      ?? Array.from(actor?.items ?? []).find(item => item.id === operation.embeddedEffectId)
      ?? null;
    try {
      if (operation.created) {
        if (embedded) await embedded.delete();
        results.push({ ...operation, undone: true });
      } else if (embedded && operation.beforeSnapshot) {
        await embedded.update({
          name: operation.beforeSnapshot.name,
          img: operation.beforeSnapshot.img,
          system: foundry.utils.deepClone(operation.beforeSnapshot.system ?? {}),
          flags: foundry.utils.deepClone(operation.beforeSnapshot.flags ?? {})
        });
        results.push({ ...operation, undone: true });
      }
    } catch (error) {
      console.error("Быстрая НРИ | Ошибка Undo Effect Application", error);
      results.push({ ...operation, undone: false });
    }
  }
  return results;
}

function appliedDamageMessageContent({
  tokenName,
  damage,
  tokenUuid,
  actorUuid,
  previousHp,
  afterHp,
  previousTemp = 0,
  afterTemp = 0,
  appliedToHp = 0,
  appliedToTemp = 0,
  resolutionHTML = "",
  effectOperations = [],
  hasDamage = true,
  undone = false
}) {
  return `
    <div class="fast-nri-applied-damage-message ${undone ? "undone" : ""}">
      <div class="fast-nri-applied-damage-text">
        <i class="fa-solid ${hasDamage ? "fa-heart-crack" : "fa-wand-magic-sparkles"}"></i>
        <span>
          <strong>${esc(tokenName)}</strong>
          ${hasDamage ? `получает <strong>${esc(damage)}</strong> урона` : "получает результат действия"}
        </span>
      </div>

      ${resolutionHTML}
      ${applicationEffectOperationHTML(effectOperations)}

      ${undone ? "" : `
        <button
          type="button"
          class="fast-nri-undo-damage-button"
          data-fast-nri-undo-damage
          data-token-uuid="${escAttr(tokenUuid)}"
          data-actor-uuid="${escAttr(actorUuid)}"
          data-previous-hp="${escAttr(previousHp)}"
          data-after-hp="${escAttr(afterHp)}"
          data-previous-temp="${escAttr(previousTemp)}"
          data-after-temp="${escAttr(afterTemp)}"
          data-applied-to-hp="${escAttr(appliedToHp)}"
          data-applied-to-temp="${escAttr(appliedToTemp)}"
          data-damage="${escAttr(damage)}"
          title="Отменить нанесение урона"
          aria-label="Отменить нанесение урона"
        >
          <i class="fa-solid fa-rotate-left"></i>
        </button>
      `}
    </div>
  `;
}

export async function applyDamageFromChat(element) {
  const fallbackDamage = Number(element?.dataset?.damage);
  const multiplier = Number(element?.dataset?.multiplier) === 2 ? 2 : 1;
  const sourceMessage = chatMessageFromElement(element);
  const tokens = currentDamageApplicationTargets();
  if (!tokens.length) return null;

  const supersededBy = sourceMessage?.getFlag("fast-nri", "supersededByDamageMessageId") ?? null;
  if (supersededBy) {
    ui.notifications.warn(
      "У этой Result/Application Card есть более новая ревизия. Применение не блокируется; проверьте, что выбрана нужная карточка."
    );
  }

  const damageState = sourceMessage?.getFlag("fast-nri", "damageState") ?? null;
  const applicationEffectUuids = Array.from(
    sourceMessage?.getFlag("fast-nri", "applicationEffectUuids") ?? []
  );
  const sourceActionContext = actionContextFromMessage(sourceMessage);
  const hasDamage = Boolean(
    damageState?.supported
    || (Number.isFinite(fallbackDamage) && fallbackDamage >= 0)
  );

  if (!hasDamage && !applicationEffectUuids.length) {
    ui.notifications.error("В карточке нет структурированного результата для применения.");
    return null;
  }

  const applied = [];

  for (const token of tokens) {
    const actor = token?.actor;
    if (!actor) {
      ui.notifications.warn(`${token?.name ?? "Выбранная цель"}: у токена нет Actor; цель пропущена.`);
      continue;
    }

    let resolution = null;
    if (damageState?.supported) {
      resolution = resolveDamageAgainstActor(damageState, actor, multiplier);
    } else if (hasDamage) {
      resolution = {
        multiplier,
        sourceParts: [], survivingParts: [], immuneParts: [], activeMatchIds: [],
        partsTotal: fallbackDamage / multiplier, penalty: 0,
        afterPenalty: fallbackDamage / multiplier, afterMultiplier: fallbackDamage,
        matchingResistances: [], matchingVulnerabilities: [],
        resistance: null, vulnerability: null,
        finalDamage: fallbackDamage, fullCancel: false
      };
    }

    const previousHp = Number(actor.system?.hp?.value);
    const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
    if (!Number.isFinite(previousHp)) {
      ui.notifications.warn(`${token?.name ?? actor.name ?? "Выбранная цель"}: нет корректного значения HP; цель пропущена.`);
      continue;
    }

    const finalDamage = hasDamage ? Math.max(0, Number(resolution?.finalDamage) || 0) : 0;
    const appliedToTemp = Math.min(previousTemp, finalDamage);
    const remainingAfterTemp = Math.max(0, finalDamage - appliedToTemp);
    const afterTemp = Math.max(0, previousTemp - appliedToTemp);
    const afterHp = Math.max(0, previousHp - remainingAfterTemp);
    const appliedToHp = previousHp - afterHp;
    const appliedDamage = appliedToTemp + appliedToHp;

    if (hasDamage) {
      try {
        await actor.update({
          "system.hp.temp": afterTemp,
          "system.hp.value": afterHp
        }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
      } catch (error) {
        console.error("Быстрая НРИ | Ошибка нанесения урона", error);
        ui.notifications.warn(`${token?.name ?? actor.name ?? "Выбранная цель"}: не удалось изменить HP; цель пропущена.`);
        continue;
      }
    }

    const targetActionContext = sourceActionContext
      ? deriveActionContext(sourceActionContext, {
          targets: [token],
          parentMessageId: sourceMessage?.id ?? null
        })
      : null;
    const effectOperations = await applyApplicationEffectsToActor(
      applicationEffectUuids,
      actor,
      targetActionContext
    );

    const tokenUuid = tokenDocumentUuid(token) ?? "";
    const actorUuid = actor.uuid;
    const tokenName = token.name || actor.name || "Цель";
    const resolutionHTML = hasDamage
      ? damageResolutionHTML(resolution, { tempAbsorbed: appliedToTemp, hpLost: appliedToHp })
      : "";

    const content = appliedDamageMessageContent({
      tokenName,
      damage: finalDamage,
      tokenUuid,
      actorUuid,
      previousHp,
      afterHp,
      previousTemp,
      afterTemp,
      appliedToHp,
      appliedToTemp,
      resolutionHTML,
      effectOperations,
      hasDamage
    });

    const message = await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor, token: token.document ?? token }),
      content,
      flags: {
        "fast-nri": {
          kind: applicationEffectUuids.length ? "application-applied" : "damage-applied",
          tokenUuid, actorUuid, tokenName,
          requestedDamage: finalDamage,
          appliedDamage, appliedToHp, appliedToTemp,
          previousHp, afterHp, previousTemp, afterTemp,
          multiplier,
          resolution,
          applicationEffectUuids,
          applicationEffectOperations: effectOperations,
          actionContext: targetActionContext,
          undone: false
        }
      }
    });

    applied.push({
      message, token, actor,
      requestedDamage: finalDamage,
      appliedDamage, appliedToHp, appliedToTemp,
      previousHp, afterHp, previousTemp, afterTemp,
      resolution, effectOperations
    });
  }

  if (!applied.length) return null;
  if (applied.length === 1) return { ...applied[0], applied, count: 1 };
  return { applied, count: applied.length };
}

async function resolveDamageActor({ tokenUuid, actorUuid }) {
  if (tokenUuid) {
    try {
      const tokenDocument = await fromUuid(tokenUuid);
      if (tokenDocument?.actor) return tokenDocument.actor;
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось получить Token по UUID", error);
    }
  }

  if (actorUuid) {
    try {
      const actor = await fromUuid(actorUuid);
      if (actor) return actor;
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось получить Actor по UUID", error);
    }
  }

  return null;
}

function messageIdFromElement(element) {
  return element
    ?.closest(".chat-message, .message")
    ?.dataset?.messageId ?? null;
}

export async function undoAppliedDamage(element) {
  const messageId = messageIdFromElement(element);
  const message = messageId ? game.messages?.get(messageId) : null;

  const stored = ["damage-applied", "application-applied"].includes(message?.getFlag("fast-nri", "kind"))
    ? {
        tokenUuid: message.getFlag("fast-nri", "tokenUuid"),
        actorUuid: message.getFlag("fast-nri", "actorUuid"),
        tokenName: message.getFlag("fast-nri", "tokenName"),
        requestedDamage: Number(
          message.getFlag("fast-nri", "requestedDamage")
          ?? message.getFlag("fast-nri", "damage")
        ),
        appliedDamage: Number(
          message.getFlag("fast-nri", "appliedDamage")
          ?? (
            Number(message.getFlag("fast-nri", "previousHp"))
            - Number(message.getFlag("fast-nri", "afterHp"))
          )
        ),
        previousHp: Number(message.getFlag("fast-nri", "previousHp")),
        afterHp: Number(message.getFlag("fast-nri", "afterHp")),
        previousTemp: Number(message.getFlag("fast-nri", "previousTemp")) || 0,
        afterTemp: Number(message.getFlag("fast-nri", "afterTemp")) || 0,
        appliedToHp: Number(message.getFlag("fast-nri", "appliedToHp")) || Number(message.getFlag("fast-nri", "appliedDamage")) || 0,
        appliedToTemp: Number(message.getFlag("fast-nri", "appliedToTemp")) || 0,
        resolution: message.getFlag("fast-nri", "resolution") ?? null,
        effectOperations: Array.from(message.getFlag("fast-nri", "applicationEffectOperations") ?? []),
        undone: Boolean(message.getFlag("fast-nri", "undone"))
      }
    : {
        tokenUuid: element?.dataset?.tokenUuid ?? "",
        actorUuid: element?.dataset?.actorUuid ?? "",
        tokenName: "Цель",
        requestedDamage: Number(element?.dataset?.damage),
        appliedDamage: Number(element?.dataset?.damage),
        previousHp: Number(element?.dataset?.previousHp),
        afterHp: Number(element?.dataset?.afterHp),
        previousTemp: Number(element?.dataset?.previousTemp) || 0,
        afterTemp: Number(element?.dataset?.afterTemp) || 0,
        appliedToHp: Number(element?.dataset?.appliedToHp) || Number(element?.dataset?.damage) || 0,
        appliedToTemp: Number(element?.dataset?.appliedToTemp) || 0,
        resolution: null,
        effectOperations: [],
        undone: false
      };

  if (stored.undone) {
    ui.notifications.info("Это нанесение урона уже отменено.");
    return null;
  }

  if (!Number.isFinite(stored.appliedDamage) || stored.appliedDamage < 0) {
    ui.notifications.error("Не удалось определить фактически нанесённый урон.");
    return null;
  }

  const actor = await resolveDamageActor(stored);
  if (!actor) {
    ui.notifications.error("Не удалось найти персонажа для отмены урона.");
    return null;
  }

  const currentHp = Number(actor.system?.hp?.value);
  const currentTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);
  if (!Number.isFinite(currentHp)) {
    ui.notifications.error("Не удалось определить текущее HP.");
    return null;
  }

  const maxHp = Number(actor.system?.hp?.max);
  let restoredHp = currentHp + Math.max(0, Number(stored.appliedToHp) || 0);
  if (Number.isFinite(maxHp)) restoredHp = Math.min(maxHp, restoredHp);
  restoredHp = Math.max(0, restoredHp);

  const tempRemovedByThisDamage = Math.max(0, Number(stored.appliedToTemp) || 0);

  // Временные HP не складываются. Если после этого урона цель уже получила
  // более высокое новое значение временных HP, старый Undo не имеет права
  // прибавить к нему снятые ранее временные HP.
  const newerTempGrantDetected = currentTemp > Math.max(0, Number(stored.afterTemp) || 0);
  const restoredTemp = newerTempGrantDetected
    ? currentTemp
    : currentTemp + tempRemovedByThisDamage;

  const restoredHpAmount = Math.max(0, restoredHp - currentHp);
  const restoredTempAmount = Math.max(0, restoredTemp - currentTemp);
  const restoredAmount = restoredHpAmount + restoredTempAmount;

  if (newerTempGrantDetected && tempRemovedByThisDamage > 0) {
    ui.notifications.info(
      "Обычные HP возвращены. Старые временные HP не восстановлены, потому что после этого урона цель получила более высокое значение временных HP."
    );
  }

  try {
    await actor.update({
      "system.hp.value": restoredHp,
      "system.hp.temp": restoredTemp
    }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка отмены урона", error);
    ui.notifications.error("Не удалось вернуть HP.");
    return null;
  }

  const effectUndoResults = await undoApplicationEffects(actor, stored.effectOperations ?? []);

  if (message) {
    const displayDamage = Number.isFinite(stored.requestedDamage)
      ? stored.requestedDamage
      : stored.appliedDamage;

    const content = appliedDamageMessageContent({
      tokenName: stored.tokenName || actor.name || "Цель",
      damage: displayDamage,
      tokenUuid: stored.tokenUuid,
      actorUuid: stored.actorUuid,
      previousHp: stored.previousHp,
      afterHp: stored.afterHp,
      previousTemp: stored.previousTemp,
      afterTemp: stored.afterTemp,
      appliedToHp: stored.appliedToHp,
      appliedToTemp: stored.appliedToTemp,
      resolutionHTML: stored.resolution ? damageResolutionHTML(stored.resolution, {
        tempAbsorbed: stored.appliedToTemp,
        hpLost: stored.appliedToHp
      }) : "",
      effectOperations: (stored.effectOperations ?? []).map(operation => ({ ...operation, applied: false, reason: "отменено" })),
      hasDamage: Boolean(stored.resolution) || stored.requestedDamage > 0 || stored.appliedDamage > 0,
      undone: true
    });

    try {
      await message.update({
        content,
        "flags.fast-nri.undone": true,
        "flags.fast-nri.applicationEffectUndoResults": effectUndoResults,
        "flags.fast-nri.restoredHp": restoredHp,
        "flags.fast-nri.restoredAmount": restoredAmount,
        "flags.fast-nri.restoredHpAmount": restoredHpAmount,
        "flags.fast-nri.restoredTempAmount": restoredTempAmount,
        "flags.fast-nri.restoredTemp": restoredTemp
      });
    } catch (error) {
      console.warn("Быстрая НРИ | HP возвращены, но сообщение не удалось обновить", error);
    }
  } else {
    element.disabled = true;
  }

  return {
    actor,
    restoredHp,
    restoredAmount
  };
}

export function activateChatInteractions(root = document) {
  root.addEventListener("click", async event => {
    const damageProfileButton = event.target.closest("[data-fast-nri-damage]");
    if (damageProfileButton) {
      event.preventDefault();
      event.stopPropagation();

      if (damageProfileButton.dataset.fastNriBusy === "true") return;
      damageProfileButton.dataset.fastNriBusy = "true";

      try {
        await rollDamageFromChat(damageProfileButton);
      } finally {
        delete damageProfileButton.dataset.fastNriBusy;
      }

      return;
    }

    const undoInlineDefenseResourceButton = event.target.closest("[data-fast-nri-undo-inline-defense-resource]");
    if (undoInlineDefenseResourceButton) {
      event.preventDefault();
      event.stopPropagation();

      if (undoInlineDefenseResourceButton.dataset.fastNriBusy === "true") return;
      undoInlineDefenseResourceButton.dataset.fastNriBusy = "true";

      try {
        await undoInlineDefenseResource(undoInlineDefenseResourceButton);
      } finally {
        delete undoInlineDefenseResourceButton.dataset.fastNriBusy;
      }

      return;
    }

    const undoDefenseResourceButton = event.target.closest("[data-fast-nri-undo-defense-resource]");
    if (undoDefenseResourceButton) {
      event.preventDefault();
      event.stopPropagation();

      if (undoDefenseResourceButton.dataset.fastNriBusy === "true") return;
      undoDefenseResourceButton.dataset.fastNriBusy = "true";

      try {
        await undoDefenseResource(undoDefenseResourceButton);
      } finally {
        delete undoDefenseResourceButton.dataset.fastNriBusy;
      }

      return;
    }

    const defenseStepRerollButton = event.target.closest("[data-fast-nri-defense-step-reroll]");
    if (defenseStepRerollButton) {
      event.preventDefault();
      event.stopPropagation();
      if (defenseStepRerollButton.dataset.fastNriBusy === "true") return;
      defenseStepRerollButton.dataset.fastNriBusy = "true";
      try { await multiTargetDefenseStepRerollFromChat(defenseStepRerollButton); }
      finally { delete defenseStepRerollButton.dataset.fastNriBusy; }
      return;
    }

    const defenseStepUndoButton = event.target.closest("[data-fast-nri-defense-step-undo]");
    if (defenseStepUndoButton) {
      event.preventDefault();
      event.stopPropagation();
      if (defenseStepUndoButton.dataset.fastNriBusy === "true") return;
      defenseStepUndoButton.dataset.fastNriBusy = "true";
      try { await multiTargetDefenseStepUndoFromChat(defenseStepUndoButton); }
      finally { delete defenseStepUndoButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetDefenseButton = event.target.closest("[data-fast-nri-multitarget-defense]");
    if (multiTargetDefenseButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetDefenseButton.dataset.fastNriBusy === "true") return;
      multiTargetDefenseButton.dataset.fastNriBusy = "true";
      try { await multiTargetDefenseFromChat(multiTargetDefenseButton); }
      finally { delete multiTargetDefenseButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetDegreeButton = event.target.closest("[data-fast-nri-multitarget-degree-menu]");
    if (multiTargetDegreeButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetDegreeButton.dataset.fastNriBusy === "true") return;
      multiTargetDegreeButton.dataset.fastNriBusy = "true";
      try { await multiTargetDegreeMenuFromChat(multiTargetDegreeButton); }
      finally { delete multiTargetDegreeButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetRemoveButton = event.target.closest("[data-fast-nri-multitarget-remove-target]");
    if (multiTargetRemoveButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetRemoveButton.dataset.fastNriBusy === "true") return;
      multiTargetRemoveButton.dataset.fastNriBusy = "true";
      try { await multiTargetRemoveTargetFromChat(multiTargetRemoveButton); }
      finally { delete multiTargetRemoveButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetAddButton = event.target.closest("[data-fast-nri-multitarget-add-targets]");
    if (multiTargetAddButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetAddButton.dataset.fastNriBusy === "true") return;
      multiTargetAddButton.dataset.fastNriBusy = "true";
      try { await multiTargetAddTargetsFromChat(multiTargetAddButton); }
      finally { delete multiTargetAddButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetAddControlledButton = event.target.closest("[data-fast-nri-multitarget-add-controlled]");
    if (multiTargetAddControlledButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetAddControlledButton.dataset.fastNriBusy === "true") return;
      multiTargetAddControlledButton.dataset.fastNriBusy = "true";
      try { await multiTargetAddControlledFromChat(multiTargetAddControlledButton); }
      finally { delete multiTargetAddControlledButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetApplyDefensesButton = event.target.closest("[data-fast-nri-multitarget-apply-defenses]");
    if (multiTargetApplyDefensesButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetApplyDefensesButton.dataset.fastNriBusy === "true") return;
      multiTargetApplyDefensesButton.dataset.fastNriBusy = "true";
      try { await multiTargetApplyDefensesFromChat(multiTargetApplyDefensesButton); }
      finally { delete multiTargetApplyDefensesButton.dataset.fastNriBusy; }
      return;
    }

    const multiTargetApplyResultsButton = event.target.closest("[data-fast-nri-multitarget-apply-results]");
    if (multiTargetApplyResultsButton) {
      event.preventDefault();
      event.stopPropagation();
      if (multiTargetApplyResultsButton.dataset.fastNriBusy === "true") return;
      multiTargetApplyResultsButton.dataset.fastNriBusy = "true";
      try { await multiTargetApplyResultsFromChat(multiTargetApplyResultsButton); }
      finally { delete multiTargetApplyResultsButton.dataset.fastNriBusy; }
      return;
    }

    const checkDefenseButton = event.target.closest("[data-fast-nri-check-defense]");
    if (checkDefenseButton) {
      event.preventDefault();
      event.stopPropagation();

      if (checkDefenseButton.dataset.fastNriBusy === "true") return;
      checkDefenseButton.dataset.fastNriBusy = "true";

      try {
        await checkDefenseFromChat(checkDefenseButton);
      } finally {
        delete checkDefenseButton.dataset.fastNriBusy;
      }

      return;
    }

    const defenseButton = event.target.closest("[data-fast-nri-defense]");
    if (defenseButton) {
      event.preventDefault();
      event.stopPropagation();

      if (defenseButton.dataset.fastNriBusy === "true") return;
      defenseButton.dataset.fastNriBusy = "true";

      try {
        await defenseFromChat(defenseButton);
      } finally {
        delete defenseButton.dataset.fastNriBusy;
      }

      return;
    }

    const removeDamageDieButton = event.target.closest("[data-fast-nri-damage-remove-die]");
    if (removeDamageDieButton) {
      event.preventDefault();
      event.stopPropagation();

      if (removeDamageDieButton.dataset.fastNriBusy === "true") return;
      removeDamageDieButton.dataset.fastNriBusy = "true";

      try {
        await removeDamageDieFromChat(removeDamageDieButton);
      } finally {
        delete removeDamageDieButton.dataset.fastNriBusy;
      }

      return;
    }

    const restoreDamageDieButton = event.target.closest("[data-fast-nri-damage-restore-die]");
    if (restoreDamageDieButton) {
      event.preventDefault();
      event.stopPropagation();
      if (restoreDamageDieButton.dataset.fastNriBusy === "true") return;
      restoreDamageDieButton.dataset.fastNriBusy = "true";
      try { await restoreDamageDieFromChat(restoreDamageDieButton); }
      finally { delete restoreDamageDieButton.dataset.fastNriBusy; }
      return;
    }

    const rerollDamageDieButton = event.target.closest("[data-fast-nri-damage-reroll-die]");
    if (rerollDamageDieButton) {
      event.preventDefault();
      event.stopPropagation();
      if (rerollDamageDieButton.dataset.fastNriBusy === "true") return;
      rerollDamageDieButton.dataset.fastNriBusy = "true";
      try { await rerollDamageDieFromChat(rerollDamageDieButton); }
      finally { delete rerollDamageDieButton.dataset.fastNriBusy; }
      return;
    }

    const addDamageButton = event.target.closest("[data-fast-nri-damage-add]");
    if (addDamageButton) {
      event.preventDefault();
      event.stopPropagation();

      if (addDamageButton.dataset.fastNriBusy === "true") return;
      addDamageButton.dataset.fastNriBusy = "true";

      try {
        await addDamageFromChat(addDamageButton);
      } finally {
        delete addDamageButton.dataset.fastNriBusy;
      }

      return;
    }

    const applyResultButton = event.target.closest("[data-fast-nri-apply-result]");
    if (applyResultButton) {
      event.preventDefault();
      event.stopPropagation();
      if (applyResultButton.dataset.fastNriBusy === "true") return;
      applyResultButton.dataset.fastNriBusy = "true";
      try { await applyDamageFromChat(applyResultButton); }
      finally { delete applyResultButton.dataset.fastNriBusy; }
      return;
    }

    const applyDamageButton = event.target.closest("[data-fast-nri-apply-damage]");
    if (applyDamageButton) {
      event.preventDefault();
      event.stopPropagation();

      if (applyDamageButton.dataset.fastNriBusy === "true") return;
      applyDamageButton.dataset.fastNriBusy = "true";

      try {
        await applyDamageFromChat(applyDamageButton);
      } finally {
        delete applyDamageButton.dataset.fastNriBusy;
      }

      return;
    }

    const undoDamageButton = event.target.closest("[data-fast-nri-undo-damage]");
    if (undoDamageButton) {
      event.preventDefault();
      event.stopPropagation();

      if (undoDamageButton.dataset.fastNriBusy === "true") return;
      undoDamageButton.dataset.fastNriBusy = "true";

      try {
        await undoAppliedDamage(undoDamageButton);
      } finally {
        delete undoDamageButton.dataset.fastNriBusy;
      }
    }
  });
}
