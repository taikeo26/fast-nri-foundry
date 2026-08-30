const DEGREE_LABELS = {
  failure: "Провал",
  partial: "Частичный успех",
  success: "Успех",
  great: "Большой успех"
};

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
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

/**
 * Roll modifiers supplied by Active Effects.
 *
 * Future status compendiums can store:
 * flags.fast-nri.rollModifiers = [
 *   { formula: "1d4", label: "Вдохновение", reason: "Статус" }
 * ]
 *
 * This reader is already usable, but 0.2.0 does not yet create those effects.
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

function buildDialogHTML({ label, baseFormula, automaticModifiers, defaultDC }) {
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

      <section class="fast-nri-final-formula-row">
        <span>Итоговая формула</span>
        <code class="fast-nri-final-formula">${esc(baseFormula)}</code>
      </section>
    </div>
  `;
}

function collectDialogState(dialog, baseFormula, automaticModifiers) {
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

  const dcRaw = root.querySelector(".fast-nri-roll-dc")?.value?.trim() ?? "";
  const dc = dcRaw === "" ? null : Number(dcRaw);

  return {
    formula: composeFormula(baseFormula, [...activeAutomatic, ...manual]),
    automaticModifiers: activeAutomatic,
    manualModifiers: manual,
    dc: Number.isFinite(dc) ? dc : null
  };
}

function attachDialogListeners(dialog, baseFormula, automaticModifiers) {
  const root = dialog.element;
  const manualContainer = root.querySelector(".fast-nri-manual-modifiers");
  const finalFormula = root.querySelector(".fast-nri-final-formula");

  const updateFormula = () => {
    const state = collectDialogState(dialog, baseFormula, automaticModifiers);
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

function degreeHTML(degree) {
  if (!degree) return "";

  return `
    <div class="fast-nri-degree-result fast-nri-degree-${degree}">
      <span class="fast-nri-degree-result-label">Степень</span>
      <strong>${DEGREE_LABELS[degree]}</strong>
    </div>
  `;
}

export async function openPreRollDialog({
  actor,
  label,
  baseFormula,
  defaultDC = null
}) {
  const automaticModifiers = collectAutomaticModifiers(actor);
  const { DialogV2 } = foundry.applications.api;

  const result = await DialogV2.wait({
    window: {
      title: `Бросок: ${label}`
    },
    content: buildDialogHTML({
      label,
      baseFormula,
      automaticModifiers,
      defaultDC
    }),
    modal: true,
    rejectClose: false,
    render: (_event, dialog) => {
      attachDialogListeners(dialog, baseFormula, automaticModifiers);
    },
    buttons: [
      {
        action: "roll",
        label: "Бросить",
        icon: "fa-solid fa-dice-d20",
        default: true,
        callback: async (_event, _button, dialog) => {
          return collectDialogState(dialog, baseFormula, automaticModifiers);
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

  const naturalD20 = getNaturalD20(roll);
  const degree = result.dc === null
    ? null
    : degreeVsDC(roll.total, result.dc, naturalD20);

  const modifierNotes = [
    ...result.automaticModifiers,
    ...result.manualModifiers
  ]
    .filter(modifier => modifier.reason)
    .map(modifier => `${esc(modifier.reason)}: <code>${esc(modifier.formula)}</code>`)
    .join(" · ");

  const flavor = `
    <div class="fast-nri-chat-roll">
      <div class="fast-nri-chat-roll-title">
        <i class="fa-solid fa-dice-d20"></i>
        <strong>${esc(label)}</strong>
      </div>

      ${result.dc !== null ? `
        <div class="fast-nri-chat-roll-meta">
          <span class="fast-nri-chat-dc-label">Сложность</span>
          <strong class="fast-nri-chat-dc-value">${result.dc}</strong>
        </div>
      ` : ""}

      ${degreeHTML(degree)}

      ${modifierNotes ? `
        <div class="fast-nri-chat-modifiers">
          <i class="fa-solid fa-sliders"></i>
          <small>${modifierNotes}</small>
        </div>
      ` : ""}
    </div>
  `;

  await roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor
  });

  return {
    roll,
    formula: result.formula,
    dc: result.dc,
    naturalD20,
    degree
  };
}

export async function rollSkillCheck(actor, skill) {
  const die = String(skill?.value ?? "").trim();
  const baseFormula = die ? `1d20 + ${die}` : "1d20";

  return openPreRollDialog({
    actor,
    label: skill?.label ?? "Проверка навыка",
    baseFormula
  });
}
