import {
  ITEM_PROPERTY_IDS
} from "./config.mjs";

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

function getSingleTarget() {
  const targets = Array.from(game.user?.targets ?? []);
  if (targets.length !== 1) return null;
  return targets[0];
}

function armorContextHTML(target) {
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

  const armor = target.actor.system?.armor ?? {};
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
        </small>
      </div>
    </section>
  `;
}

function armorMetaHTML(target) {
  if (!target?.actor) {
    return `
      <div class="fast-nri-chat-target fast-nri-chat-target-missing">
        <span>Цель не выбрана</span>
      </div>
    `;
  }

  const armor = target.actor.system?.armor ?? {};
  return `
    <div class="fast-nri-chat-target">
      <span class="fast-nri-chat-target-name">${esc(target.name)}</span>
      <span class="fast-nri-chat-armor">
        КЗ ${esc(armor.partial ?? "—")} / ${esc(armor.success ?? "—")} / ${esc(armor.great ?? "—")}
      </span>
    </div>
  `;
}

function damageProfilesHTML(actor, weapon, degree, critical) {
  const profiles = [
    ["partial", "Частичный", weapon.system?.damage?.partial],
    ["success", "Успех", weapon.system?.damage?.success],
    ["great", "Большой", weapon.system?.damage?.great]
  ];

  return `
    <section class="fast-nri-hit-damage">
      <div class="fast-nri-hit-damage-heading">
        <span>Профиль урона</span>
        ${critical ? `<strong class="fast-nri-critical-note">Крит: итоговый урон ×2</strong>` : ""}
      </div>

      <div class="fast-nri-hit-damage-buttons">
        ${profiles.map(([key, label, rawFormula]) => {
          const formula = String(rawFormula ?? "").trim() || "0";
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

  const combatDie = String(actor.system?.combatDie ?? "").trim();
  const baseFormula = combatDie ? `1d20 + ${combatDie}` : "1d20";
  const target = getSingleTarget();

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
    contextHTML: armorContextHTML(target)
  });

  if (!result) return null;

  const degree = target?.actor
    ? degreeVsArmor(result.roll.total, target.actor.system?.armor, result.naturalD20)
    : null;

  const critical = result.naturalD20 === 20;

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-attack-card">
      ${rollCardHeader("Попадание", "fa-swords")}
      ${attackResultHTML(weapon, target, degree, result.roll.total)}
      ${armorMetaHTML(target)}

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
        naturalD20: result.naturalD20
      }
    }
  });

  return {
    roll: result.roll,
    formula: result.formula,
    naturalD20: result.naturalD20,
    target,
    degree,
    critical
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
 * Быстрая НРИ 6.2:
 * - каждый обычный куб урона — отдельный куб урона;
 * - каждый положительный числовой бонус — отдельный фиксированный куб урона;
 * - штрафы кубами урона не считаются;
 * - защита работает с уже выпавшими/фиксированными результатами.
 */
function buildDamageState(roll, {
  damageType = "physical"
} = {}) {
  const parts = [];
  const penalties = [];
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

    const dieResults = activeDieResults(term);
    if (dieResults) {
      for (const dieResult of dieResults) {
        const entry = {
          id: `part-${sequence++}`,
          kind: "die",
          faces: Number(term.faces),
          value: dieResult.value,
          nativeLabel: dieResult.label,
          nativeResultCSS: dieResult.css,
          damageType,
          removed: false
        };

        if (sign >= 0) parts.push(entry);
        else penalties.push({
          ...entry,
          id: `penalty-${sequence++}`
        });
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
          damageType,
          removed: false
        });
      } else if (numeric > 0 && sign < 0) {
        penalties.push({
          id: `penalty-${sequence++}`,
          kind: "fixed",
          faces: null,
          value: numeric,
          damageType,
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
    .filter(part => !part.removed)
    .reduce((sum, part) => sum + Math.max(0, Number(part.value) || 0), 0);

  const penalty = (next.penalties ?? [])
    .reduce((sum, part) => sum + Math.max(0, Number(part.value) || 0), 0);

  next.currentBaseTotal = Math.max(0, positive - penalty);
  next.currentTotal = next.currentBaseTotal;
  return next;
}

function damagePartLabel(part) {
  if (part?.kind === "die") return `d${part.faces} → ${part.value}`;
  return `фикс. +${part?.value ?? 0}`;
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
    if (part.kind === "die") {
      const nativeLabel = part.nativeLabel ?? part.value;
      const nativeClasses = nativeDamageDieClasses(part);

      return `
        <span
          class="fast-nri-damage-native-part ${part.removed ? "removed" : ""}"
          title="${part.removed ? "Удалено защитой" : escAttr(damagePartLabel(part))}"
        >
          <span class="fast-nri-damage-native-type">
            ${esc(damagePartShortLabel(part))}:
          </span>

          <span class="dice-tooltip fast-nri-inline-dice-tooltip">
            <section class="tooltip-part">
              <div class="dice">
                <ol class="dice-rolls fast-nri-damage-native-rolls">
                  <li class="${escAttr(nativeClasses)}">
                    ${esc(nativeLabel)}
                  </li>
                </ol>
              </div>
            </section>
          </span>
        </span>
      `;
    }

    return `
      <span
        class="fast-nri-damage-fixed-part ${part.removed ? "removed" : ""}"
        title="${part.removed ? "Удалено защитой" : escAttr(damagePartLabel(part))}"
      >
        <span class="fast-nri-damage-native-type">
          ${esc(damagePartShortLabel(part))}:
        </span>
        <strong class="fast-nri-fixed-result">
          ${esc(part.value)}
        </strong>
      </span>
    `;
  }).join("");

  const penalty = (state.penalties ?? [])
    .reduce((sum, part) => sum + Math.max(0, Number(part.value) || 0), 0);

  const total = Math.max(0, Number(state.currentTotal) || 0);

  return `
    <section class="fast-nri-damage-parts-block">
      <div class="fast-nri-damage-parts-title">Кубы урона</div>

      <div class="fast-nri-damage-equation">
        <div class="fast-nri-damage-parts">
          ${parts || `<span class="fast-nri-roll-empty">Нет положительных кубов урона.</span>`}
        </div>

        ${penalty > 0 ? `
          <span
            class="fast-nri-damage-adjustment"
            title="Штраф применяется после Защитных действий"
          >
            −${esc(penalty)}
          </span>
        ` : ""}

        <span class="fast-nri-damage-equation-arrow" aria-hidden="true">→</span>

        <strong
          class="fast-nri-damage-equation-total"
          title="Текущий итоговый урон"
        >
          ${esc(total)}
        </strong>
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

  const removed = defense.removedPart ?? null;
  const beforeDegree = defense.effectDegreeBefore;
  const afterDegree = defense.effectDegreeAfter;

  return `
    <section class="fast-nri-self-defense-summary fast-nri-self-defense-${escAttr(defense.result)}">
      <div class="fast-nri-self-defense-heading">
        <i class="fa-solid fa-shield-halved"></i>
        <strong>Самозащита — ${esc(defenseResultLabel(defense.result))}</strong>
      </div>

      <small>
        ${esc(defense.tokenName)}:
        ${esc(defense.total)}
        против исходного результата
        ${esc(defense.attackTotal)}
      </small>

      ${removed ? `
        <div>Удалён куб: <strong>${esc(damagePartLabel(removed))}</strong></div>
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
  profileLabel,
  critical,
  state,
  modifiersHTML = ""
}) {
  const baseDamage = Math.max(0, Number(state?.currentTotal) || 0);
  const doubledDamage = baseDamage * 2;

  return `
    <div class="fast-nri-chat-roll fast-nri-damage-card">
      ${rollCardHeader(`Урон: ${weaponName}`, "fa-burst")}

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

      <div class="fast-nri-damage-actions fast-nri-damage-actions-three">
        <button
          type="button"
          class="fast-nri-defense-button"
          data-fast-nri-defense
          title="Использовать защитное действие"
        >
          <i class="fa-solid fa-shield-halved"></i>
          <span>Защита</span>
        </button>

        <button
          type="button"
          class="fast-nri-apply-damage-button"
          data-fast-nri-apply-damage
          data-damage="${escAttr(baseDamage)}"
          ${state.fullCancel ? "disabled" : ""}
          title="${state.fullCancel
            ? "Действие полностью отменено"
            : `Нанести ${escAttr(baseDamage)} урона выделенному токену`
          }"
        >
          <i class="fa-solid fa-heart-crack"></i>
          <span>${state.fullCancel ? "Урон отменён" : "Нанести"}</span>
        </button>

        <button
          type="button"
          class="fast-nri-apply-damage-button fast-nri-apply-damage-x2"
          data-fast-nri-apply-damage
          data-damage="${escAttr(doubledDamage)}"
          ${state.fullCancel ? "disabled" : ""}
          title="${state.fullCancel
            ? "Действие полностью отменено"
            : `Нанести ${escAttr(doubledDamage)} урона (×2)`
          }"
        >
          <i class="fa-solid fa-xmark"></i>
          <span>${state.fullCancel ? "×2 отменён" : "Нанести ×2"}</span>
        </button>
      </div>

      ${modifiersHTML}
    </div>
  `;
}

async function chooseDamagePart(parts, mode = "largest") {
  const active = (parts ?? []).filter(part => !part.removed);
  if (!active.length) return null;

  const values = active.map(part => Number(part.value) || 0);
  const targetValue = mode === "smallest"
    ? Math.min(...values)
    : Math.max(...values);

  const tied = active.filter(
    part => (Number(part.value) || 0) === targetValue
  );

  if (tied.length === 1) return tied[0];

  const { DialogV2 } = foundry.applications.api;
  const word = mode === "smallest" ? "маленьких" : "больших";

  const choice = await DialogV2.wait({
    window: {
      title: "Самозащита: выберите куб урона"
    },
    content: `
      <div class="fast-nri-defense-choice">
        <p>
          Несколько самых ${word} кубов имеют одинаковый результат
          <strong>${esc(targetValue)}</strong>.
          Выберите, какой удалить при успешной Самозащите.
        </p>
        <p>
          Выбор выполняется <strong>до броска Самозащиты</strong>,
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

function hasAbility(actor, name) {
  const target = normalizedProperty(name);
  return actorAbilityItems(actor).some(item =>
    item?.type === "ability"
    && normalizedProperty(item?.name) === target
  );
}

function selfDefenseCombatTerm(actor) {
  // «Всегда готов»: ровно 2d6 вместо Куба боя, а не удвоение
  // фактического system.combatDie.
  if (hasAbility(actor, "Всегда готов")) return "2d6";

  const combatDie = String(actor?.system?.combatDie ?? "").trim();
  if (combatDie) return combatDie;

  // Существо Бестиария без Куба боя использует свой модификатор атаки.
  if (actor?.type === "creature") {
    const attackModifier = finiteNumberOrNull(actor.system?.attackModifier);
    if (attackModifier !== null) return String(attackModifier);
  }

  return "";
}

function selfDefenseCombatSource(actor, combatTerm) {
  if (!combatTerm) return null;
  if (hasAbility(actor, "Всегда готов")) return { formula: combatTerm, label: "Всегда готов", reason: "2d6 вместо Куба боя" };
  const combatDie = String(actor?.system?.combatDie ?? "").trim();
  if (combatDie) return { formula: combatTerm, label: "Куб боя", reason: actor.name };
  if (actor?.type === "creature") return { formula: combatTerm, label: "Модификатор атаки", reason: "Существо Бестиария без Куба боя" };
  return { formula: combatTerm, label: "Куб боя", reason: "" };
}

function equippedDefensiveItem(actor) {
  return actorAbilityItems(actor).find(item =>
    (item?.type === "weapon" || item?.type === "equipment")
    && item?.system?.equipped === true
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

async function confirmZeroDamageDefense() {
  const { DialogV2 } = foundry.applications.api;

  return DialogV2.confirm({
    window: {
      title: "Самозащита при 0 урона"
    },
    content: `
      <div class="fast-nri-defense-choice">
        <p>
          Сейчас итоговый урон равен <strong>0</strong>.
          Направленная защита нужна только если остаётся результат Манёвра
          или другой отрицательный Эффект.
        </p>
        <p>
          Продолжить Самозащиту ради отрицательного Эффекта?
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

export async function rollDamageFromChat(element) {
  const actorUuid = element?.dataset?.actorUuid;
  const itemUuid = element?.dataset?.itemUuid;
  const profile = element?.dataset?.profile;
  const formula = String(element?.dataset?.formula ?? "").trim();
  const critical = element?.dataset?.critical === "true";

  if (!actorUuid || !itemUuid || !formula) return;

  const actor = await fromUuid(actorUuid);
  const weapon = await fromUuid(itemUuid);

  if (!actor || !weapon) {
    ui.notifications.error("Не удалось найти персонажа или оружие для броска урона.");
    return;
  }

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

  const labels = {
    partial: "Частичный",
    success: "Успех",
    great: "Большой"
  };

  const result = await prepareRoll({
    actor,
    label: `Урон: ${weapon.name} — ${labels[profile] ?? profile}`,
    baseFormula: formula,
    baseSources: [{ formula, label: `${weapon.name}: ${labels[profile] ?? profile}`, reason: "Профиль урона" }],
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
    damageType: weapon.system?.damageType || "physical"
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

export async function selfDefenseFromChat(element) {
  const message = chatMessageFromElement(element);

  if (!message || message.getFlag("fast-nri", "kind") !== "damage") {
    ui.notifications.error("Не удалось найти исходный бросок урона.");
    return null;
  }

  const defenderToken = controlledSingleDefenderToken();
  if (!defenderToken) return null;

  const targets = Array.from(game.user?.targets ?? []);

  // Роль определяет только текущий выбор игрока:
  // - target отсутствует -> выбранный Token защищает себя;
  // - target совпадает с выбранным Token -> это тоже Самозащита;
  // - единственный другой target -> Защита союзника.
  // Исходный target атаки здесь намеренно не проверяется.
  if (targets.length > 1) {
    ui.notifications.warn("Для защиты выбери не больше одной цели.");
    return null;
  }

  if (targets.length === 1) {
    const target = targets[0];
    const sameToken =
      target?.id === defenderToken.id
      || target?.document?.uuid === defenderToken.document?.uuid;

    if (!sameToken) {
      ui.notifications.info("Выбран другой токен: это Защита союзника. Эта ветка пока не реализована.");
      return null;
    }
  }

  const defender = defenderToken.actor;
  if (!defender) {
    ui.notifications.error("У выбранного токена нет Actor.");
    return null;
  }

  let damageState = foundry.utils.deepClone(
    message.getFlag("fast-nri", "damageState")
  );

  if (!damageState) {
    ui.notifications.error("В этом сообщении нет структурированного результата урона.");
    return null;
  }

  if (!damageState.supported) {
    ui.notifications.error("Эту формулу урона пока нельзя безопасно обработать Самозащитой.");
    return null;
  }

  const attackTotal = finiteNumberOrNull(message.getFlag("fast-nri", "attackTotal"));
  const attackNaturalD20 = finiteNumberOrNull(message.getFlag("fast-nri", "attackNaturalD20"));
  const weapon = await fromUuid(message.getFlag("fast-nri", "itemUuid"));

  if (attackTotal === null) {
    ui.notifications.error("Не удалось определить результат исходной атаки для проверки Самозащиты.");
    return null;
  }

  if (damageState.currentTotal <= 0) {
    const continueForEffect = await confirmZeroDamageDefense();
    if (!continueForEffect) return null;
  }

  const removalMode = selfDefenseRemovalMode(weapon);
  const remainingBeforeRoll = (damageState.parts ?? []).filter(part => !part.removed);

  // В случае равных максимальных/минимальных результатов выбор делается
  // ДО броска защиты. Закрытие окна поэтому не создаёт способа перебросить
  // уже совершённую проверку.
  let selectedRemovalPart = null;
  if (remainingBeforeRoll.length) {
    selectedRemovalPart = await chooseDamagePart(remainingBeforeRoll, removalMode);
    if (!selectedRemovalPart) return null;
  }

  const fortitude = finiteNumberOrNull(defender.system?.defenses?.fortitude);
  if (fortitude === null) {
    ui.notifications.error("У выбранного токена нет корректного значения Стойкости.");
    return null;
  }

  const combatTerm = selfDefenseCombatTerm(defender);
  const baseFormula = combatTerm
    ? `1d20 + ${fortitude} + ${combatTerm}`
    : `1d20 + ${fortitude}`;

  const interventions = finiteNumberOrNull(defender.system?.resources?.intervention);
  if (interventions !== null && interventions <= 0) {
    ui.notifications.warn(
      `${defenderToken.name}: в листе сейчас 0 Вмешательств. Самозащита не блокируется; ресурс ведётся вручную.`
    );
  }

  const contextualModifiers = selfDefenseContextualModifiers(
    defender,
    weapon,
    damageState.originalEffectDegree
  );

  const combatSource = selfDefenseCombatSource(defender, combatTerm);

  const result = await prepareRoll({
    actor: defender,
    label: `Самозащита: ${defenderToken.name}`,
    baseFormula,
    baseSources: [
      { formula: "1d20", label: "Базовый d20", reason: "Направленная защита" },
      { formula: String(fortitude), label: "Стойкость", reason: defender.name },
      ...(combatSource ? [combatSource] : [])
    ],
    showDC: false,
    additionalModifiers: contextualModifiers,
    contextHTML: `
      <section class="fast-nri-roll-context fast-nri-defense-roll-context">
        <i class="fa-solid fa-shield-halved"></i>
        <div>
          <strong>Самозащита</strong>
          <small>
            Исходный результат: ${esc(attackTotal)}
            · Удаление: ${removalMode === "smallest" ? "самый маленький куб (Уверенное)" : "самый большой куб"}
            · Требуется 1 Вмешательство (вручную)
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
  let removedPart = null;

  if (defenseResult === "full-cancel") {
    damageState.fullCancel = true;
    damageState.effectDegree = "failure";
    effectDegreeAfter = "failure";
  } else if (defenseResult === "success") {
    removedPart = selectedRemovalPart;

    if (removedPart) {
      // Новая карточка получает уже новый набор кубов.
      // Исходную карточку и её damageState не изменяем.
      damageState.parts = damageState.parts.filter(
        part => part.id !== removedPart.id
      );
    }

    effectDegreeAfter = lowerDegree(effectDegreeBefore, 1);
    damageState.effectDegree = effectDegreeAfter;
  }

  damageState.defense = {
    kind: "self-defense",
    tokenUuid: defenderToken.document?.uuid ?? null,
    actorUuid: defender.uuid,
    tokenName: defenderToken.name || defender.name || "Защитник",
    formula: result.formula,
    total: result.roll.total,
    naturalD20: result.naturalD20,
    attackTotal,
    attackNaturalD20,
    result: defenseResult,
    removedPartId: removedPart?.id ?? null,
    removedPart: removedPart ? foundry.utils.deepClone(removedPart) : null,
    removalMode,
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

  const defenseFlavor = `
    <div class="fast-nri-chat-roll fast-nri-defense-roll-card">
      ${rollCardHeader(`Самозащита: ${defenderToken.name}`, "fa-shield-halved")}
      <div class="fast-nri-defense-roll-result">
        <span>Исходный результат: <strong>${esc(attackTotal)}</strong></span>
        <span>Защита: <strong>${esc(result.roll.total)}</strong></span>
        <span>Результат: <strong>${esc(defenseResultLabel(defenseResult))}</strong></span>
      </div>
      ${rollSourcesHTML(result)}
    </div>
  `;

  await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({
      actor: defender,
      token: defenderToken.document
    }),
    flavor: defenseFlavor,
    flags: {
      "fast-nri": {
        kind: "self-defense-roll",
        sourceDamageMessageId: message.id,
        defenderTokenUuid: defenderToken.document?.uuid ?? null,
        defenderActorUuid: defender.uuid,
        result: defenseResult,
        attackTotal,
        naturalD20: result.naturalD20
      }
    }
  });

  // Ключевое правило UI: исходная карточка урона остаётся неизменной.
  // После защиты создаётся новая карточка с унаследованными результатами
  // и уже изменённым набором кубов.
  const flavor = damageCardHTML({
    weaponName: weapon?.name ?? "Урон",
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
    defenderToken,
    roll: result.roll,
    result: defenseResult,
    damageState
  };
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

function appliedDamageMessageContent({
  tokenName,
  damage,
  tokenUuid,
  actorUuid,
  previousHp,
  afterHp,
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

      ${undone ? "" : `
        <button
          type="button"
          class="fast-nri-undo-damage-button"
          data-fast-nri-undo-damage
          data-token-uuid="${escAttr(tokenUuid)}"
          data-actor-uuid="${escAttr(actorUuid)}"
          data-previous-hp="${escAttr(previousHp)}"
          data-after-hp="${escAttr(afterHp)}"
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
  const requestedDamage = Number(element?.dataset?.damage);

  if (!Number.isFinite(requestedDamage) || requestedDamage < 0) {
    ui.notifications.error("Не удалось определить величину урона.");
    return null;
  }

  const token = controlledSingleToken();
  if (!token) return null;

  const actor = token.actor;
  if (!actor) {
    ui.notifications.error("У выделенного токена нет Actor.");
    return null;
  }

  const previousHp = Number(actor.system?.hp?.value);
  if (!Number.isFinite(previousHp)) {
    ui.notifications.error("У выделенного токена нет корректного значения HP.");
    return null;
  }

  // HP никогда не может опуститься ниже 0.
  const afterHp = Math.max(0, previousHp - requestedDamage);

  // Фактически снятое HP. Например, при 5 HP и 12 урона снимается только 5 HP.
  const appliedDamage = previousHp - afterHp;

  try {
    await actor.update({
      "system.hp.value": afterHp
    });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка нанесения урона", error);
    ui.notifications.error("Не удалось изменить HP выделенного токена.");
    return null;
  }

  const tokenUuid = token.document?.uuid ?? "";
  const actorUuid = actor.uuid;
  const tokenName = token.name || actor.name || "Цель";

  const content = appliedDamageMessageContent({
    tokenName,
    damage: requestedDamage,
    tokenUuid,
    actorUuid,
    previousHp,
    afterHp
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
        requestedDamage,
        appliedDamage,
        previousHp,
        afterHp,
        undone: false
      }
    }
  });

  return {
    message,
    token,
    actor,
    requestedDamage,
    appliedDamage,
    previousHp,
    afterHp
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
  if (!Number.isFinite(currentHp)) {
    ui.notifications.error("Не удалось определить текущее HP.");
    return null;
  }

  const maxHp = Number(actor.system?.hp?.max);

  // Отмена возвращает ровно то HP, которое сняло это конкретное сообщение.
  // Так последующие урон/лечение не перезаписываются возвратом старого состояния.
  let restoredHp = currentHp + stored.appliedDamage;

  // Если максимальное HP задано корректно, отмена не должна поднять HP выше максимума.
  if (Number.isFinite(maxHp)) {
    restoredHp = Math.min(maxHp, restoredHp);
  }

  restoredHp = Math.max(0, restoredHp);

  // Фактическое изменение HP при отмене. Если после исходного урона цель
  // уже лечили и max HP ограничивает возврат, floaty-text должен показывать
  // именно реально возвращённое HP, а не исходную величину события.
  const restoredAmount = Math.max(0, restoredHp - currentHp);

  try {
    await actor.update({
      "system.hp.value": restoredHp
    });
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
      undone: true
    });

    try {
      await message.update({
        content,
        "flags.fast-nri.undone": true,
        "flags.fast-nri.restoredHp": restoredHp,
        "flags.fast-nri.restoredAmount": restoredAmount
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

    const defenseButton = event.target.closest("[data-fast-nri-defense]");
    if (defenseButton) {
      event.preventDefault();
      event.stopPropagation();

      if (defenseButton.dataset.fastNriBusy === "true") return;
      defenseButton.dataset.fastNriBusy = "true";

      try {
        await selfDefenseFromChat(defenseButton);
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
