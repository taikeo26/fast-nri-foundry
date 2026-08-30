import { rollAbilityOutcome } from "./rolls.mjs";

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


function abilityOutcomeActionHTML(actor, item) {
  const kind = String(item.system?.outcome?.kind ?? "none");
  const data = {
    damage: ["Бросить урон", "fa-burst"],
    healing: ["Бросить восстановление HP", "fa-heart-pulse"],
    tempHp: ["Бросить временные HP", "fa-shield-heart"]
  }[kind];
  if (!data) return "";

  return `
    <div class="fast-nri-ability-outcome-action">
      <button
        type="button"
        data-fast-nri-roll-ability-outcome
        data-actor-uuid="${escAttr(actor.uuid)}"
        data-item-uuid="${escAttr(item.uuid)}"
        title="${escAttr(data[0])}"
      >
        <i class="fa-solid ${data[1]}"></i>
        <span>${esc(data[0])}</span>
      </button>
    </div>`;
}

function resourceLineHTML({
  label,
  cost,
  before,
  after,
  spent,
  shortage,
  undone = false
}) {
  if (!(cost > 0)) return "";

  return `
    <div class="fast-nri-resource-use ${undone ? "undone" : ""}">
      <div class="fast-nri-resource-use-text">
        <span class="fast-nri-resource-label">${esc(label || "Классовый ресурс")}</span>
        <strong>−${esc(cost)}</strong>
        <small>${esc(before)} → ${esc(after)}</small>
        ${shortage > 0 ? `<small class="fast-nri-resource-shortage">не хватает ${esc(shortage)}</small>` : ""}
      </div>

      ${undone || spent <= 0 ? "" : `
        <button
          type="button"
          class="fast-nri-undo-resource-button"
          data-fast-nri-undo-resource
          data-actor-uuid="${escAttr("")}"
          title="Вернуть списанный ресурс"
        >
          <i class="fa-solid fa-rotate-left"></i>
          <span>Вернуть</span>
        </button>
      `}
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
  undone = false
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

      ${abilityOutcomeActionHTML(actor, item)}

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
  const max = Math.max(0, Number(resource.max) || 0);

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

  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: false
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
    shortage
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
  const max = Math.max(0, Number(actor.system?.classResource?.max) || 0);

  let restored = current + spent;
  if (max > 0) restored = Math.min(max, restored);

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

  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: true
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
        await rollAbilityOutcome(actor, item);
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
