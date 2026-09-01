import { rollAbilityCheck, rollAbilityOutcome } from "./rolls.mjs";
import { abilityCheckConfig, checkTargetCharacteristicLabel } from "./check-system.mjs";
import { effectChatCardHTML, resolveEffectDocuments } from "./effect-system.mjs";
import {
  ABILITY_PROFILE_DEGREES,
  abilityAreaSummary,
  abilityConfiguredOutcomeKinds,
  abilityCostLabel,
  abilityCosts,
  abilityHasDegreeProfiles,
  abilityIsSpell,
  abilityProfile,
  abilityRangeSummary,
  abilityTargetSummary,
  abilityTraitLabels
} from "./ability-authoring.mjs";
import { actionContextFromAbility } from "./action-context.mjs";

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


export function configuredOutcomeKinds(item, degree = null) {
  return abilityConfiguredOutcomeKinds(item, degree);
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
  const checkEnabled = abilityCheckConfig(item).enabled;
  const profileDriven = abilityHasDegreeProfiles(item);
  const outcomeKinds = configuredOutcomeKinds(item);
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

  // Degree profiles are resolved only after the Check. Legacy/no-Check
  // channels remain available from the source card for compatibility.
  if (!checkEnabled || !profileDriven) {
    for (const kind of outcomeKinds) {
      if (kind === "damage" && checkEnabled) continue;
      actions.push(outcomeActionButtonHTML(actor, item, kind));
    }
  }

  if (!actions.length) return "";
  return `<div class="fast-nri-ability-outcome-actions">${actions.join("")}</div>`;
}

async function enrichHTML(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation
    ?? globalThis.foundry?.applications?.ux?.TextEditor;
  if (typeof editor?.enrichHTML === "function") {
    try {
      return await editor.enrichHTML(source, { async: true });
    } catch (error) {
      console.warn("Быстрая НРИ | Не удалось обогатить rich text Ability", error);
    }
  }
  return source;
}

function metaRow(label, value) {
  return value ? `<div class="fast-nri-ability-rule-row"><strong>${esc(label)}:</strong><span>${value}</span></div>` : "";
}

function profileFormulaSummary(profile, kind) {
  const channel = profile?.[kind];
  if (!channel?.enabled) return "";
  const formulas = Array.from(channel.components ?? [])
    .map(component => String(component?.formula ?? "").trim())
    .filter(Boolean);
  if (!formulas.length) return "";
  const label = kind === "damage" ? "Урон" : kind === "healing" ? "Лечение" : "Временные HP";
  return `<span><strong>${esc(label)}:</strong> ${esc(formulas.join(" + "))}</span>`;
}

async function enrichedAbilityCardData(item, linkedEffects = []) {
  const profiles = [];
  for (const [degree, label] of Object.entries(ABILITY_PROFILE_DEGREES)) {
    const profile = abilityProfile(item, degree);
    if (!profile.enabled) continue;
    profiles.push({
      degree,
      label,
      text: await enrichHTML(profile.text),
      damage: profileFormulaSummary(profile, "damage"),
      healing: profileFormulaSummary(profile, "healing"),
      tempHp: profileFormulaSummary(profile, "tempHp")
    });
  }

  const effectCards = [];
  for (const effect of linkedEffects) {
    effectCards.push(effectChatCardHTML(effect, {
      compact: true,
      descriptionHTML: await enrichHTML(effect.system?.description)
    }));
  }

  return {
    description: await enrichHTML(item.system?.description),
    conditionText: await enrichHTML(item.system?.conditionText),
    requirementText: await enrichHTML(item.system?.requirementText),
    limitationText: await enrichHTML(item.system?.limitationText),
    exceptionText: await enrichHTML(item.system?.exceptionText),
    additionalCostText: await enrichHTML(item.system?.costs?.additionalText),
    targetingText: await enrichHTML(item.system?.targeting?.text),
    profiles,
    effectCards
  };
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
  linkedEffects = [],
  richData = {}
}) {
  const categoryLabel = abilityIsSpell(item) ? "Заклинание" : "Способность";
  const resourceLabel = actor.system?.classResource?.label || "Классовый ресурс";
  const description = String(richData.description ?? item.system?.description ?? "").trim();
  const traits = abilityTraitLabels(item);
  const targetSummary = abilityTargetSummary(item);
  const rangeSummary = abilityRangeSummary(item);
  const areaSummary = abilityAreaSummary(item);
  const check = abilityCheckConfig(item);

  return `
    <div class="fast-nri-ability-use-card ${undone ? "resource-undone" : ""}">
      <div class="fast-nri-chat-roll-title">
        <i class="fa-solid ${abilityIsSpell(item) ? "fa-wand-magic-sparkles" : "fa-bolt"}"></i>
        <strong>${esc(item.name)}</strong>
      </div>

      <div class="fast-nri-ability-use-meta">
        <span>${esc(categoryLabel)}</span>
        ${traits.map(label => `<span>${esc(label)}</span>`).join("")}
      </div>

      <div class="fast-nri-ability-rule-summary">
        ${metaRow("Требуется", esc(abilityCostLabel(item, actor)))}
        ${richData.additionalCostText ? metaRow("Дополнительно", richData.additionalCostText) : ""}
        ${richData.conditionText ? metaRow("Условие", richData.conditionText) : ""}
        ${richData.requirementText ? metaRow("Требование", richData.requirementText) : ""}
        ${targetSummary ? metaRow("Цель", esc(targetSummary)) : ""}
        ${rangeSummary ? metaRow("Дистанция", esc(rangeSummary)) : ""}
        ${areaSummary ? metaRow("Область", esc(areaSummary)) : ""}
        ${richData.targetingText ? metaRow("Цель/область", richData.targetingText) : ""}
        ${check.enabled ? metaRow("Проверка", `${esc(check.formula)} против ${esc(checkTargetCharacteristicLabel(check.targetCharacteristic))}`) : ""}
        ${richData.limitationText ? metaRow("Ограничение", richData.limitationText) : ""}
        ${richData.exceptionText ? metaRow("Исключение", richData.exceptionText) : ""}
      </div>

      ${description ? `<div class="fast-nri-ability-description">${description}</div>` : ""}

      ${richData.profiles?.length ? `
        <div class="fast-nri-ability-profile-summary">
          ${richData.profiles.map(profile => `
            <section class="fast-nri-chat-degree-profile">
              <strong>${esc(profile.label)}</strong>
              <div class="fast-nri-chat-profile-formulas">${profile.damage}${profile.healing}${profile.tempHp}</div>
              ${profile.text ? `<div class="fast-nri-chat-profile-text">${profile.text}</div>` : ""}
            </section>
          `).join("")}
        </div>
      ` : ""}

      ${richData.effectCards?.length ? `
        <div class="fast-nri-ability-linked-effects">
          <small>Эффекты — перетащите на токен:</small>
          ${richData.effectCards.join("")}
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

async function chooseClassResourceCost(actor, item) {
  const costs = abilityCosts(item);
  const min = costs.classResourceMin;
  const max = costs.classResourceMax;
  if (max <= min) return min;

  const { DialogV2 } = foundry.applications.api;
  const choices = [];
  for (let amount = min; amount <= max; amount += 1) {
    choices.push({
      action: `cost-${amount}`,
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

export async function useAbility(actor, item) {
  if (!actor || !item || item.type !== "ability") return null;

  const selectedCost = await chooseClassResourceCost(actor, item);
  if (selectedCost === null) return null;
  const cost = Math.max(0, Number(selectedCost) || 0);
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
  const actionContext = actionContextFromAbility(actor, item);
  const richData = await enrichedAbilityCardData(item, linkedEffects);

  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: false,
    linkedEffects,
    richData
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
        resourceUndone: false,
        actionContext
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
    actionContext,
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

  const richData = await enrichedAbilityCardData(item, linkedEffects);
  const content = abilityCardHTML({
    actor,
    item,
    cost,
    before,
    after,
    spent,
    shortage,
    undone: true,
    linkedEffects,
    richData
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
        const sourceMessageId = messageIdFromElement(checkButton);
        const sourceMessage = sourceMessageId
          ? game.messages?.get(sourceMessageId) ?? null
          : null;
        await rollAbilityCheck(actor, item, {
          actionContext: sourceMessage?.getFlag("fast-nri", "actionContext") ?? null,
          parentMessageId: sourceMessage?.id ?? null
        });
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
        const sourceMessageId = messageIdFromElement(outcomeButton);
        const sourceMessage = sourceMessageId
          ? game.messages?.get(sourceMessageId) ?? null
          : null;
        const sourceActionContext = sourceMessage?.getFlag("fast-nri", "actionContext") ?? null;

        let sourceAttack = null;
        if (outcomeButton.dataset.sourceAttack === "true") {
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
            actionTraits: sourceMessage.getFlag("fast-nri", "actionTraits") ?? {},
            actionContext: sourceActionContext
          };
        }

        await rollAbilityOutcome(
          actor,
          item,
          outcomeButton.dataset.outcomeKind,
          sourceAttack,
          sourceActionContext
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
