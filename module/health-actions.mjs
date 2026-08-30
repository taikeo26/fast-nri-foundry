import { HP_GAIN_DEFENSE_TRAITS, HP_GAIN_SOURCE_TRAITS } from "./config.mjs";

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function messageIdFromElement(element) {
  return element?.closest(".chat-message, .message")?.dataset?.messageId ?? null;
}

function chatMessageFromElement(element) {
  const id = messageIdFromElement(element);
  return id ? game.messages?.get(id) ?? null : null;
}

function controlledSingleToken() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);
  if (controlled.length === 0) {
    ui.notifications.warn("Выдели один токен, к которому нужно применить Получение HP.");
    return null;
  }
  if (controlled.length > 1) {
    ui.notifications.warn("Для Получения HP должен быть выделен только один токен.");
    return null;
  }
  return controlled[0];
}

function hpGainPartMatchIds(part) {
  return new Set(part?.traitIds ?? []);
}

function numericEntries(actor, idsPath, valuesPath) {
  const ids = Array.from(foundry.utils.getProperty(actor.system, idsPath) ?? []);
  const values = foundry.utils.getProperty(actor.system, valuesPath) ?? {};
  return ids.map(id => ({
    id,
    label: HP_GAIN_DEFENSE_TRAITS[id] ?? id,
    value: Math.max(0, Number(values?.[id]) || 0)
  })).filter(entry => entry.value > 0);
}

export function resolveHpGainAgainstActor(state, actor) {
  const sourceParts = (state?.parts ?? []).map(part => foundry.utils.deepClone(part));
  const immunityIds = new Set(actor?.system?.hpGainImmunityIds ?? []);
  const survivingParts = [];
  const immuneParts = [];

  for (const part of sourceParts) {
    const matches = hpGainPartMatchIds(part);
    const immunityId = immunityIds.has("universal")
      ? "universal"
      : Array.from(immunityIds).find(id => matches.has(id)) ?? null;

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

  const activeMatchIds = new Set();
  for (const part of survivingParts) {
    for (const id of hpGainPartMatchIds(part)) activeMatchIds.add(id);
  }

  const reductions = numericEntries(actor, "hpGainReductionIds", "hpGainReductionValues")
    .filter(entry => entry.id === "universal"
      ? survivingParts.length > 0
      : activeMatchIds.has(entry.id))
    .sort((a, b) => b.value - a.value);

  const bonuses = numericEntries(actor, "hpGainBonusIds", "hpGainBonusValues")
    .filter(entry => entry.id === "universal"
      ? survivingParts.length > 0
      : activeMatchIds.has(entry.id))
    .sort((a, b) => b.value - a.value);

  const reduction = reductions[0] ?? null;
  const bonus = bonuses[0] ?? null;

  const partsTotal = survivingParts.reduce(
    (sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0),
    0
  );
  const penalty = (state?.penalties ?? []).reduce(
    (sum, part) => sum + Math.max(0, Number(part.currentValue ?? part.value) || 0),
    0
  );
  const afterPenalty = Math.max(0, partsTotal - penalty);
  const afterReduction = Math.max(0, afterPenalty - (reduction?.value ?? 0));
  const finalAmount = Math.max(0, afterReduction + (bonus?.value ?? 0));

  return {
    sourceParts,
    survivingParts,
    immuneParts,
    activeMatchIds: Array.from(activeMatchIds),
    matchingReductions: reductions,
    matchingBonuses: bonuses,
    reduction,
    bonus,
    partsTotal,
    penalty,
    afterPenalty,
    afterReduction,
    finalAmount
  };
}

function hpGainPartLabel(part) {
  if (part?.kind === "die") return `d${part.faces}: ${part.value}`;
  return `+${part?.value ?? 0}`;
}

function resolutionHTML(resolution) {
  const immune = (resolution.immuneParts ?? []).map(part => {
    const label = HP_GAIN_DEFENSE_TRAITS[part.immunityId] ?? part.immunityId;
    return `<div>Иммунитет к Получению HP: <strong>${esc(label)}</strong> — ${esc(hpGainPartLabel(part))} удалён</div>`;
  }).join("");

  return `
    <div class="fast-nri-damage-resolution fast-nri-hp-gain-resolution">
      ${immune}
      <div>После Иммунитетов: <strong>${esc(resolution.afterPenalty)}</strong></div>
      ${resolution.reduction ? `<div>Лучшее Снижение Получения HP: <strong>${esc(resolution.reduction.label)} −${esc(resolution.reduction.value)}</strong></div>` : ""}
      ${resolution.bonus ? `<div>Лучший Бонус Получения HP: <strong>${esc(resolution.bonus.label)} +${esc(resolution.bonus.value)}</strong></div>` : ""}
      <div>Итог Получения HP: <strong>${esc(resolution.finalAmount)}</strong></div>
    </div>`;
}

function applicationMessageContent({
  kind,
  tokenName,
  resolution,
  applied,
  previousHp,
  afterHp,
  maxHp,
  previousTemp,
  afterTemp,
  tokenUuid,
  actorUuid,
  undone = false
}) {
  const healing = kind === "healing";
  const title = healing ? "Восстановление HP" : "Временные HP";
  const amountLine = healing
    ? `${esc(tokenName)} восстанавливает <strong>${esc(applied)} HP</strong>`
    : applied > 0
      ? `${esc(tokenName)} получает <strong>${esc(afterTemp)} временных HP</strong> (${esc(previousTemp)} → ${esc(afterTemp)})`
      : `${esc(tokenName)} сохраняет <strong>${esc(previousTemp)} временных HP</strong>`;

  return `
    <div class="fast-nri-hp-application-message ${undone ? "undone" : ""}">
      <div class="fast-nri-chat-roll-title">
        <i class="fa-solid ${healing ? "fa-heart-pulse" : "fa-shield-heart"}"></i>
        <strong>${title}</strong>
      </div>
      <div class="fast-nri-hp-application-line">${amountLine}</div>
      ${healing ? `<small>HP: ${esc(previousHp)} → ${esc(afterHp)} / ${esc(maxHp)}</small>` : ""}
      ${resolutionHTML(resolution)}
      ${undone || applied <= 0 ? "" : `
        <button
          type="button"
          class="fast-nri-undo-health-button"
          data-fast-nri-undo-health
          data-token-uuid="${escAttr(tokenUuid)}"
          data-actor-uuid="${escAttr(actorUuid)}"
          title="Отменить изменение HP"
        ><i class="fa-solid fa-rotate-left"></i> Вернуть</button>`}
    </div>`;
}

export function resolveTemporaryHp(currentTemp, receivedAmount) {
  const current = Math.max(0, Number(currentTemp) || 0);
  const received = Math.max(0, Number(receivedAmount) || 0);
  return Math.max(current, received);
}

export async function applyHpGainFromChat(element, kind) {
  const token = controlledSingleToken();
  if (!token?.actor) return null;

  const actor = token.actor;
  const sourceMessage = chatMessageFromElement(element);
  const state = sourceMessage?.getFlag("fast-nri", "hpGainState");
  if (!state?.supported) {
    ui.notifications.error("Не удалось получить структуру Получения HP из карточки.");
    return null;
  }

  const resolution = resolveHpGainAgainstActor(state, actor);
  const amount = Math.max(0, Number(resolution.finalAmount) || 0);
  const previousHp = Math.max(0, Number(actor.system?.hp?.value) || 0);
  const maxHp = Math.max(0, Number(actor.system?.hp?.max) || 0);
  const previousTemp = Math.max(0, Number(actor.system?.hp?.temp) || 0);

  let afterHp = previousHp;
  let afterTemp = previousTemp;
  let applied = 0;

  if (kind === "healing") {
    afterHp = Math.min(maxHp, previousHp + amount);
    applied = Math.max(0, afterHp - previousHp);
  } else {
    afterTemp = resolveTemporaryHp(previousTemp, amount);
    applied = Math.max(0, afterTemp - previousTemp);
  }

  const update = kind === "healing"
    ? { "system.hp.value": afterHp }
    : { "system.hp.temp": afterTemp };

  try {
    await actor.update(update);
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка Получения HP", error);
    ui.notifications.error("Не удалось изменить HP выделенного токена.");
    return null;
  }

  const tokenUuid = token.document?.uuid ?? "";
  const actorUuid = actor.uuid;
  const tokenName = token.name || actor.name || "Цель";
  const content = applicationMessageContent({
    kind,
    tokenName,
    resolution,
    applied,
    previousHp,
    afterHp,
    maxHp,
    previousTemp,
    afterTemp,
    tokenUuid,
    actorUuid
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor, token: token.document }),
    content,
    flags: {
      "fast-nri": {
        kind: kind === "healing" ? "healing-applied" : "temp-hp-applied",
        tokenUuid,
        actorUuid,
        tokenName,
        requestedAmount: amount,
        appliedAmount: applied,
        appliedHealing: kind === "healing" ? applied : 0,
        appliedTempIncrease: kind === "tempHp" ? applied : 0,
        previousHp,
        afterHp,
        maxHp,
        previousTemp,
        afterTemp,
        resolution,
        undone: false
      }
    }
  });

  return { message, actor, token, amount, applied, resolution };
}

async function actorFromMessage(message) {
  const tokenUuid = message.getFlag("fast-nri", "tokenUuid");
  if (tokenUuid) {
    try {
      const tokenDocument = await fromUuid(tokenUuid);
      if (tokenDocument?.actor) return tokenDocument.actor;
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось получить Token для Undo Получения HP", error);
    }
  }
  const actorUuid = message.getFlag("fast-nri", "actorUuid");
  return actorUuid ? fromUuid(actorUuid) : null;
}

export async function undoHpGainFromChat(element) {
  const message = chatMessageFromElement(element);
  const kind = message?.getFlag("fast-nri", "kind");
  if (!message || !["healing-applied", "temp-hp-applied"].includes(kind)) {
    ui.notifications.error("Не удалось найти данные Получения HP.");
    return null;
  }
  if (message.getFlag("fast-nri", "undone")) {
    ui.notifications.info("Это изменение HP уже отменено.");
    return null;
  }

  const actor = await actorFromMessage(message);
  if (!actor) {
    ui.notifications.error("Не удалось найти Actor для отмены.");
    return null;
  }

  const applied = Math.max(0, Number(message.getFlag("fast-nri", "appliedAmount")) || 0);
  if (applied <= 0) return null;

  if (kind === "healing-applied") {
    const current = Math.max(0, Number(actor.system?.hp?.value) || 0);
    const after = Math.max(0, current - applied);
    await actor.update({ "system.hp.value": after });
  } else {
    const current = Math.max(0, Number(actor.system?.hp?.temp) || 0);
    const expectedAfter = Math.max(0, Number(message.getFlag("fast-nri", "afterTemp")) || 0);
    const previous = Math.max(0, Number(message.getFlag("fast-nri", "previousTemp")) || 0);

    // Временные HP заменяются наибольшим значением, поэтому безопасный Undo
    // возможен только пока после этой карточки значение не было изменено снова.
    if (current !== expectedAfter) {
      ui.notifications.warn("Временные HP уже изменились после этой карточки. Автоматический Undo отменён, чтобы не стереть более новый эффект.");
      return null;
    }
    await actor.update({ "system.hp.temp": previous });
  }

  const tokenName = message.getFlag("fast-nri", "tokenName") || actor.name;
  const resolution = message.getFlag("fast-nri", "resolution") ?? {
    immuneParts: [], afterPenalty: 0, reduction: null, bonus: null, finalAmount: 0
  };
  const previousHp = Number(message.getFlag("fast-nri", "previousHp")) || 0;
  const afterHp = Number(message.getFlag("fast-nri", "afterHp")) || 0;
  const maxHp = Number(message.getFlag("fast-nri", "maxHp")) || 0;
  const previousTemp = Number(message.getFlag("fast-nri", "previousTemp")) || 0;
  const afterTemp = Number(message.getFlag("fast-nri", "afterTemp")) || 0;

  const content = applicationMessageContent({
    kind: kind === "healing-applied" ? "healing" : "tempHp",
    tokenName,
    resolution,
    applied,
    previousHp,
    afterHp,
    maxHp,
    previousTemp,
    afterTemp,
    tokenUuid: message.getFlag("fast-nri", "tokenUuid") || "",
    actorUuid: actor.uuid,
    undone: true
  });

  await message.update({
    content,
    "flags.fast-nri.undone": true,
    "flags.fast-nri.restoredAmount": applied
  });

  return { actor, applied };
}

export function activateHealthChatInteractions(root = document) {
  root.addEventListener("click", async event => {
    const healing = event.target.closest("[data-fast-nri-apply-healing]");
    if (healing) {
      event.preventDefault();
      event.stopPropagation();
      if (healing.dataset.fastNriBusy === "true") return;
      healing.dataset.fastNriBusy = "true";
      try { await applyHpGainFromChat(healing, "healing"); }
      finally { delete healing.dataset.fastNriBusy; }
      return;
    }

    const temp = event.target.closest("[data-fast-nri-apply-temp-hp]");
    if (temp) {
      event.preventDefault();
      event.stopPropagation();
      if (temp.dataset.fastNriBusy === "true") return;
      temp.dataset.fastNriBusy = "true";
      try { await applyHpGainFromChat(temp, "tempHp"); }
      finally { delete temp.dataset.fastNriBusy; }
      return;
    }

    const undo = event.target.closest("[data-fast-nri-undo-health]");
    if (undo) {
      event.preventDefault();
      event.stopPropagation();
      if (undo.dataset.fastNriBusy === "true") return;
      undo.dataset.fastNriBusy = "true";
      try { await undoHpGainFromChat(undo); }
      finally { delete undo.dataset.fastNriBusy; }
    }
  });
}
