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
  defaultDC = null,
  showDC = true,
  contextHTML = ""
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

  return {
    ...result,
    roll,
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

function modifierNotesHTML(result) {
  const notes = [
    ...result.automaticModifiers,
    ...result.manualModifiers
  ]
    .filter(modifier => modifier.reason)
    .map(modifier => `${esc(modifier.reason)}: <code>${esc(modifier.formula)}</code>`)
    .join(" · ");

  if (!notes) return "";

  return `
    <div class="fast-nri-chat-modifiers">
      <i class="fa-solid fa-sliders"></i>
      <small>${notes}</small>
    </div>
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
  defaultDC = null
}) {
  const result = await prepareRoll({
    actor,
    label,
    baseFormula,
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
      ${modifierNotesHTML(result)}
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

  return openPreRollDialog({
    actor,
    label: skill?.label ?? "Проверка навыка",
    baseFormula
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
      ${modifierNotesHTML(result)}
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
        critical
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

  const labels = {
    partial: "Частичный",
    success: "Успех",
    great: "Большой"
  };

  const result = await prepareRoll({
    actor,
    label: `Урон: ${weapon.name} — ${labels[profile] ?? profile}`,
    baseFormula: formula,
    showDC: false,
    contextHTML: critical ? `
      <section class="fast-nri-roll-context fast-nri-roll-context-critical">
        <i class="fa-solid fa-burst"></i>
        <div>
          <strong>Критический бросок атаки</strong>
          <small>После броска итоговый урон ×2.</small>
        </div>
      </section>
    ` : ""
  });

  if (!result) return null;

  let finalTotal = result.roll.total;
  if (critical) finalTotal *= 2;

  const flavor = `
    <div class="fast-nri-chat-roll fast-nri-damage-card">
      ${rollCardHeader(`Урон: ${weapon.name}`, "fa-burst")}

      <div class="fast-nri-chat-damage-profile-name">
        ${esc(labels[profile] ?? profile)}
      </div>

      ${critical ? `
        <div class="fast-nri-critical-roll">
          <i class="fa-solid fa-xmark"></i>
          <strong>Критический урон: ${result.roll.total} × 2 = ${finalTotal}</strong>
        </div>
      ` : ""}

      <div class="fast-nri-damage-total">
        <span>Итоговый урон</span>
        <strong>${finalTotal}</strong>
      </div>

      <button
        type="button"
        class="fast-nri-apply-damage-button"
        data-fast-nri-apply-damage
        data-damage="${escAttr(finalTotal)}"
        title="Нанести ${escAttr(finalTotal)} урона выделенному токену"
      >
        <i class="fa-solid fa-heart-crack"></i>
        <span>Нанести урон</span>
      </button>

      ${modifierNotesHTML(result)}
    </div>
  `;

  await result.roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor,
    flags: {
      "fast-nri": {
        kind: "damage",
        actorUuid: actor.uuid,
        itemUuid: weapon.uuid,
        profile,
        critical,
        rolledTotal: result.roll.total,
        finalTotal
      }
    }
  });

  return {
    roll: result.roll,
    profile,
    critical,
    finalTotal
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
        "flags.fast-nri.restoredHp": restoredHp
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
    restoredAmount: stored.appliedDamage
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
