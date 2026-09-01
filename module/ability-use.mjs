import { rollAbilityCheck, rollAbilityOutcome } from "./rolls.mjs";
import { abilityCheckConfig } from "./check-system.mjs";
import { effectChatCardHTML, resolveEffectDocuments } from "./effect-system.mjs";

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

function messageIdFromElement(element) {
  return element
    ?.closest(".chat-message, .message")
    ?.dataset?.messageId ?? null;
}


export function configuredOutcomeKinds(item) {
  const config = item.system?.outcomes ?? {};
  const result = [];

  for (const kind of ["damage", "healing", "tempHp"]) {
    if (config?.[kind]?.enabled) result.push(kind);
  }

  // Backward-compatible read for 0.5.16 Items.
  const legacyKind = String(item.system?.outcome?.kind ?? "none");
  if (
    ["damage", "healing", "tempHp"].includes(legacyKind)
    && !result.includes(legacyKind)
  ) {
    result.push(legacyKind);
  }

  return result;
}

function outcomeActionButtonHTML(actor, item, kind) {
  const labels = {
    damage: ["fa-burst", "Бросить урон"],
    healing: ["fa-heart-pulse", "Бросить лечение"],
    tempHp: ["fa-shield-heart", "Бросить временные HP"]
  };
  const [icon, label] = labels[kind] ?? ["fa-dice", "Выполнить результат"];

  return `
    <button
      type="button"
      data-fast-nri-roll-ability-outcome
      data-actor-uuid="${escAttr(actor.uuid)}"
      data-item-uuid="${escAttr(item.uuid)}"
      data-outcome-kind="${escAttr(kind)}"
    >
      <i class="fa-solid ${icon}"></i>
      <span>${label}</span>
    </button>
  `;
}

function abilityActionsHTML(actor, item) {
  const outcomeKinds = configuredOutcomeKinds(item);
  const checkEnabled = abilityCheckConfig(item).enabled;
  const actions = [];

  if (checkEnabled) {
    actions.push(`
      <button
        type="button"
        data-fast-nri-roll-ability-check
        data-actor-uuid="${escAttr(actor.uuid)}"
        data-item-uuid="${escAttr(item.uuid)}"
      >
        <i class="fa-solid fa-dice-d20"></i>
        <span>Выполнить проверку</span>
      </button>
    `);
  }

  for (const kind of outcomeKinds) {
    // Урон Ability с Check становится явным следующим шагом на карточке
    // уже выполненной проверки. Остальные независимые результаты остаются
    // доступны прямо из исходной карточки Ability.
    if (kind === "damage" && checkEnabled) continue;
    actions.push(outcomeActionButtonHTML(actor, item, kind));
  }

  if (!actions.length) return "";

  return `
    <div class="fast-nri-ability-outcome-actions">
      ${actions.join("")}
    </div>
  `;
}

function abilityCardHTML({
  actor,
  item,
  cost,
  before,
  after,
  spent,
  shortage,
  undone = false,
  linkedEffects = []
}) {
  const categoryLabel = item.system?.category === "spell" ? "Заклинание" : "Способность";
  const resourceLabel = actor.system?.classResource?.label || "Классовый ресурс";
  const description = String(item.system?.description ?? "").trim();

  return `
    <div class="fast-nri-ability-use-card ${undone ? "resource-undone" : ""}">
      <div class="fast-nri-chat-roll-title">
        <i class="fa-solid ${item.system?.category === "spell" ? "fa-wand-magic-sparkles" : "fa-bolt"}"></i>
        <strong>${esc(item.name)}</strong>
      </div>

      <div class="fast-nri-ability-use-meta">
        <span>${esc(categoryLabel)}</span>
        ${item.system?.timing ? `<span>${esc(item.system.timing)}</span>` : ""}
      </div>

      ${description ? `
        <div class="fast-nri-ability-description">
          ${description}
        </div>
      ` : ""}

      ${linkedEffects.length ? `
        <div class="fast-nri-ability-linked-effects">
          <small>Эффекты — перетащите на токен:</small>
          ${linkedEffects.map(effect => effectChatCardHTML(effect, { compact: true })).join("")}
        </div>
      ` : ""}

      ${abilityActionsHTML(actor, item)}

      ${cost > 0 ? `
        <div class="fast-nri-resource-use ${undone ? "undone" : ""}">
          <div class="fast-nri-resource-use-text">
            <span class="fast-nri-resource-label">${esc(resourceLabel)}</span>
            <strong>−${esc(cost)}</strong>
            <small>${esc(before)} → ${esc(after)}</small>
            ${shortage > 0 ? `<small class="fast-nri-resource-shortage">не хватает ${esc(shortage)}</small>` : ""}
          </div>

          ${undone || spent <= 0 ? "" : `
            <button
              type="button"
              class="fast-nri-undo-resource-button"
              data-fast-nri-undo-resource
              data-actor-uuid="${escAttr(actor.uuid)}"
              data-item-uuid="${escAttr(item.uuid)}"
              data-spent="${escAttr(spent)}"
              title="Вернуть списанный ресурс"
            >
              <i class="fa-solid fa-rotate-left"></i>
              <span>Вернуть</span>
            </button>
          `}
        </div>
      ` : ""}
    </div>
  `;
}

export async function useAbility(actor, item) {
  if (!actor || !item || item.type !== "ability") return null;

  const cost = Math.max(0, Number(item.system?.classResourceCost) || 0);
  const resource = actor.system?.classResource ?? {};
  const before = Math.max(0, Number(resource.value) || 0);

  let after = before;
  let spent = 0;
  let shortage = 0;

  if (cost > 0) {
    shortage = Math.max(0, cost - before);

    if (shortage > 0) {
      ui.notifications.warn(
        `${actor.name}: недостаточно ресурса «${resource.label || "Классовый ресурс"}». ` +
        `Нужно ${cost}, доступно ${before}. Использование не блокируется.`
      );
    }

    after = Math.max(0, before - cost);
    spent = before - after;

    try {
      await actor.update({
        "system.classResource.value": after
      });
    } catch (error) {
      console.error("Быстрая НРИ | Ошибка списания классового ресурса", error);
      ui.notifications.error("Не удалось изменить классовый ресурс.");
      return null;
    }
  }

  const linkedEffects = await resolveEffectDocuments(
    item.system?.effectUuids ?? []
  );

  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: false,
    linkedEffects
  });

  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: {
      "fast-nri": {
        kind: "ability-use",
        actorUuid: actor.uuid,
        itemUuid: item.uuid,
        cost,
        before,
        after,
        spent,
        shortage,
        resourceUndone: false
      }
    }
  });

  return {
    message,
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    outcomeKinds: configuredOutcomeKinds(item)
  };
}

export async function undoAbilityResource(element) {
  const messageId = messageIdFromElement(element);
  const message = messageId ? game.messages?.get(messageId) : null;

  if (!message || message.getFlag("fast-nri", "kind") !== "ability-use") {
    ui.notifications.error("Не удалось найти данные использования способности.");
    return null;
  }

  if (message.getFlag("fast-nri", "resourceUndone")) {
    ui.notifications.info("Ресурс уже возвращён.");
    return null;
  }

  const actorUuid = message.getFlag("fast-nri", "actorUuid");
  const itemUuid = message.getFlag("fast-nri", "itemUuid");
  const spent = Number(message.getFlag("fast-nri", "spent")) || 0;

  if (!(spent > 0)) {
    ui.notifications.info("Для этого использования ресурс фактически не списывался.");
    return null;
  }

  const actor = await fromUuid(actorUuid);
  const item = await fromUuid(itemUuid);

  if (!actor || !item) {
    ui.notifications.error("Не удалось найти персонажа или способность.");
    return null;
  }

  const current = Math.max(0, Number(actor.system?.classResource?.value) || 0);
  const restored = current + spent;

  try {
    await actor.update({
      "system.classResource.value": restored
    });
  } catch (error) {
    console.error("Быстрая НРИ | Ошибка возврата классового ресурса", error);
    ui.notifications.error("Не удалось вернуть классовый ресурс.");
    return null;
  }

  const cost = Number(message.getFlag("fast-nri", "cost")) || 0;
  const before = Number(message.getFlag("fast-nri", "before")) || 0;
  const after = Number(message.getFlag("fast-nri", "after")) || 0;
  const shortage = Number(message.getFlag("fast-nri", "shortage")) || 0;

  const linkedEffects = await resolveEffectDocuments(
    item.system?.effectUuids ?? []
  );

  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: true,
    linkedEffects
  });

  await message.update({
    content,
    "flags.fast-nri.resourceUndone": true,
    "flags.fast-nri.resourceRestoredTo": restored
  });

  return {
    actor,
    item,
    restored,
    restoredAmount: spent
  };
}

export function activateAbilityChatInteractions(root = document) {
  root.addEventListener("click", async event => {
    const checkButton = event.target.closest(
      "[data-fast-nri-roll-ability-check], [data-fast-nri-roll-ability-attack]"
    );
    if (checkButton) {
      event.preventDefault();
      event.stopPropagation();

      if (checkButton.dataset.fastNriBusy === "true") return;
      checkButton.dataset.fastNriBusy = "true";

      try {
        const actor = await fromUuid(checkButton.dataset.actorUuid);
        const item = await fromUuid(checkButton.dataset.itemUuid);
        if (!actor || !item || item.type !== "ability") {
          ui.notifications.error("Не удалось найти способность или заклинание.");
          return;
        }
        await rollAbilityCheck(actor, item);
      } finally {
        delete checkButton.dataset.fastNriBusy;
      }
      return;
    }

    const outcomeButton = event.target.closest("[data-fast-nri-roll-ability-outcome]");
    if (outcomeButton) {
      event.preventDefault();
      event.stopPropagation();

      if (outcomeButton.dataset.fastNriBusy === "true") return;
      outcomeButton.dataset.fastNriBusy = "true";

      try {
        const actor = await fromUuid(outcomeButton.dataset.actorUuid);
        const item = await fromUuid(outcomeButton.dataset.itemUuid);
        if (!actor || !item || item.type !== "ability") {
          ui.notifications.error("Не удалось найти способность или заклинание.");
          return;
        }
        let sourceAttack = null;
        if (outcomeButton.dataset.sourceAttack === "true") {
          const sourceMessageId = messageIdFromElement(outcomeButton);
          const sourceMessage = sourceMessageId
            ? game.messages?.get(sourceMessageId) ?? null
            : null;

          const sourceKind = sourceMessage?.getFlag("fast-nri", "kind");
          if (!sourceMessage || !["ability-check", "ability-attack"].includes(sourceKind)) {
            ui.notifications.error("Не удалось найти исходную проверку способности.");
            return;
          }

          sourceAttack = {
            message: sourceMessage,
            total: sourceMessage.getFlag("fast-nri", "rollTotal"),
            naturalD20: sourceMessage.getFlag("fast-nri", "naturalD20"),
            degree: sourceMessage.getFlag("fast-nri", "degree"),
            critical: Boolean(sourceMessage.getFlag("fast-nri", "critical")),
            targetUuid: sourceMessage.getFlag("fast-nri", "targetUuid"),
            directedDefense: Boolean(sourceMessage.getFlag("fast-nri", "directedDefense")),
            attackType: sourceMessage.getFlag("fast-nri", "attackType"),
            targetCharacteristic: sourceMessage.getFlag("fast-nri", "targetCharacteristic") ?? "armor",
            actionTraits: sourceMessage.getFlag("fast-nri", "actionTraits") ?? {}
          };
        }

        await rollAbilityOutcome(
          actor,
          item,
          outcomeButton.dataset.outcomeKind,
          sourceAttack
        );
      } finally {
        delete outcomeButton.dataset.fastNriBusy;
      }
      return;
    }

    const undoButton = event.target.closest("[data-fast-nri-undo-resource]");
    if (!undoButton) return;

    event.preventDefault();
    event.stopPropagation();

    if (undoButton.dataset.fastNriBusy === "true") return;
    undoButton.dataset.fastNriBusy = "true";

    try {
      await undoAbilityResource(undoButton);
    } finally {
      delete undoButton.dataset.fastNriBusy;
    }
  });
}
