import { HP_FEEDBACK_SUPPRESS_OPTION } from "./hp-feedback.mjs";
import {
  CREATURE_TRAITS,
  HP_GAIN_DEFENSE_TRAITS,
  HP_GAIN_SOURCE_TRAITS,
  ITEM_PROPERTY_IDS,
  RESISTANCE_TRAITS
} from "./config.mjs";
import {
  defenseAbilityItems,
  defenseActionConfig,
  defenseCostLabel,
  evaluateDefenseAbility,
  resolveDefenseCombatSource
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
  inferAbilityAttackTypeFromDescription,
  inferWeaponAttackType,
  normalizeAttackType
} from "./attack-types.mjs";

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

function actionTargetStateHTML(state) {
  if (!state?.offGuard) return "";

  if (state.surrounding?.surrounded) {
    return `
      <div class="fast-nri-chat-target-state fast-nri-chat-target-surrounded">
        <i class="fa-solid fa-users"></i>
        <div>
          <strong>Цель окружена</strong>
          <small>Угрозы ${esc(state.surrounding.threats)} &gt; Строй ${esc(state.surrounding.formation)} · Застигнута врасплох · КЗ −2</small>
        </div>
      </div>
    `;
  }

  return `
    <div class="fast-nri-chat-target-state fast-nri-chat-target-off-guard">
      <i class="fa-solid fa-shield-halved"></i>
      <div>
        <strong>Цель застигнута врасплох</strong>
        <small>КЗ −2</small>
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
  const combatDie = String(actor.system?.combatDie ?? "").trim();
  const baseFormula = combatDie ? `1d20 + ${combatDie}` : "1d20";
  const target = getSingleTarget();
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
      ...(combatDie ? [{ formula: combatDie, label: "Куб боя", reason: actor.name }] : [])
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

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-attack-card">
      ${rollCardHeader("Попадание", "fa-swords")}
      ${attackResultHTML(weapon, target, degree, result.roll.total)}
      <div class="fast-nri-attack-type"><small>Вид атаки: <strong>${esc(attackTypeLabel(attackType))}</strong></small></div>
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

  await result.roll.toMessage({
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
    attackType
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

function recalculateDamageState(state) {
  const next = foundry.utils.deepClone(state);

  if (next.fullCancel) {
    next.currentBaseTotal = 0;
    next.currentTotal = 0;
    return next;
  }

  const positive = (next.parts ?? [])
    .filter(part => !part.immuneRemoved)
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
  const valueText = current === original ? `${original}` : `${original} → ${current}`;
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

function damagePartsHTML(state) {
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
    const changed = current !== original;
    const statusClass = part.immuneRemoved
      ? "immune-removed"
      : part.defenseZeroed
        ? "defense-zeroed"
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

  return `
    <section class="fast-nri-damage-parts-block">
      <div class="fast-nri-damage-parts-title">Кубы урона</div>
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

function defenseResultLabel(result) {
  if (result === "full-cancel") return "Полная отмена";
  if (result === "success") return "Успех";
  if (result === "failure") return "Провал";
  return "";
}

function defenseSummaryHTML(state) {
  const defense = state?.defense;
  if (!defense) return "";

  const actionName = defense.actionName || "Самозащита";
  const removedParts = Array.isArray(defense.removedParts)
    ? defense.removedParts
    : defense.removedPart
      ? [defense.removedPart]
      : [];
  const beforeDegree = defense.effectDegreeBefore;
  const afterDegree = defense.effectDegreeAfter;
  const protectedName = defense.protectedTokenName ?? null;

  return `
    <section class="fast-nri-self-defense-summary fast-nri-self-defense-${escAttr(defense.result)}">
      <div class="fast-nri-self-defense-heading">
        <i class="fa-solid fa-shield-halved"></i>
        <strong>${esc(actionName)} — ${esc(defenseResultLabel(defense.result))}</strong>
      </div>

      <small>
        ${esc(defense.tokenName)}:
        ${esc(defense.total)}
        против исходного результата
        ${esc(defense.attackTotal)}
        ${defense.kind === "ally-defense" && protectedName
          ? `· защищает ${esc(protectedName)}`
          : ""
        }
      </small>

      ${removedParts.length ? `
        <div>
          Обнулено частей урона:
          <strong>${removedParts.map(part => esc(damagePartLabel(part))).join(", ")}</strong>
        </div>
      ` : ""}

      ${beforeDegree && afterDegree && beforeDegree !== afterDegree ? `
        <div>
          Степень Эффекта:
          <strong>${esc(DEGREE_LABELS[beforeDegree] ?? beforeDegree)}</strong>
          →
          <strong>${esc(DEGREE_LABELS[afterDegree] ?? afterDegree)}</strong>
        </div>
      ` : ""}

      ${defense.result === "full-cancel" ? `
        <div><strong>Исходное действие против защищаемой цели считается Провалом.</strong></div>
      ` : ""}
    </section>
  `;
}

function damageCardHTML({
  weaponName,
  sourceName = weaponName,
  profileLabel,
  critical = false,
  state,
  modifiersHTML = "",
  allowDefense = true,
  allowDouble = true
}) {
  const baseDamage = Math.max(0, Number(state?.currentTotal) || 0);
  const doubledDamage = baseDamage * 2;

  return `
    <div class="fast-nri-chat-roll fast-nri-damage-card">
      ${rollCardHeader(`Урон: ${sourceName}`, "fa-burst")}

      <div class="fast-nri-chat-damage-profile-name">
        ${esc(profileLabel)}
      </div>

      ${damagePartsHTML(state)}
      ${defenseSummaryHTML(state)}

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
          ${state.fullCancel ? "disabled" : ""}
          title="${state.fullCancel
            ? "Действие полностью отменено"
            : `Нанести ${escAttr(baseDamage)} урона выделенному токену`
          }"
        >
          <i class="fa-solid fa-heart-crack"></i>
          <span>${state.fullCancel ? "Урон отменён" : "Нанести"}</span>
        </button>

        ${allowDouble ? `
          <button
            type="button"
            class="fast-nri-apply-damage-button fast-nri-apply-damage-x2"
            data-fast-nri-apply-damage
            data-damage="${escAttr(doubledDamage)}"
            data-multiplier="2"
            ${state.fullCancel ? "disabled" : ""}
            title="${state.fullCancel
              ? "Действие полностью отменено"
              : `Нанести ${escAttr(doubledDamage)} урона (×2)`
            }"
          >
            <i class="fa-solid fa-xmark"></i>
            <span>${state.fullCancel ? "×2 отменён" : "Нанести ×2"}</span>
          </button>
        ` : ""}
      </div>

      ${modifiersHTML}
    </div>
  `;
}

async function chooseDamagePart(parts, mode = "largest", actionName = "Защита") {
  const active = (parts ?? []).filter(part => !part.immuneRemoved && (Number(part.currentValue ?? part.value) || 0) > 0);
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
        !candidate.immuneRemoved
        && (Number(candidate.currentValue ?? candidate.value) || 0) > 0
      );
      if (stillAvailable) return null;
      break;
    }

    selected.push(part);
    const found = working.find(candidate => candidate.id === part.id);
    if (found) {
      found.currentValue = 0;
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

function abilityOutcomeChannel(item, kind) {
  const modern = item?.system?.outcomes?.[kind] ?? null;
  const legacy = item?.system?.outcome ?? null;

  // Backward-compatible read of items configured in 0.5.16.
  const legacyMatches = String(legacy?.kind ?? "none") === kind;
  const modernComponents = Array.from(modern?.components ?? []);
  const legacyComponents = legacyMatches
    ? Array.from(legacy?.components ?? [])
    : [];

  return {
    enabled: Boolean(modern?.enabled) || legacyMatches,
    components: modernComponents.length ? modernComponents : legacyComponents
  };
}

function abilityOutcomeComponents(actor, item, kind) {
  const channel = abilityOutcomeChannel(item, kind);
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


function expandAbilityAttackFormula(actor, rawFormula) {
  const combatDie = String(actor?.system?.combatDie ?? "").trim();
  const replacement = combatDie || "0";
  const formula = String(rawFormula ?? "1d20 + {combatDie}")
    .replaceAll("{combatDie}", replacement)
    .replaceAll("@combatDie", replacement)
    .trim();

  return formula || "1d20";
}

function abilityAttackFormulaSources(actor, rawFormula, expandedFormula) {
  const raw = String(rawFormula ?? "").trim();

  if (raw.includes("{combatDie}") || raw.includes("@combatDie")) {
    const combatDie = String(actor?.system?.combatDie ?? "").trim();
    return [
      {
        formula: expandedFormula,
        label: "Атака против КЗ",
        reason: combatDie
          ? `Формула способности; Куб боя ${combatDie}`
          : "Формула способности; Куб боя отсутствует"
      }
    ];
  }

  return [{
    formula: expandedFormula,
    label: "Атака против КЗ",
    reason: "Формула способности/заклинания"
  }];
}

export async function rollAbilityAttackCheck(actor, item) {
  if (!actor || !item || item.type !== "ability") return null;

  const config = item.system?.attackCheck ?? {};
  if (!config.enabled) return null;

  const attackType = normalizeAttackType(config.attackType)
    || inferAbilityAttackTypeFromDescription(item.system?.description);

  if (config.directedDefense && !["melee", "ranged"].includes(attackType)) {
    ui.notifications.warn(
      `${item.name}: для Направленной защиты в 6.3 укажите Ближнюю или Дистанционную атаку. ` +
      `Самозащита не будет предложена для этого результата.`
    );
  }

  const rawFormula = String(config.formula ?? "1d20 + {combatDie}");
  const formula = expandAbilityAttackFormula(actor, rawFormula);
  const target = getSingleTarget();
  const previewTargetDefense = target?.actor
    ? effectiveArmorForAction(target, actor)
    : null;

  if ((game.user?.targets?.size ?? 0) > 1) {
    ui.notifications.warn(
      "Для одиночной Атаки способности выбери одну цель. Проверка будет выполнена без автоматической степени."
    );
  }

  const result = await prepareRoll({
    actor,
    label: `Атака: ${item.name}`,
    baseFormula: formula,
    baseSources: abilityAttackFormulaSources(actor, rawFormula, formula),
    showDC: false,
    contextHTML: armorContextHTML(
      target,
      previewTargetDefense?.armor ?? null,
      previewTargetDefense?.state ?? null
    )
  });

  if (!result) return null;

  // Same lazy rule as weapon attacks: resolve from the latest Scene state.
  const targetDefense = target?.actor
    ? effectiveArmorForAction(target, actor)
    : null;
  const effectiveArmor = targetDefense?.armor ?? null;
  const targetState = targetDefense?.state ?? null;

  const degree = target?.actor
    ? degreeVsArmor(
        result.roll.total,
        effectiveArmor,
        result.naturalD20
      )
    : null;

  const critical = result.naturalD20 === 20;

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-attack-card fast-nri-ability-attack-card">
      ${rollCardHeader(`Атака: ${item.name}`, "fa-wand-magic-sparkles")}
      <div class="fast-nri-attack-summary">
        <span>Результат: <strong>${esc(result.roll.total)}</strong></span>
        ${target?.name ? `<span>Цель: <strong>${esc(target.name)}</strong></span>` : ""}
      </div>
      ${armorMetaHTML(target, effectiveArmor, targetState)}
      ${critical ? `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-burst"></i>
          <strong>Натуральная 20</strong>
        </div>
      ` : ""}
      <div class="fast-nri-attack-type"><small>Вид атаки: <strong>${esc(attackTypeLabel(attackType))}</strong></small></div>
      ${degreeHTML(degree)}
      ${rollSourcesHTML(result)}
    </div>
  `;

  const message = await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: "ability-attack",
        actorUuid: actor.uuid,
        itemUuid: item.uuid,
        targetUuid: target?.document?.uuid ?? null,
        degree,
        critical,
        rollTotal: result.roll.total,
        naturalD20: result.naturalD20,
        attackType,
        directedDefense: Boolean(config.directedDefense),
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
    directedDefense: Boolean(config.directedDefense),
    attackType
  };
}

export async function rollAbilityOutcome(actor, item, requestedKind = null, sourceAttack = null) {
  if (!actor || !item || item.type !== "ability") return null;

  const fallbackKind = String(item.system?.outcome?.kind ?? "none");
  const kind = String(requestedKind ?? fallbackKind);

  if (!["damage", "healing", "tempHp"].includes(kind)) {
    ui.notifications.info(`${item.name}: автоматический результат не настроен.`);
    return null;
  }

  const channel = abilityOutcomeChannel(item, kind);
  if (!channel.enabled) {
    ui.notifications.info(`${item.name}: этот результат не включён.`);
    return null;
  }

  const components = abilityOutcomeComponents(actor, item, kind);
  if (!components.length) {
    ui.notifications.warn(`${item.name}: добавь хотя бы один компонент результата.`);
    return null;
  }

  if (kind === "damage") {
    const formula = flavoredDamageFormula(components);
    const displayFormula = plainDamageFormula(components);
    const result = await prepareRoll({
      actor,
      label: `Урон: ${item.name}`,
      baseFormula: formula,
      baseSources: [{
        formula: displayFormula,
        label: item.name,
        reason: item.system?.category === "spell" ? "Урон заклинания" : "Урон способности"
      }],
      showDC: false
    });
    if (!result) return null;

    let state = buildDamageState(result.roll, {
      components,
      damageType: components[0]?.damageType ?? "physical",
      traitIds: components[0]?.traitIds ?? []
    });

    // Если у способности была исходная Атака против КЗ, её степень
    // становится исходной степенью Эффекта для Направленной защиты.
    state.originalEffectDegree = sourceAttack?.degree ?? null;
    state.effectDegree = sourceAttack?.degree ?? null;
    state = recalculateDamageState(state);

    const modifiersHTML = rollSourcesHTML(result);
    const directedDefense = Boolean(
      sourceAttack
      && item.system?.attackCheck?.directedDefense
      && ["melee", "ranged"].includes(normalizeAttackType(sourceAttack.attackType))
    );

    const flavor = damageCardHTML({
      sourceName: item.name,
      profileLabel: item.system?.category === "spell" ? "Заклинание" : "Способность",
      critical: Boolean(sourceAttack?.critical),
      state,
      modifiersHTML,
      allowDefense: directedDefense,
      allowDouble: Boolean(sourceAttack)
    });

    return result.roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor }),
      flavor,
      flags: {
        "fast-nri": {
          kind: "damage",
          actorUuid: actor.uuid,
          itemUuid: item.uuid,
          abilityOutcome: true,
          outcomeKind: kind,
          critical: Boolean(sourceAttack?.critical),
          attackTotal: sourceAttack?.total ?? null,
          attackNaturalD20: sourceAttack?.naturalD20 ?? null,
          attackDegree: sourceAttack?.degree ?? null,
          automaticAttackDegree: sourceAttack?.degree ?? null,
          attackType: normalizeAttackType(sourceAttack?.attackType),
          originalTargetUuid: sourceAttack?.targetUuid ?? null,
          sourceAttackMessageId: sourceAttack?.message?.id ?? null,
          directedDefense,
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
    label: `${title}: ${item.name}`,
    baseFormula: formula,
    baseSources: [{
      formula: displayFormula,
      label: item.name,
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
        outcomeKind: kind,
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
  const originalTargetUuid = attackMessage?.getFlag("fast-nri", "targetUuid") ?? null;
  const attackType = normalizeAttackType(
    attackMessage?.getFlag("fast-nri", "attackType")
  ) || inferWeaponAttackType(weapon);

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

  const flavor = damageCardHTML({
    weaponName: weapon.name,
    profileLabel: labels[profile] ?? profile,
    critical,
    state: damageState,
    modifiersHTML
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
        originalTargetUuid,
        sourceAttackMessageId: attackMessage?.id ?? null,
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

function builtInSelfDefenseOption(actor, attackType) {
  const interventionCost = 1;
  const interventions = finiteNumberOrNull(actor?.system?.resources?.intervention);
  const warnings = [];
  const reasons = [];

  const normalizedAttackType = normalizeAttackType(attackType);
  if (normalizedAttackType === "area") {
    reasons.push("против Области действия Самозащита недоступна");
  } else if (!["melee", "ranged"].includes(normalizedAttackType)) {
    reasons.push("для исходной атаки не указан однозначный вид Ближняя/Дистанционная");
  }

  if (interventions !== null && interventions < interventionCost) {
    warnings.push(`в листе ${interventions} Вмешательств из требуемых ${interventionCost}`);
  }

  return {
    id: "system-self-defense",
    actionName: "Самозащита",
    item: null,
    config: {
      enabled: true,
      targetScope: "self",
      interventionCost,
      rangeMode: "manual",
      rangeCells: 0,
      requiresVisibility: false,
      movementMode: "none",
      damageSelectionMode: "standard",
      combatDiceFormula: "",
      removeDamageParts: 1,
      effectDegreeReduction: 1,
      allowManeuver: false
    },
    disabled: reasons.length > 0,
    reasons,
    warnings,
    costLabel: "1 Вмешательство"
  };
}

function defenseMethodOptions({ actor, defenderToken, protectedToken, role, damageState, attackType }) {
  const options = [];

  if (role === "self") options.push(builtInSelfDefenseOption(actor, attackType));

  for (const item of defenseAbilityItems(actor, role)) {
    const config = defenseActionConfig(item);
    const availability = evaluateDefenseAbility({
      actor,
      defenderToken,
      protectedToken,
      item,
      role
    });

    const alreadyUsed = (damageState?.defenseHistory ?? []).some(entry =>
      entry?.actorUuid === actor.uuid
    );

    if (alreadyUsed) {
      availability.warnings.push("этот персонаж уже использовал защиту в этой цепочке");
    }

    options.push({
      id: `ability-${item.id}`,
      actionName: item.name,
      item,
      config,
      disabled: availability.disabled,
      reasons: availability.reasons,
      warnings: availability.warnings,
      costLabel: defenseCostLabel(item, actor)
    });
  }

  return options;
}

async function chooseDefenseMethod({ actor, defenderToken, protectedToken, role, damageState, attackType }) {
  const { DialogV2 } = foundry.applications.api;
  const options = defenseMethodOptions({
    actor,
    defenderToken,
    protectedToken,
    role,
    damageState,
    attackType
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
        ${role === "self"
          ? "<p>Выберите способ Самозащиты.</p>"
          : "<p>Показаны Защитные Ability выбранного персонажа, подходящие для союзника.</p>"
        }
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

async function spendDefenseClassResource(actor, item) {
  const cost = Math.max(0, Number(item?.system?.classResourceCost) || 0);
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

function defenseResourceHTML(resource, undone = false) {
  if (!(Number(resource?.cost) > 0)) return "";

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
          data-fast-nri-undo-defense-resource
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
  const max = Math.max(0, Number(actor.system?.classResource?.max) || 0);
  let restored = current + spent;
  if (max > 0) restored = Math.min(max, restored);

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
  const storedAttackType = normalizeAttackType(message.getFlag("fast-nri", "attackType"));
  const attackType = storedAttackType
    || (sourceItem?.type === "weapon" ? inferWeaponAttackType(sourceItem) : "")
    || (sourceItem?.type === "ability"
      ? normalizeAttackType(sourceItem.system?.attackCheck?.attackType)
        || inferAbilityAttackTypeFromDescription(sourceItem.system?.description)
      : "");

  const method = await chooseDefenseMethod({
    actor: defender,
    defenderToken,
    protectedToken,
    role,
    damageState,
    attackType
  });
  if (!method) return null;

  const actionItem = method.item;
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

  const sourceActor = sourceItem?.parent?.documentName === "Actor"
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

  const combatSource = defenseCombatTerm(defender, actionItem, role);
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
            currentValue: 0,
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

  const resource = await spendDefenseClassResource(defender, actionItem);

  damageState.defense = {
    kind: role === "self" ? "self-defense" : "ally-defense",
    actionName,
    abilityUuid: actionItem?.uuid ?? null,
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

  damageState.defenseHistory = [
    ...(damageState.defenseHistory ?? []),
    foundry.utils.deepClone(damageState.defense)
  ];

  damageState = recalculateDamageState(damageState);

  const profile = message.getFlag("fast-nri", "profile");
  const critical = Boolean(message.getFlag("fast-nri", "critical"));
  const modifiersHTML = message.getFlag("fast-nri", "modifierNotesHTML") ?? "";
  const labels = {
    partial: "Частичный",
    success: "Успех",
    great: "Большой"
  };

  const defenseDisplay = {
    actionName,
    defenderTokenName: defenderToken.name,
    protectedTokenName: protectedToken?.name || protectedToken?.actor?.name || defender.name,
    role,
    attackTotal,
    defenseTotal: result.roll.total,
    defenseResult,
    sourcesHTML: rollSourcesHTML(result)
  };

  const defenseFlavor = defenseRollFlavorHTML({
    ...defenseDisplay,
    result,
    resource,
    resourceUndone: false
  });

  const defenseMessage = await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({
      actor: defender,
      token: defenderToken.document
    }),
    flavor: defenseFlavor,
    flags: {
      "fast-nri": {
        kind: "defense-roll",
        actionName,
        role,
        abilityUuid: actionItem?.uuid ?? null,
        sourceDamageMessageId: message.id,
        defenderTokenUuid: defenderToken.document?.uuid ?? null,
        defenderActorUuid: defender.uuid,
        protectedTokenUuid: protectedToken?.document?.uuid ?? null,
        protectedActorUuid: protectedToken?.actor?.uuid ?? null,
        result: defenseResult,
        attackTotal,
        naturalD20: result.naturalD20,
        resourceCost: resource.cost,
        resourceLabel: resource.label,
        resourceBefore: resource.before,
        resourceAfter: resource.after,
        resourceSpent: resource.spent,
        resourceShortage: resource.shortage,
        resourceUndone: false,
        defenseDisplay
      }
    }
  });

  const flavor = damageCardHTML({
    weaponName: sourceItem?.name ?? "Урон",
    profileLabel: labels[profile] ?? profile ?? "",
    critical,
    state: damageState,
    modifiersHTML
  });

  const derivedMessage = await ChatMessage.create({
    speaker: message.speaker,
    content: flavor,
    flags: {
      "fast-nri": {
        kind: "damage",
        actorUuid: message.getFlag("fast-nri", "actorUuid"),
        itemUuid: message.getFlag("fast-nri", "itemUuid"),
        profile,
        critical,
        attackTotal: message.getFlag("fast-nri", "attackTotal"),
        attackNaturalD20: message.getFlag("fast-nri", "attackNaturalD20"),
        attackDegree: damageState.effectDegree,
        automaticAttackDegree: message.getFlag("fast-nri", "automaticAttackDegree"),
        originalTargetUuid: message.getFlag("fast-nri", "originalTargetUuid"),
        sourceAttackMessageId: message.getFlag("fast-nri", "sourceAttackMessageId"),
        sourceDamageMessageId: message.id,
        rolledTotal: message.getFlag("fast-nri", "rolledTotal"),
        finalTotal: damageState.currentTotal,
        modifierNotesHTML: modifiersHTML,
        damageState
      }
    }
  });

  return {
    message: derivedMessage,
    sourceMessage: message,
    defenseMessage,
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

function controlledSingleToken() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);

  if (controlled.length === 0) {
    ui.notifications.warn("Выдели токен, которому нужно нанести урон.");
    return null;
  }

  if (controlled.length > 1) {
    ui.notifications.warn("Для нанесения урона должен быть выделен только один токен.");
    return null;
  }

  return controlled[0];
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
    const matches = partMatchIds(part);
    const immunityId = Array.from(immunityIds).find(id => matches.has(id)) ?? null;

    if (immunityId) {
      part.immuneRemoved = true;
      part.immunityId = immunityId;
      part.currentValue = 0;
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
  // Часть с currentValue = 0 после Самозащиты остаётся здесь и сохраняет
  // свои тип/свойства. Поэтому она может активировать Устойчивость или
  // Уязвимость. Только Иммунитет удаляет часть и её свойства окончательно.
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

  const partsTotal = survivingParts.reduce(
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
  undone = false
}) {
  return `
    <div class="fast-nri-applied-damage-message ${undone ? "undone" : ""}">
      <div class="fast-nri-applied-damage-text">
        <i class="fa-solid fa-heart-crack"></i>
        <span>
          <strong>${esc(tokenName)}</strong>
          получает <strong>${esc(damage)}</strong> урона
        </span>
      </div>

      ${resolutionHTML}

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

  const token = controlledSingleToken();
  if (!token) return null;

  const actor = token.actor;
  if (!actor) {
    ui.notifications.error("У выделенного токена нет Actor.");
    return null;
  }

  const sourceMessage = chatMessageFromElement(element);
  const damageState = sourceMessage?.getFlag("fast-nri", "damageState") ?? null;

  let resolution;
  if (damageState?.supported) {
    resolution = resolveDamageAgainstActor(damageState, actor, multiplier);
  } else {
    if (!Number.isFinite(fallbackDamage) || fallbackDamage < 0) {
      ui.notifications.error("Не удалось определить величину урона.");
      return null;
    }

    resolution = {
      multiplier,
      sourceParts: [],
      survivingParts: [],
      immuneParts: [],
      activeMatchIds: [],
      partsTotal: fallbackDamage / multiplier,
      penalty: 0,
      afterPenalty: fallbackDamage / multiplier,
      afterMultiplier: fallbackDamage,
      matchingResistances: [],
      matchingVulnerabilities: [],
      resistance: null,
      vulnerability: null,
      finalDamage: fallbackDamage,
      fullCancel: false
    };
  }

  const previousHp = Number(actor.system?.hp?.value);
  const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);

  if (!Number.isFinite(previousHp)) {
    ui.notifications.error("У выделенного токена нет корректного значения HP.");
    return null;
  }

  const finalDamage = Math.max(0, Number(resolution.finalDamage) || 0);
  const appliedToTemp = Math.min(previousTemp, finalDamage);
  const remainingAfterTemp = Math.max(0, finalDamage - appliedToTemp);
  const afterTemp = Math.max(0, previousTemp - appliedToTemp);
  const afterHp = Math.max(0, previousHp - remainingAfterTemp);
  const appliedToHp = previousHp - afterHp;
  const appliedDamage = appliedToTemp + appliedToHp;

  try {
    await actor.update({
      "system.hp.temp": afterTemp,
      "system.hp.value": afterHp
    }, { [HP_FEEDBACK_SUPPRESS_OPTION]: true });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка нанесения урона", error);
    ui.notifications.error("Не удалось изменить HP выделенного токена.");
    return null;
  }

  const tokenUuid = token.document?.uuid ?? "";
  const actorUuid = actor.uuid;
  const tokenName = token.name || actor.name || "Цель";
  const resolutionHTML = damageResolutionHTML(resolution, {
    tempAbsorbed: appliedToTemp,
    hpLost: appliedToHp
  });

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
    resolutionHTML
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token: token.document }),
    content,
    flags: {
      "fast-nri": {
        kind: "damage-applied",
        tokenUuid,
        actorUuid,
        tokenName,
        requestedDamage: finalDamage,
        appliedDamage,
        appliedToHp,
        appliedToTemp,
        previousHp,
        afterHp,
        previousTemp,
        afterTemp,
        multiplier,
        resolution,
        undone: false
      }
    }
  });

  return {
    message,
    token,
    actor,
    requestedDamage: finalDamage,
    appliedDamage,
    appliedToHp,
    appliedToTemp,
    previousHp,
    afterHp,
    previousTemp,
    afterTemp,
    resolution
  };
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

  const stored = message?.getFlag("fast-nri", "kind") === "damage-applied"
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
      undone: true
    });

    try {
      await message.update({
        content,
        "flags.fast-nri.undone": true,
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
