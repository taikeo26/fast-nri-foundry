import { rollAbilityCheck, rollAbilityOutcome } from "./rolls.mjs";
import { abilityCheckConfig, checkTargetCharacteristicLabel } from "./check-system.mjs";
import { effectChatCardHTML, resolveEffectDocuments } from "./effect-system.mjs";
import {
  ABILITY_PROFILE_DEGREES,
  abilityAreaPresets,
  abilityAreaPresetLabel,
  abilityConfiguredOutcomeKinds,
  abilityCostLabel,
  abilityCosts,
  abilityHasDegreeProfiles,
  abilityImplementation,
  abilityImplementationRepeat,
  abilityImplementationRuntime,
  abilityImplementations,
  abilityIsSpell,
  abilityProfile,
  abilityRangeSummary,
  abilityTargetSummary,
  abilityTraitLabels
} from "./ability-authoring.mjs";
import { actionContextFromAbility } from "./action-context.mjs";
import { placeAbilityAreaPreset } from "./area-templates.mjs";

function esc(value) { return foundry.utils.escapeHTML(String(value ?? "")); }
function escAttr(value) { return esc(value).replaceAll('"', "&quot;"); }
function messageIdFromElement(element) {
  return element?.closest(".chat-message, .message")?.dataset?.messageId ?? null;
}

export function configuredOutcomeKinds(itemOrRuntime, degree = null) {
  return abilityConfiguredOutcomeKinds(itemOrRuntime, degree);
}

async function enrichHTML(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  const editor = globalThis.foundry?.applications?.ux?.TextEditor?.implementation
    ?? globalThis.foundry?.applications?.ux?.TextEditor;
  if (typeof editor?.enrichHTML === "function") {
    try { return await editor.enrichHTML(source, { async: true }); }
    catch (error) { console.warn("Быстрая НРИ | Не удалось обогатить rich text Ability", error); }
  }
  return source;
}

function metaRow(label, value) {
  return value ? `<div class="fast-nri-ability-rule-row"><strong>${esc(label)}:</strong><span>${value}</span></div>` : "";
}

function profileFormulaSummary(profile, kind) {
  const channel = profile?.[kind];
  if (!channel?.enabled) return "";
  const formulas = Array.from(channel.components ?? []).map(c => String(c?.formula ?? "").trim()).filter(Boolean);
  if (!formulas.length) return "";
  const label = kind === "damage" ? "Урон" : kind === "healing" ? "Лечение" : "Временные HP";
  return `<span><strong>${esc(label)}:</strong> ${esc(formulas.join(" + "))}</span>`;
}

async function enrichedImplementationData(item, runtime) {
  const profiles = [];
  for (const [degree, label] of Object.entries(ABILITY_PROFILE_DEGREES)) {
    const profile = abilityProfile(runtime, degree);
    if (!profile.enabled) continue;
    const effects = await resolveEffectDocuments(profile.effectUuids);
    profiles.push({
      degree,
      label,
      text: await enrichHTML(profile.text),
      damage: profileFormulaSummary(profile, "damage"),
      healing: profileFormulaSummary(profile, "healing"),
      tempHp: profileFormulaSummary(profile, "tempHp"),
      effects: await Promise.all(effects.map(async effect => effectChatCardHTML(effect, {
        compact: true,
        descriptionHTML: await enrichHTML(effect.system?.description)
      })))
    });
  }
  const areas = await Promise.all(abilityAreaPresets(runtime).map(async area => ({
    ...area,
    label: abilityAreaPresetLabel(area),
    textHTML: await enrichHTML(area.text),
    draggable: area.type !== "special"
  })));
  const linkedEffects = await resolveEffectDocuments(runtime.system?.effectUuids ?? []);
  return {
    commonDescription: await enrichHTML(item.system?.description),
    description: await enrichHTML(runtime.system?.description),
    conditionText: await enrichHTML(runtime.system?.conditionText),
    requirementText: await enrichHTML(runtime.system?.requirementText),
    limitationText: await enrichHTML(runtime.system?.limitationText),
    exceptionText: await enrichHTML(runtime.system?.exceptionText),
    additionalCostText: await enrichHTML(runtime.system?.costs?.additionalText),
    targetingText: await enrichHTML(runtime.system?.targeting?.text),
    areas,
    profiles,
    linkedEffects: await Promise.all(linkedEffects.map(async effect => effectChatCardHTML(effect, {
      compact: true,
      descriptionHTML: await enrichHTML(effect.system?.description)
    })))
  };
}

function outcomeButtonHTML(actor, item, runtime, kind, repeatIndex = 0) {
  const labels = {
    damage: ["fa-burst", "Бросить урон"],
    healing: ["fa-heart-pulse", "Бросить лечение"],
    tempHp: ["fa-shield-heart", "Бросить временные HP"]
  };
  const [icon, label] = labels[kind] ?? ["fa-dice", "Выполнить результат"];
  const repeat = abilityImplementationRepeat(runtime);
  const suffix = repeat.count > 1 ? ` — ${repeat.label} ${repeatIndex + 1}` : "";
  return `<button type="button" data-fast-nri-roll-ability-outcome
    data-actor-uuid="${escAttr(actor.uuid)}" data-item-uuid="${escAttr(item.uuid)}"
    data-implementation-id="${escAttr(runtime.implementationId ?? "")}" data-repeat-index="${repeatIndex}"
    data-outcome-kind="${escAttr(kind)}"><i class="fa-solid ${icon}"></i><span>${esc(label + suffix)}</span></button>`;
}

function implementationActionsHTML(actor, item, runtime) {
  const check = abilityCheckConfig(runtime);
  const repeat = abilityImplementationRepeat(runtime);
  const kinds = configuredOutcomeKinds(runtime);
  const groups = [];
  for (let i = 0; i < repeat.count; i += 1) {
    const buttons = [];
    if (check.enabled) {
      buttons.push(`<button type="button" data-fast-nri-roll-ability-check
        data-actor-uuid="${escAttr(actor.uuid)}" data-item-uuid="${escAttr(item.uuid)}"
        data-implementation-id="${escAttr(runtime.implementationId ?? "")}" data-repeat-index="${i}">
        <i class="fa-solid fa-dice-d20"></i><span>Выполнить проверку${repeat.count > 1 ? ` — ${esc(repeat.label)} ${i + 1}` : ""}</span></button>`);
    } else {
      for (const kind of kinds) buttons.push(outcomeButtonHTML(actor, item, runtime, kind, i));
    }
    if (buttons.length) groups.push(`<div class="fast-nri-ability-outcome-actions">${buttons.join("")}</div>`);
  }
  return groups.join("");
}

function choiceCardHTML(actor, item, implementations, descriptionHTML) {
  const categoryLabel = abilityIsSpell(item) ? "Заклинание" : "Способность";
  return `<div class="fast-nri-ability-use-card fast-nri-ability-choice-card">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid ${abilityIsSpell(item) ? "fa-wand-magic-sparkles" : "fa-bolt"}"></i><strong>${esc(item.name)}</strong></div>
    <div class="fast-nri-ability-use-meta"><span>${esc(categoryLabel)}</span><span>Выберите реализацию</span></div>
    ${descriptionHTML ? `<div class="fast-nri-ability-description">${descriptionHTML}</div>` : ""}
    <div class="fast-nri-implementation-choice-actions">
      ${implementations.map(implementation => {
        const runtime = abilityImplementationRuntime(item, implementation.id);
        return `<button type="button" data-fast-nri-use-implementation data-actor-uuid="${escAttr(actor.uuid)}"
          data-item-uuid="${escAttr(item.uuid)}" data-implementation-id="${escAttr(implementation.id)}">
          <strong>${esc(implementation.name)}</strong><small>${esc(abilityCostLabel(runtime, actor))}</small></button>`;
      }).join("")}
    </div>
  </div>`;
}

function implementationAreasHTML(item, runtime, richData) {
  if (!richData.areas?.length) return "";
  return `<div class="fast-nri-area-preset-list">${richData.areas.map(area => {
    if (!area.draggable) {
      return `<div class="fast-nri-area-preset special"><i class="fa-solid fa-draw-polygon"></i><div><strong>${esc(area.label)}</strong>${area.textHTML ? `<div class="fast-nri-area-preset-text">${area.textHTML}</div>` : ""}</div></div>`;
    }
    return `<button type="button" class="fast-nri-area-preset" data-fast-nri-area-place
      data-item-uuid="${escAttr(item.uuid)}" data-implementation-id="${escAttr(runtime.implementationId ?? "")}" data-area-id="${escAttr(area.id)}"
      title="Разместить область штатным инструментом Region"><i class="fa-solid ${area.type === "line" ? "fa-grip-lines" : "fa-vector-square"}"></i><span><strong>${esc(area.label)}</strong>${area.textHTML ? `<span class="fast-nri-area-preset-text">${area.textHTML}</span>` : ""}</span><i class="fa-solid fa-crosshairs"></i></button>`;
  }).join("")}</div>`;
}

function implementationCardHTML({ actor, item, runtime, resource, richData, undone = false }) {
  const traits = abilityTraitLabels(runtime);
  const check = abilityCheckConfig(runtime);
  const targetSummary = abilityTargetSummary(runtime);
  const rangeSummary = abilityRangeSummary(runtime);
  const repeat = abilityImplementationRepeat(runtime);
  return `<div class="fast-nri-ability-use-card ${undone ? "resource-undone" : ""}">
    <div class="fast-nri-chat-roll-title"><i class="fa-solid ${abilityIsSpell(runtime) ? "fa-wand-magic-sparkles" : "fa-bolt"}"></i>
      <strong>${esc(item.name)} — ${esc(runtime.implementationName ?? "Основная реализация")}</strong></div>
    <div class="fast-nri-ability-use-meta">${traits.map(label => `<span>${esc(label)}</span>`).join("")}${repeat.count > 1 ? `<span>${repeat.count} независимых результатов</span>` : ""}</div>
    <div class="fast-nri-ability-rule-summary">
      ${metaRow("Требуется", esc(abilityCostLabel(runtime, actor)))}
      ${richData.additionalCostText ? metaRow("Дополнительно", richData.additionalCostText) : ""}
      ${richData.conditionText ? metaRow("Условие", richData.conditionText) : ""}
      ${richData.requirementText ? metaRow("Требование", richData.requirementText) : ""}
      ${targetSummary ? metaRow("Цель", esc(targetSummary)) : ""}
      ${rangeSummary ? metaRow("Дистанция", esc(rangeSummary)) : ""}
      ${richData.areas?.length ? metaRow("Область", implementationAreasHTML(item, runtime, richData)) : ""}
      ${richData.targetingText ? metaRow("Цель/область", richData.targetingText) : ""}
      ${check.enabled ? metaRow("Проверка", `${esc(check.formula)} против ${esc(checkTargetCharacteristicLabel(check.targetCharacteristic))}`) : ""}
      ${richData.limitationText ? metaRow("Ограничение", richData.limitationText) : ""}
      ${richData.exceptionText ? metaRow("Исключение", richData.exceptionText) : ""}
    </div>
    ${richData.description ? `<div class="fast-nri-ability-description">${richData.description}</div>` : ""}
    ${richData.linkedEffects.length ? `<div class="fast-nri-ability-linked-effects"><small>Эффекты — перетащите на токен:</small>${richData.linkedEffects.join("")}</div>` : ""}
    ${implementationActionsHTML(actor, item, runtime)}
    ${resource.cost > 0 ? `<div class="fast-nri-resource-use ${undone ? "undone" : ""}"><div class="fast-nri-resource-use-text"><span class="fast-nri-resource-label">${esc(resource.label)}</span><strong>−${resource.cost}</strong><small>${resource.before} → ${resource.after}</small>${resource.shortage > 0 ? `<small class="fast-nri-resource-shortage">не хватает ${resource.shortage}</small>` : ""}</div>${undone || resource.spent <= 0 ? "" : `<button type="button" class="fast-nri-undo-resource-button" data-fast-nri-undo-resource data-actor-uuid="${escAttr(actor.uuid)}" data-item-uuid="${escAttr(item.uuid)}" data-spent="${resource.spent}"><i class="fa-solid fa-rotate-left"></i><span>Вернуть</span></button>`}</div>` : ""}
  </div>`;
}

async function spendImplementationResource(actor, runtime) {
  const costs = abilityCosts(runtime);
  const cost = Math.max(0, Number(costs.classResource) || 0);
  const source = actor.system?.classResource ?? {};
  const before = Math.max(0, Number(source.value) || 0);
  const shortage = Math.max(0, cost - before);
  if (shortage > 0) ui.notifications.warn(`${actor.name}: недостаточно ресурса «${source.label || "Классовый ресурс"}». Нужно ${cost}, доступно ${before}. Использование не блокируется.`);
  const after = Math.max(0, before - cost);
  const spent = before - after;
  if (cost > 0) await actor.update({ "system.classResource.value": after });
  return { cost, before, after, spent, shortage, label: source.label || "Классовый ресурс" };
}

export async function useAbilityImplementation(actor, item, implementationId, { parentMessageId = null } = {}) {
  if (!actor || !item || item.type !== "ability") return null;
  const runtime = abilityImplementationRuntime(item, implementationId);
  if (!runtime?.implementationId) return null;
  let resource;
  try { resource = await spendImplementationResource(actor, runtime); }
  catch (error) {
    console.error("Быстрая НРИ | Ошибка списания ресурса реализации", error);
    ui.notifications.error("Не удалось изменить классовый ресурс.");
    return null;
  }

  const actionContext = actionContextFromAbility(actor, item, { implementationId: runtime.implementationId });
  const parentMessage = parentMessageId ? globalThis.game?.messages?.get?.(parentMessageId) ?? null : null;
  const periodicRemovalEffectUuid = parentMessage?.getFlag("fast-nri", "periodicRemovalEffectUuid") ?? null;
  const periodicRemovalSourceTickMessageId = parentMessage?.getFlag("fast-nri", "periodicRemovalSourceTickMessageId") ?? null;
  const richData = await enrichedImplementationData(item, runtime);
  const content = implementationCardHTML({ actor, item, runtime, resource, richData });
  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), content,
    flags: { "fast-nri": {
      kind: "ability-implementation", actorUuid: actor.uuid, itemUuid: item.uuid,
      implementationId: runtime.implementationId, parentMessageId, resourceUndone: false,
      periodicRemovalEffectUuid, periodicRemovalSourceTickMessageId,
      ...resource, actionContext
    } }
  });
  return { message, actor, item, runtime, resource, ...resource, actionContext, outcomeKinds: configuredOutcomeKinds(runtime) };
}

export async function useAbility(actor, item) {
  if (!actor || !item || item.type !== "ability") return null;
  const implementations = abilityImplementations(item);
  if (implementations.length <= 1) return useAbilityImplementation(actor, item, implementations[0]?.id ?? null);
  const description = await enrichHTML(item.system?.description);
  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: choiceCardHTML(actor, item, implementations, description),
    flags: { "fast-nri": { kind: "ability-choice", actorUuid: actor.uuid, itemUuid: item.uuid } }
  });
  return { message, actor, item, implementations, choice: true };
}

export async function undoAbilityResource(element) {
  const messageId = messageIdFromElement(element);
  const message = messageId ? game.messages?.get(messageId) : null;
  if (!message || !["ability-implementation", "ability-use"].includes(message.getFlag("fast-nri", "kind"))) {
    ui.notifications.error("Не удалось найти данные реализации способности."); return null;
  }
  if (message.getFlag("fast-nri", "resourceUndone")) { ui.notifications.info("Ресурс уже возвращён."); return null; }
  const actor = await fromUuid(message.getFlag("fast-nri", "actorUuid"));
  const item = await fromUuid(message.getFlag("fast-nri", "itemUuid"));
  const spent = Number(message.getFlag("fast-nri", "spent")) || 0;
  if (!actor || !item) { ui.notifications.error("Не удалось найти персонажа или способность."); return null; }
  if (!(spent > 0)) { ui.notifications.info("Для этой реализации ресурс фактически не списывался."); return null; }
  const restored = Math.max(0, Number(actor.system?.classResource?.value) || 0) + spent;
  await actor.update({ "system.classResource.value": restored });
  await message.update({ "flags.fast-nri.resourceUndone": true, "flags.fast-nri.resourceRestoredTo": restored });
  return { actor, item, restored, restoredAmount: spent };
}

export function activateAbilityChatInteractions(root = document) {
  root.addEventListener("click", async event => {
    const areaButton = event.target.closest("[data-fast-nri-area-place]");
    if (areaButton) {
      event.preventDefault(); event.stopPropagation();
      if (areaButton.dataset.fastNriBusy === "true") return;
      areaButton.dataset.fastNriBusy = "true";
      try {
        const item = await fromUuid(areaButton.dataset.itemUuid);
        if (!item || item.type !== "ability") return ui.notifications.error("Не удалось найти способность или заклинание.");
        const runtime = abilityImplementationRuntime(item, areaButton.dataset.implementationId || null);
        const area = abilityAreaPresets(runtime).find(candidate => candidate.id === areaButton.dataset.areaId);
        if (!area || area.type === "special") return ui.notifications.error("Не удалось найти стандартную область реализации.");
        const sourceMessage = game.messages?.get(messageIdFromElement(areaButton)) ?? null;
        const actionContext = sourceMessage?.getFlag("fast-nri", "actionContext") ?? null;
        await placeAbilityAreaPreset({ item, implementationId: runtime.implementationId, area, actionContext });
      } finally { delete areaButton.dataset.fastNriBusy; }
      return;
    }
    const implButton = event.target.closest("[data-fast-nri-use-implementation]");
    if (implButton) {
      event.preventDefault(); event.stopPropagation();
      if (implButton.dataset.fastNriBusy === "true") return;
      implButton.dataset.fastNriBusy = "true";
      try {
        const actor = await fromUuid(implButton.dataset.actorUuid);
        const item = await fromUuid(implButton.dataset.itemUuid);
        if (!actor || !item) return ui.notifications.error("Не удалось найти способность или персонажа.");
        await useAbilityImplementation(actor, item, implButton.dataset.implementationId, { parentMessageId: messageIdFromElement(implButton) });
      } finally { delete implButton.dataset.fastNriBusy; }
      return;
    }

    const checkButton = event.target.closest("[data-fast-nri-roll-ability-check], [data-fast-nri-roll-ability-attack]");
    if (checkButton) {
      event.preventDefault(); event.stopPropagation();
      if (checkButton.dataset.fastNriBusy === "true") return;
      checkButton.dataset.fastNriBusy = "true";
      try {
        const actor = await fromUuid(checkButton.dataset.actorUuid);
        const item = await fromUuid(checkButton.dataset.itemUuid);
        if (!actor || !item || item.type !== "ability") return ui.notifications.error("Не удалось найти способность или заклинание.");
        const sourceMessage = game.messages?.get(messageIdFromElement(checkButton)) ?? null;
        await rollAbilityCheck(actor, item, {
          implementationId: checkButton.dataset.implementationId || sourceMessage?.getFlag("fast-nri", "implementationId") || null,
          repeatIndex: Number(checkButton.dataset.repeatIndex) || 0,
          actionContext: sourceMessage?.getFlag("fast-nri", "actionContext") ?? null,
          parentMessageId: sourceMessage?.id ?? null
        });
      } finally { delete checkButton.dataset.fastNriBusy; }
      return;
    }

    const outcomeButton = event.target.closest("[data-fast-nri-roll-ability-outcome]");
    if (outcomeButton) {
      event.preventDefault(); event.stopPropagation();
      if (outcomeButton.dataset.fastNriBusy === "true") return;
      outcomeButton.dataset.fastNriBusy = "true";
      try {
        const actor = await fromUuid(outcomeButton.dataset.actorUuid);
        const item = await fromUuid(outcomeButton.dataset.itemUuid);
        if (!actor || !item || item.type !== "ability") return ui.notifications.error("Не удалось найти способность или заклинание.");
        const sourceMessage = game.messages?.get(messageIdFromElement(outcomeButton)) ?? null;
        const sourceActionContext = sourceMessage?.getFlag("fast-nri", "actionContext") ?? null;
        const selectedDegree = outcomeButton.dataset.profileDegree || null;
        let sourceAttack = null;
        if (outcomeButton.dataset.sourceAttack === "true") {
          const sourceKind = sourceMessage?.getFlag("fast-nri", "kind");
          if (!sourceMessage || !["ability-check", "ability-attack"].includes(sourceKind)) return ui.notifications.error("Не удалось найти исходную проверку способности.");
          const automaticDegree = sourceMessage.getFlag("fast-nri", "degree") ?? null;
          sourceAttack = {
            message: sourceMessage,
            total: sourceMessage.getFlag("fast-nri", "rollTotal"), naturalD20: sourceMessage.getFlag("fast-nri", "naturalD20"),
            automaticDegree, degree: selectedDegree || automaticDegree, critical: Boolean(sourceMessage.getFlag("fast-nri", "critical")),
            targetUuid: sourceMessage.getFlag("fast-nri", "targetUuid"), directedDefense: Boolean(sourceMessage.getFlag("fast-nri", "directedDefense")),
            attackType: sourceMessage.getFlag("fast-nri", "attackType"), targetCharacteristic: sourceMessage.getFlag("fast-nri", "targetCharacteristic") ?? "armor",
            actionTraits: sourceMessage.getFlag("fast-nri", "actionTraits") ?? {}, actionContext: sourceActionContext,
            implementationId: sourceMessage.getFlag("fast-nri", "implementationId")
          };
        }
        await rollAbilityOutcome(actor, item, outcomeButton.dataset.outcomeKind, sourceAttack, sourceActionContext,
          outcomeButton.dataset.implementationId || sourceMessage?.getFlag("fast-nri", "implementationId") || null,
          Number(outcomeButton.dataset.repeatIndex) || 0, selectedDegree);
      } finally { delete outcomeButton.dataset.fastNriBusy; }
      return;
    }

    const undoButton = event.target.closest("[data-fast-nri-undo-resource]");
    if (undoButton) { event.preventDefault(); event.stopPropagation(); await undoAbilityResource(undoButton); }
  });
}
