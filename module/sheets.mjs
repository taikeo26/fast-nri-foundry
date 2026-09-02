import {
  itemIsUsable,
  itemRequiresHands,
  setItemEquipped,
  setItemHands,
  setItemHeld
} from "./equipment.mjs";
import {
  ABILITY_TRAITS,
  CREATURE_TRAITS,
  HP_GAIN_DEFENSE_TRAITS,
  HP_GAIN_SOURCE_TRAITS,
  ITEM_PROPERTIES,
  RESISTANCE_TRAITS
} from "./config.mjs";
import {
  EFFECT_DURATION_MODES,
  EFFECT_EXPIRY_PHASES,
  EFFECT_KINDS,
  EFFECT_STACKING_MODES,
  applyEffectToActor,
  durationDefinitionLabel,
  effectStackCount,
  isSystemOnlyEffect,
  postEffectToChat,
  removeOneEffectStack,
  resolveEffectDocuments,
  runtimeDurationLabel
} from "./effect-system.mjs";
import { useAbility } from "./ability-use.mjs";
import {
  ABILITY_AREA_PRESET_TYPES,
  ABILITY_AREA_SHAPES,
  ABILITY_PROFILE_DEGREES,
  ABILITY_RANGE_MODES,
  ABILITY_TARGET_MODES,
  ABILITY_TARGET_RELATIONS,
  abilityAreaPresetLabel,
  abilityAreaPresets,
  abilityCostLabel,
  abilityImplementationRuntime,
  abilityImplementations,
  abilityIsSpell,
  abilityTraitLabels
} from "./ability-authoring.mjs";
import {
  DEFENSE_ACTION_PROCEDURES,
  DEFENSE_DAMAGE_SELECTION_MODES,
  DEFENSE_MODIFIER_SCOPES,
  DEFENSE_MOVEMENT_MODES,
  DEFENSE_RANGE_MODES,
  DEFENSE_TARGET_SCOPES
} from "./defense-actions.mjs";
import { rollSkillCheck, rollSpecializationCheck, rollWeaponAttack } from "./rolls.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2, ItemSheetV2 } = foundry.applications.sheets;

const SKILLS = [
  ["acrobatics", "Акробатика"],
  ["athletics", "Атлетика"],
  ["stealth", "Скрытность"],
  ["sleight_of_hand", "Ловкость рук"],
  ["survival", "Выживание"],
  ["medicine", "Медицина"],
  ["craft", "Ремесло"],
  ["nature", "Природа"],
  ["religion", "Религия"],
  ["mysticism", "Мистика"],
  ["arcana", "Аркана"],
  ["society", "Общество"],
  ["persuasion", "Убеждение"],
  ["deception", "Обман"],
  ["intimidation", "Запугивание"]
];

export class FastNriActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["fast-nri", "fast-nri-actor-sheet", "standard-form"],
    position: {
      width: 820,
      height: 720
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: true
    },
    actions: {
      editItem: FastNriActorSheet.#editItem,
      deleteItem: FastNriActorSheet.#deleteItem,
      createItem: FastNriActorSheet.#createItem,
      rollSkill: FastNriActorSheet.#rollSkill,
      rollSpecialization: FastNriActorSheet.#rollSpecialization,
      rollWeaponAttack: FastNriActorSheet.#rollWeaponAttack,
      useAbility: FastNriActorSheet.#useAbility
    }
  };

  static PARTS = {
    main: {
      root: true,
      template: "systems/fast-nri/templates/actor-sheet.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    this._activeTab = "main";
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const items = Array.from(this.actor.items).sort((a, b) => a.sort - b.sort);

    const abilityRow = item => {
      const implementations = abilityImplementations(item);
      const runtime = abilityImplementationRuntime(item, implementations[0]?.id ?? null);
      return {
        item,
        id: item.id,
        name: item.name,
        img: item.img,
        system: item.system,
        implementationCount: implementations.length,
        costLabel: implementations.length === 1
          ? abilityCostLabel(runtime, this.actor)
          : `${implementations.length} реализации`,
        traitLabel: implementations.length === 1
          ? abilityTraitLabels(runtime).join(" · ")
          : `Выбор из ${implementations.length}`
      };
    };

    const abilities = items
      .filter(item => item.type === "ability" && !abilityIsSpell(item))
      .map(abilityRow);

    const spells = items
      .filter(item => item.type === "ability" && abilityIsSpell(item))
      .map(abilityRow);

    const effectItems = items
      .filter(item => item.type === "effect")
      .map(item => ({
        item,
        id: item.id,
        name: item.name,
        img: item.img,
        systemOnly: isSystemOnlyEffect(item),
        stackCount: effectStackCount(item),
        durationLabel: runtimeDurationLabel(item, game.combat?.started ? {
          combatId: game.combat.id,
          round: Number(game.combat.round) || 0
        } : null)
      }));

    const skillRows = SKILLS.map(([id, label]) => {
      const value = this.actor.system.skills?.[id] ?? "";
      return {
        id,
        label,
        value,
        formula: value ? `1d20 + ${value}` : "1d20"
      };
    });


    const specializationRows = [
      {
        id: "primary",
        kind: "primary",
        label: "Основная специализация",
        name: this.actor.system.specializations?.primary?.name ?? "",
        die: "2d6",
        formula: "1d20 + 2d6"
      },
      {
        id: "secondary",
        kind: "secondary",
        label: "Дополнительная специализация",
        name: this.actor.system.specializations?.secondary?.name ?? "",
        die: "2d4",
        formula: "1d20 + 2d4"
      }
    ];

    // 0.5.12 хранила три базовые Устойчивости отдельными полями.
    // Подхватываем их как fallback, чтобы существующие Actor не потеряли значения.
    const resistanceIds = new Set(this.actor.system.resistanceIds ?? []);
    const legacyResistanceMap = {
      universal: Number(this.actor.system.resistances?.universal) || 0,
      physical: Number(this.actor.system.resistances?.physical) || 0,
      magic: Number(this.actor.system.resistances?.magic) || 0
    };

    for (const [id, value] of Object.entries(legacyResistanceMap)) {
      if (value > 0) resistanceIds.add(id);
    }

    const resistanceRows = Array.from(resistanceIds).map(id => ({
      id,
      label: RESISTANCE_TRAITS[id] ?? id,
      value: Number(this.actor.system.resistanceValues?.[id])
        || legacyResistanceMap[id]
        || 0
    }));

    const vulnerabilityRows = Array.from(this.actor.system.vulnerabilityIds ?? []).map(id => ({
      id,
      label: CREATURE_TRAITS[id] ?? id,
      value: Number(this.actor.system.vulnerabilityValues?.[id]) || 0
    }));

    const hpGainReductionRows = Array.from(this.actor.system.hpGainReductionIds ?? []).map(id => ({
      id,
      label: HP_GAIN_DEFENSE_TRAITS[id] ?? id,
      value: Number(this.actor.system.hpGainReductionValues?.[id]) || 0
    }));

    const hpGainBonusRows = Array.from(this.actor.system.hpGainBonusIds ?? []).map(id => ({
      id,
      label: HP_GAIN_DEFENSE_TRAITS[id] ?? id,
      value: Number(this.actor.system.hpGainBonusValues?.[id]) || 0
    }));

    return {
      ...context,
      actor: this.actor,
      system: this.actor.system,
      isCreature: this.actor.type === "creature",

      tabs: {
        main: { active: this._activeTab === "main" },
        abilities: { active: this._activeTab === "abilities" },
        inventory: { active: this._activeTab === "inventory" },
        spells: { active: this._activeTab === "spells" },
        skills: { active: this._activeTab === "skills" },
        effects: { active: this._activeTab === "effects" }
      },

      abilities,
      spells,
      effectItems,
      weapons: items.filter(item => item.type === "weapon"),
      equipment: items.filter(item => item.type === "equipment"),
      consumables: items.filter(item => item.type === "consumable"),
      skillRows,
      specializationRows,
      traitChoices: CREATURE_TRAITS,
      resistanceChoices: RESISTANCE_TRAITS,
      selectedResistanceIds: Array.from(resistanceIds),
      resistanceRows,
      vulnerabilityRows,
      hpGainDefenseChoices: HP_GAIN_DEFENSE_TRAITS,
      hpGainReductionRows,
      hpGainBonusRows
    };
  }

  async _onDropItem(event, data) {
    const dropped = await Item.implementation.fromDropData(data);

    if (dropped?.type === "effect") {
      await applyEffectToActor(dropped, this.actor);
      return [];
    }

    return super._onDropItem(event, data);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);

    this.#activateTabs();

    for (const zone of this.element.querySelectorAll(".fast-nri-drop-zone")) {
      zone.addEventListener("dragover", event => {
        event.preventDefault();
        this._onDragOver(event);
        zone.classList.add("is-dragover");
      });

      zone.addEventListener("dragleave", () => {
        zone.classList.remove("is-dragover");
      });

      zone.addEventListener("drop", async event => {
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("is-dragover");

        const raw = event.dataTransfer?.getData("text/plain") || "";
        console.log("Быстрая НРИ | DROP получен", raw);

        try {
          await this._onDrop(event);
          console.log("Быстрая НРИ | DROP обработан ActorSheetV2");
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка DROP", error);
          ui.notifications.error(`Ошибка добавления Item: ${error.message}`);
        }
      });
    }

    for (const row of this.element.querySelectorAll(".fast-nri-item-row[data-item-id]")) {
      row.draggable = true;
      row.addEventListener("dragstart", event => {
        this._onDragStart(event);
      });
    }

    for (const checkbox of this.element.querySelectorAll("[data-fast-nri-equipped-toggle]")) {
      checkbox.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        // Event.currentTarget гарантирован только во время синхронной части
        // обработчика. Document update может перерендерить лист во время await,
        // поэтому сохраняем DOM-элемент заранее и не обращаемся к currentTarget
        // после асинхронной паузы.
        const input = event.currentTarget;
        const itemId = input
          .closest("[data-item-id]")
          ?.dataset?.itemId;

        const item = this.actor.items.get(itemId);
        if (!item) return;

        const requested = input.checked;
        input.disabled = true;

        try {
          const resolved = await setItemEquipped(item, requested);
          if (input.isConnected) input.checked = resolved?.system?.equipped === true;
          if (requested && resolved?.system?.equipped !== true) {
            ui.notifications.warn("Недостаточно свободных рук. Предмет не экипирован.");
          }
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка экипировки Item", error);
          ui.notifications.error(`Не удалось изменить экипировку: ${error.message}`);
        } finally {
          if (input.isConnected) input.disabled = false;
        }
      });
    }

    for (const checkbox of this.element.querySelectorAll("[data-fast-nri-held-toggle]")) {
      checkbox.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        const input = event.currentTarget;
        const itemId = input
          .closest("[data-item-id]")
          ?.dataset?.itemId;

        const item = this.actor.items.get(itemId);
        if (!item) return;

        const requested = input.checked;
        input.disabled = true;

        try {
          const resolved = await setItemHeld(item, requested);
          if (input.isConnected) input.checked = resolved?.system?.held === true;
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка состояния «В руках»", error);
          ui.notifications.error(`Не удалось изменить состояние «В руках»: ${error.message}`);
        } finally {
          if (input.isConnected) input.disabled = false;
        }
      });
    }

    for (const row of this.element.querySelectorAll("[data-fast-nri-applied-effect-id]")) {
      row.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();

        const effect = this.actor.items.get(row.dataset.fastNriAppliedEffectId);
        if (effect?.type === "effect" && !isSystemOnlyEffect(effect)) {
          void removeOneEffectStack(effect);
        }
      });
    }

    console.log(`Быстрая НРИ | Лист Actor готов: ${this.actor.name}`);
  }

  #activateTabs() {
    const buttons = this.element.querySelectorAll(".fast-nri-tab-button");
    const panes = this.element.querySelectorAll(".fast-nri-tab-pane");

    const show = tabName => {
      this._activeTab = tabName;

      for (const button of buttons) {
        const active = button.dataset.tab === tabName;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      }

      for (const pane of panes) {
        pane.classList.toggle("active", pane.dataset.tab === tabName);
      }
    };

    for (const button of buttons) {
      button.addEventListener("click", event => {
        event.preventDefault();
        show(button.dataset.tab);
      });
    }

    show(this._activeTab);
  }

  static async #useAbility(event, target) {
    event.preventDefault();

    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(itemId);

    if (!item || item.type !== "ability") return;
    await useAbility(this.actor, item);
  }

  static async #rollWeaponAttack(event, target) {
    event.preventDefault();

    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const weapon = this.actor.items.get(itemId);

    if (!weapon || weapon.type !== "weapon") return;
    await rollWeaponAttack(this.actor, weapon);
  }

  static async #rollSkill(event, target) {
    event.preventDefault();

    const skillId = target.dataset.skillId;
    const skill = SKILLS.find(([id]) => id === skillId);
    if (!skill) return;

    const [id, label] = skill;
    const value = this.actor.system.skills?.[id] ?? "";

    await rollSkillCheck(this.actor, {
      id,
      label,
      value
    });
  }


  static async #rollSpecialization(event, target) {
    event.preventDefault();

    const kind = target.dataset.specialization;
    if (!["primary", "secondary"].includes(kind)) return;

    const name = this.actor.system.specializations?.[kind]?.name ?? "";
    const die = kind === "primary" ? "2d6" : "2d4";

    await rollSpecializationCheck(this.actor, {
      kind,
      name,
      die
    });
  }

  static async #createItem(event, target) {
    const type = target.dataset.itemType;
    if (!["weapon", "ability", "equipment", "consumable", "effect"].includes(type)) return;

    const category = target.dataset.itemCategory || "";

    const names = {
      weapon: "Новое оружие",
      ability: category === "spell" ? "Новое заклинание" : "Новая способность",
      equipment: "Новое снаряжение",
      consumable: "Новый расходник",
      effect: "Новый эффект"
    };

    const data = {
      name: names[type],
      type
    };

    if (type === "ability") {
      const implementationId = globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
      data.system = {
        category: category || "ability",
        implementations: [{
          id: implementationId,
          name: "Основная реализация",
          traitIds: category === "spell" ? ["spell"] : []
        }]
      };
    }

    const [item] = await this.actor.createEmbeddedDocuments("Item", [data]);
    if (item) item.sheet.render(true);
  }

  static async #editItem(event, target) {
    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (item) item.sheet.render(true);
  }

  static async #deleteItem(event, target) {
    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    if (!itemId) return;

    const item = this.actor.items.get(itemId);
    if (!item) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Удалить предмет" },
      content: `<p>Удалить <strong>${foundry.utils.escapeHTML(item.name)}</strong> из карточки?</p>`
    });

    if (confirmed) await item.delete();
  }
}

export class FastNriItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["fast-nri", "fast-nri-item-sheet", "standard-form"],
    position: {
      width: 700,
      height: 720
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: true
    },
    actions: {
      addDamageComponent: FastNriItemSheet.#addDamageComponent,
      removeDamageComponent: FastNriItemSheet.#removeDamageComponent,
      addOutcome: FastNriItemSheet.#addOutcome,
      removeOutcome: FastNriItemSheet.#removeOutcome,
      addOutcomeComponent: FastNriItemSheet.#addOutcomeComponent,
      removeOutcomeComponent: FastNriItemSheet.#removeOutcomeComponent,
      addProfileComponent: FastNriItemSheet.#addProfileComponent,
      removeProfileComponent: FastNriItemSheet.#removeProfileComponent,
      sendEffectToChat: FastNriItemSheet.#sendEffectToChat,
      removeLinkedEffect: FastNriItemSheet.#removeLinkedEffect,
      removeProfileEffect: FastNriItemSheet.#removeProfileEffect,
      addImplementation: FastNriItemSheet.#addImplementation,
      duplicateImplementation: FastNriItemSheet.#duplicateImplementation,
      removeImplementation: FastNriItemSheet.#removeImplementation,
      addImplementationArea: FastNriItemSheet.#addImplementationArea,
      removeImplementationArea: FastNriItemSheet.#removeImplementationArea,
      addImplementationProfileComponent: FastNriItemSheet.#addImplementationProfileComponent,
      removeImplementationProfileComponent: FastNriItemSheet.#removeImplementationProfileComponent,
      removeImplementationEffect: FastNriItemSheet.#removeImplementationEffect,
      removeImplementationProfileEffect: FastNriItemSheet.#removeImplementationProfileEffect
    }
  };

  static PARTS = {
    main: {
      root: true,
      template: "systems/fast-nri/templates/item-sheet.hbs"
    }
  };

  constructor(options = {}) {
    super(options);
    this._activeAbilityTab = "card";
    this._activeImplementationId = null;
  }

  #activateImplementationTabs() {
    const buttons = Array.from(this.element.querySelectorAll("[data-fast-nri-implementation-tab]"));
    const panes = Array.from(this.element.querySelectorAll("[data-fast-nri-implementation-pane]"));
    if (!buttons.length || !panes.length) return;

    const ids = buttons.map(button => button.dataset.fastNriImplementationTab).filter(Boolean);
    const show = id => {
      const next = ids.includes(id) ? id : ids[0];
      if (!next) return;
      this._activeImplementationId = next;
      for (const button of buttons) {
        const active = button.dataset.fastNriImplementationTab === next;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      }
      for (const pane of panes) {
        pane.classList.toggle("active", pane.dataset.fastNriImplementationPane === next);
      }
    };

    for (const button of buttons) {
      button.addEventListener("click", event => {
        event.preventDefault();
        // submitOnChange persists ordinary fields; blur also commits an active
        // ProseMirror before hiding its realization pane.
        document.activeElement?.blur?.();
        show(button.dataset.fastNriImplementationTab);
      });
    }
    show(this._activeImplementationId);
  }

  #activateAbilityTabs() {
    const buttons = this.element.querySelectorAll("[data-fast-nri-ability-tab]");
    const panes = this.element.querySelectorAll("[data-fast-nri-ability-pane]");
    if (!buttons.length || !panes.length) return;

    const show = tab => {
      this._activeAbilityTab = tab;
      for (const button of buttons) {
        const active = button.dataset.fastNriAbilityTab === tab;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      }
      for (const pane of panes) {
        pane.classList.toggle("active", pane.dataset.fastNriAbilityPane === tab);
      }
    };

    for (const button of buttons) {
      button.addEventListener("click", event => {
        event.preventDefault();
        show(button.dataset.fastNriAbilityTab);
      });
    }
    show(this._activeAbilityTab);
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.#activateAbilityTabs();
    this.#activateImplementationTabs();

    const equipped = this.element.querySelector("[data-fast-nri-item-equipped]");
    if (equipped) {
      equipped.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        const input = event.currentTarget;
        const requested = input.checked;
        input.disabled = true;

        try {
          const resolved = await setItemEquipped(this.item, requested);
          if (input.isConnected) input.checked = resolved?.system?.equipped === true;
          if (requested && resolved?.system?.equipped !== true) {
            ui.notifications.warn("Недостаточно свободных рук. Предмет не экипирован.");
          }
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка экипировки Item", error);
          ui.notifications.error(`Не удалось изменить экипировку: ${error.message}`);
        } finally {
          if (input.isConnected) input.disabled = false;
        }
      });
    }


    const held = this.element.querySelector("[data-fast-nri-item-held]");
    if (held) {
      held.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        const input = event.currentTarget;
        const requested = input.checked;
        input.disabled = true;

        try {
          const resolved = await setItemHeld(this.item, requested);
          if (input.isConnected) input.checked = resolved?.system?.held === true;
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка состояния «В руках»", error);
          ui.notifications.error(`Не удалось изменить состояние «В руках»: ${error.message}`);
        } finally {
          if (input.isConnected) input.disabled = false;
        }
      });
    }

    const hands = this.element.querySelector("[data-fast-nri-item-hands]");
    if (hands) {
      hands.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        const input = event.currentTarget;
        const requested = input.value;
        input.disabled = true;

        try {
          await setItemHands(this.item, requested);
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка изменения занятых рук", error);
          ui.notifications.error(`Не удалось изменить число рук: ${error.message}`);
        } finally {
          if (input.isConnected) input.disabled = false;
        }
      });
    }


    for (const input of this.element.querySelectorAll("[data-fast-nri-damage-component-field]")) {
      input.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        await this.#updateDamageComponent(event.currentTarget);
      });
    }

    for (const input of this.element.querySelectorAll("[data-fast-nri-outcome-enabled]")) {
      input.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();

        const kind = event.currentTarget.dataset.outcomeKind;
        if (!["damage", "healing", "tempHp"].includes(kind)) {
          console.error(
            "Быстрая НРИ | Переключатель результата не содержит корректный data-outcome-kind",
            { kind, element: event.currentTarget }
          );
          ui.notifications.error(
            "Не удалось сохранить включение результата: неизвестный тип."
          );
          return;
        }

        try {
          await this.item.update({
            [`system.outcomes.${kind}.enabled`]: Boolean(event.currentTarget.checked)
          });
        } catch (error) {
          console.error(
            `Быстрая НРИ | Не удалось сохранить enabled для ${kind}`,
            error
          );
          ui.notifications.error(
            `Не удалось сохранить включение результата: ${error.message}`
          );
          throw error;
        }
      });
    }

    for (const input of this.element.querySelectorAll("[data-fast-nri-outcome-component-field]")) {
      input.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        await this.#updateOutcomeComponent(event.currentTarget);
      });
    }

    for (const input of this.element.querySelectorAll("[data-fast-nri-profile-component-field]")) {
      input.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        await this.#updateProfileComponent(event.currentTarget);
      });
    }

    for (const dropZone of this.element.querySelectorAll("[data-fast-nri-implementation-effect-dropzone]")) {
      dropZone.addEventListener("dragover", event => { event.preventDefault(); dropZone.classList.add("is-dragover"); });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
      dropZone.addEventListener("drop", async event => {
        event.preventDefault(); event.stopPropagation(); dropZone.classList.remove("is-dragover");
        const implIndex = Number(dropZone.dataset.implementationIndex);
        if (!Number.isInteger(implIndex)) return;
        try {
          const dragData = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
          const dropped = await Item.implementation.fromDropData(dragData);
          if (!dropped || dropped.type !== "effect") return ui.notifications.warn("Сюда можно привязать только Effect.");
          const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
          if (!current[implIndex]) return;
          const uuids = Array.from(current[implIndex].effectUuids ?? []);
          if (!uuids.includes(dropped.uuid)) uuids.push(dropped.uuid);
          current[implIndex].effectUuids = uuids;
          await this.item.update({ "system.implementations": current });
        } catch (error) { console.error("Быстрая НРИ | Ошибка привязки Effect реализации", error); ui.notifications.error(`Не удалось привязать эффект: ${error.message}`); }
      });
    }

    for (const dropZone of this.element.querySelectorAll("[data-fast-nri-implementation-profile-effect-dropzone]")) {
      dropZone.addEventListener("dragover", event => { event.preventDefault(); dropZone.classList.add("is-dragover"); });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
      dropZone.addEventListener("drop", async event => {
        event.preventDefault(); event.stopPropagation(); dropZone.classList.remove("is-dragover");
        const implIndex = Number(dropZone.dataset.implementationIndex);
        const degree = dropZone.dataset.degree;
        if (!Number.isInteger(implIndex) || !Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return;
        try {
          const dragData = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
          const dropped = await Item.implementation.fromDropData(dragData);
          if (!dropped || dropped.type !== "effect") return ui.notifications.warn("Сюда можно привязать только Effect.");
          const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
          const profile = current[implIndex]?.profiles?.[degree];
          if (!profile) return;
          const uuids = Array.from(profile.effectUuids ?? []);
          if (!uuids.includes(dropped.uuid)) uuids.push(dropped.uuid);
          profile.effectUuids = uuids;
          profile.enabled = true;
          await this.item.update({ "system.implementations": current });
        } catch (error) { console.error("Быстрая НРИ | Ошибка привязки профильного Effect реализации", error); ui.notifications.error(`Не удалось привязать эффект: ${error.message}`); }
      });
    }

    const effectDropZone = this.element.querySelector("[data-fast-nri-effect-link-dropzone]");
    if (effectDropZone) {
      effectDropZone.addEventListener("dragover", event => {
        event.preventDefault();
        effectDropZone.classList.add("is-dragover");
      });

      effectDropZone.addEventListener("dragleave", () => {
        effectDropZone.classList.remove("is-dragover");
      });

      effectDropZone.addEventListener("drop", async event => {
        event.preventDefault();
        event.stopPropagation();
        effectDropZone.classList.remove("is-dragover");

        try {
          const dragData = foundry.applications.ux.TextEditor.implementation
            .getDragEventData(event);

          const dropped = await Item.implementation.fromDropData(dragData);

          if (!dropped || dropped.type !== "effect") {
            ui.notifications.warn("Сюда можно привязать только Effect.");
            return;
          }

          const uuids = Array.from(this.item.system?.effectUuids ?? []);
          if (!uuids.includes(dropped.uuid)) {
            uuids.push(dropped.uuid);
            await this.item.update({ "system.effectUuids": uuids });
          }
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка привязки Effect", error);
          ui.notifications.error(`Не удалось привязать эффект: ${error.message}`);
        }
      });
    }


    for (const dropZone of this.element.querySelectorAll("[data-fast-nri-profile-effect-dropzone]")) {
      dropZone.addEventListener("dragover", event => {
        event.preventDefault();
        dropZone.classList.add("is-dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-dragover"));
      dropZone.addEventListener("drop", async event => {
        event.preventDefault();
        event.stopPropagation();
        dropZone.classList.remove("is-dragover");
        const degree = dropZone.dataset.degree;
        if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return;
        try {
          const dragData = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
          const dropped = await Item.implementation.fromDropData(dragData);
          if (!dropped || dropped.type !== "effect") {
            ui.notifications.warn("Сюда можно привязать только Effect.");
            return;
          }
          const uuids = Array.from(this.item.system?.profiles?.[degree]?.effectUuids ?? []);
          if (!uuids.includes(dropped.uuid)) {
            uuids.push(dropped.uuid);
            await this.item.update({ [`system.profiles.${degree}.effectUuids`]: uuids });
          }
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка привязки профильного Effect", error);
          ui.notifications.error(`Не удалось привязать эффект: ${error.message}`);
        }
      });
    }
  }

  #componentArray(profile) {
    const raw = this.item.system.damageComponents?.[profile] ?? [];
    return Array.from(raw).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));
  }

  async #updateDamageComponent(element) {
    const profile = element.dataset.profile;
    const index = Number(element.dataset.index);
    const field = element.dataset.fastNriDamageComponentField;
    if (!["partial", "success", "great"].includes(profile)) return;
    if (!Number.isInteger(index) || index < 0) return;
    if (!["formula", "damageType", "traitIds"].includes(field)) return;

    const components = this.#componentArray(profile);
    if (!components[index]) return;

    let value = element.value;
    if (field === "traitIds") value = Array.from(value ?? []);
    else value = String(value ?? "");

    components[index][field] = value;
    await this.item.update({ [`system.damageComponents.${profile}`]: components });
  }

  static async #addDamageComponent(event, target) {
    event.preventDefault();
    const profile = target.dataset.profile;
    if (!["partial", "success", "great"].includes(profile)) return;

    const raw = this.item.system.damageComponents?.[profile] ?? [];
    const components = Array.from(raw).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));

    components.push({
      formula: "1d6",
      damageType: String(this.item.system.damageType ?? "physical"),
      traitIds: []
    });

    await this.item.update({ [`system.damageComponents.${profile}`]: components });
  }

  static async #removeDamageComponent(event, target) {
    event.preventDefault();
    const profile = target.dataset.profile;
    const index = Number(target.dataset.index);
    if (!["partial", "success", "great"].includes(profile)) return;
    if (!Number.isInteger(index) || index < 0) return;

    const raw = this.item.system.damageComponents?.[profile] ?? [];
    const components = Array.from(raw).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));

    components.splice(index, 1);
    await this.item.update({ [`system.damageComponents.${profile}`]: components });
  }


  #legacyOutcomeFor(kind) {
    const legacy = this.item.system.outcome ?? {};
    if (String(legacy.kind ?? "none") !== kind) return [];
    return Array.from(legacy.components ?? []);
  }

  #outcomeComponentArray(kind) {
    if (!["damage", "healing", "tempHp"].includes(kind)) return [];

    const modern = Array.from(this.item.system.outcomes?.[kind]?.components ?? []);
    const raw = modern.length ? modern : this.#legacyOutcomeFor(kind);

    const components = raw.map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));

    return components.length ? components : [{
      formula: "1d6",
      damageType: "physical",
      traitIds: []
    }];
  }

  async #updateOutcomeComponent(element) {
    const kind = element.dataset.outcomeKind;
    const index = Number(element.dataset.index);
    const field = element.dataset.fastNriOutcomeComponentField;

    if (!["damage", "healing", "tempHp"].includes(kind)) {
      console.error(
        "Быстрая НРИ | Компонент результата не содержит корректный data-outcome-kind",
        { kind, index, field, element }
      );
      ui.notifications.error(
        "Не удалось сохранить компонент результата: неизвестный тип результата."
      );
      return;
    }

    if (!Number.isInteger(index) || index < 0) {
      console.error(
        "Быстрая НРИ | Компонент результата не содержит корректный data-index",
        { kind, index, field, element }
      );
      ui.notifications.error(
        "Не удалось сохранить компонент результата: неизвестный номер компонента."
      );
      return;
    }

    if (!["formula", "damageType", "traitIds"].includes(field)) {
      console.error(
        "Быстрая НРИ | Неизвестное поле компонента результата",
        { kind, index, field, element }
      );
      ui.notifications.error(
        "Не удалось сохранить компонент результата: неизвестное поле."
      );
      return;
    }

    const components = this.#outcomeComponentArray(kind);
    if (!components[index]) return;

    let value = element.value;
    if (field === "traitIds") value = Array.from(value ?? []);
    else value = String(value ?? "");

    components[index][field] = value;

    try {
      await this.item.update({
        [`system.outcomes.${kind}.components`]: components
      });
    } catch (error) {
      console.error(
        `Быстрая НРИ | Не удалось сохранить ${kind}.${field}[${index}]`,
        error
      );
      ui.notifications.error(
        `Не удалось сохранить изменение результата: ${error.message}`
      );
      throw error;
    }
  }

  static async #addOutcome(event, target) {
    event.preventDefault();
    const kind = target.dataset.outcomeKind;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;

    const current = Array.from(this.item.system.outcomes?.[kind]?.components ?? []);
    const legacy = String(this.item.system.outcome?.kind ?? "none") === kind
      ? Array.from(this.item.system.outcome?.components ?? [])
      : [];

    const components = (current.length ? current : legacy).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));

    if (!components.length) {
      components.push({ formula: "1d6", damageType: "physical", traitIds: [] });
    }

    await this.item.update({
      [`system.outcomes.${kind}.enabled`]: true,
      [`system.outcomes.${kind}.components`]: components
    });
  }

  static async #removeOutcome(event, target) {
    event.preventDefault();
    const kind = target.dataset.outcomeKind;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;

    await this.item.update({
      [`system.outcomes.${kind}.enabled`]: false
    });
  }

  static async #addOutcomeComponent(event, target) {
    event.preventDefault();
    const kind = target.dataset.outcomeKind;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;

    const modern = Array.from(this.item.system.outcomes?.[kind]?.components ?? []);
    const legacy = String(this.item.system.outcome?.kind ?? "none") === kind
      ? Array.from(this.item.system.outcome?.components ?? [])
      : [];
    const raw = modern.length ? modern : legacy;

    const components = raw.length
      ? raw.map(component => ({
          formula: String(component?.formula ?? "1d6"),
          damageType: String(component?.damageType ?? "physical"),
          traitIds: Array.from(component?.traitIds ?? [])
        }))
      : [{ formula: "1d6", damageType: "physical", traitIds: [] }];

    components.push({ formula: "1d6", damageType: "physical", traitIds: [] });

    await this.item.update({
      [`system.outcomes.${kind}.enabled`]: true,
      [`system.outcomes.${kind}.components`]: components
    });
  }

  static async #removeOutcomeComponent(event, target) {
    event.preventDefault();
    const kind = target.dataset.outcomeKind;
    const index = Number(target.dataset.index);

    if (!["damage", "healing", "tempHp"].includes(kind)) return;
    if (!Number.isInteger(index) || index < 0) return;

    const modern = Array.from(this.item.system.outcomes?.[kind]?.components ?? []);
    const legacy = String(this.item.system.outcome?.kind ?? "none") === kind
      ? Array.from(this.item.system.outcome?.components ?? [])
      : [];
    const raw = modern.length ? modern : legacy;

    const components = raw.length
      ? raw.map(component => ({
          formula: String(component?.formula ?? "1d6"),
          damageType: String(component?.damageType ?? "physical"),
          traitIds: Array.from(component?.traitIds ?? [])
        }))
      : [{ formula: "1d6", damageType: "physical", traitIds: [] }];

    if (components.length <= 1) {
      ui.notifications.info("У включённого результата должен остаться хотя бы один компонент.");
      return;
    }

    components.splice(index, 1);
    await this.item.update({
      [`system.outcomes.${kind}.components`]: components
    });
  }

  #profileComponentArray(degree, kind) {
    if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return [];
    if (!["damage", "healing", "tempHp"].includes(kind)) return [];
    return Array.from(this.item.system?.profiles?.[degree]?.[kind]?.components ?? []).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));
  }

  async #updateProfileComponent(element) {
    const degree = element.dataset.degree;
    const kind = element.dataset.outcomeKind;
    const index = Number(element.dataset.index);
    const field = element.dataset.fastNriProfileComponentField;
    if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;
    if (!Number.isInteger(index) || index < 0) return;
    if (!["formula", "damageType", "traitIds"].includes(field)) return;

    const components = this.#profileComponentArray(degree, kind);
    if (!components[index]) return;
    let value = element.value;
    if (field === "traitIds") value = Array.from(value ?? []);
    else value = String(value ?? "");
    components[index][field] = value;
    await this.item.update({ [`system.profiles.${degree}.${kind}.components`]: components });
  }

  static async #addProfileComponent(event, target) {
    event.preventDefault();
    const degree = target.dataset.degree;
    const kind = target.dataset.outcomeKind;
    if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;
    const raw = Array.from(this.item.system?.profiles?.[degree]?.[kind]?.components ?? []);
    const components = raw.map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));
    components.push({ formula: "1d6", damageType: "physical", traitIds: [] });
    await this.item.update({
      [`system.profiles.${degree}.enabled`]: true,
      [`system.profiles.${degree}.${kind}.enabled`]: true,
      [`system.profiles.${degree}.${kind}.components`]: components
    });
  }

  static async #removeProfileComponent(event, target) {
    event.preventDefault();
    const degree = target.dataset.degree;
    const kind = target.dataset.outcomeKind;
    const index = Number(target.dataset.index);
    if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree)) return;
    if (!["damage", "healing", "tempHp"].includes(kind)) return;
    if (!Number.isInteger(index) || index < 0) return;
    const components = Array.from(this.item.system?.profiles?.[degree]?.[kind]?.components ?? []).map(component => ({
      formula: String(component?.formula ?? "1d6"),
      damageType: String(component?.damageType ?? "physical"),
      traitIds: Array.from(component?.traitIds ?? [])
    }));
    components.splice(index, 1);
    await this.item.update({
      [`system.profiles.${degree}.${kind}.components`]: components,
      ...(components.length ? {} : { [`system.profiles.${degree}.${kind}.enabled`]: false })
    });
  }

  static async #removeProfileEffect(event, target) {
    event.preventDefault();
    if (this.item.type !== "ability") return;
    const degree = target.dataset.degree;
    const uuid = target.dataset.effectUuid;
    if (!Object.hasOwn(ABILITY_PROFILE_DEGREES, degree) || !uuid) return;
    const next = Array.from(this.item.system?.profiles?.[degree]?.effectUuids ?? [])
      .filter(value => value !== uuid);
    await this.item.update({ [`system.profiles.${degree}.effectUuids`]: next });
  }

  static async #sendEffectToChat(event) {
    event.preventDefault();

    if (this.item.type !== "effect") return;

    await postEffectToChat(this.item, {
      actor: this.item.parent?.documentName === "Actor"
        ? this.item.parent
        : null
    });
  }

  static #blankImplementation(name = "Основная реализация") {
    const id = globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
    const emptyChannel = () => ({ enabled: false, components: [] });
    const emptyDamage = () => ({ enabled: false, components: [], removeHighest: 0, removeLowest: 0, removeAll: false });
    const emptyProfile = () => ({ enabled: false, text: "", damage: emptyDamage(), healing: emptyChannel(), tempHp: emptyChannel(), effectUuids: [] });
    return {
      id, name, description: "", traitIds: [],
      costs: { action: 0, movement: 0, intervention: 0, freeAction: false, classResource: 0, additionalText: "" },
      targeting: { mode: "none", relation: "any", countMin: 0, countMax: 0, rangeMode: "none", rangeCells: 0, requiresVisibility: false, areaShape: "none", areaSize: "", text: "" },
      areas: [],
      conditionText: "", requirementText: "", limitationText: "", exceptionText: "",
      check: { enabled: false, formula: "1d20 + {combatDie}", targetCharacteristic: "armor" },
      defenseProcedure: { directedDefense: false },
      profiles: { failure: emptyProfile(), partial: emptyProfile(), success: emptyProfile(), great: emptyProfile() },
      outcomes: { damage: emptyChannel(), healing: emptyChannel(), tempHp: emptyChannel() },
      defenseAction: { enabled: false, procedure: "directed", targetScope: "ally", interventionCost: 1, rangeMode: "adjacent", rangeCells: 0, requiresVisibility: false, movementMode: "none", damageSelectionMode: "standard", combatDiceFormula: "", selfDefenseCharacteristic: "", removeDamageParts: 1, effectDegreeReduction: 1, allowManeuver: false },
      effectUuids: [], repeat: { count: 1, label: "Результат" }
    };
  }

  static async #addImplementation(event) {
    event.preventDefault();
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    const created = FastNriItemSheet.#blankImplementation(`Реализация ${current.length + 1}`);
    current.push(created);
    this._activeImplementationId = created.id;
    await this.item.update({ "system.implementations": current });
  }

  static async #duplicateImplementation(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.implementationIndex);
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    if (!Number.isInteger(index) || index < 0 || !current[index]) return;
    const copy = foundry.utils.deepClone(current[index]);
    copy.id = globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
    copy.name = `${copy.name || `Реализация ${index + 1}`} — копия`;
    current.splice(index + 1, 0, copy);
    this._activeImplementationId = copy.id;
    await this.item.update({ "system.implementations": current });
  }

  static async #removeImplementation(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.implementationIndex);
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    if (!Number.isInteger(index) || index < 0 || !current[index]) return;
    if (current.length <= 1) {
      ui.notifications.warn("У способности должна оставаться хотя бы одна реализация.");
      return;
    }
    const removedId = current[index]?.id;
    current.splice(index, 1);
    if (this._activeImplementationId === removedId) {
      this._activeImplementationId = current[Math.min(index, current.length - 1)]?.id ?? current[0]?.id ?? null;
    }
    await this.item.update({ "system.implementations": current });
  }

  static #blankAreaPreset(type = "square") {
    const id = globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
    return { id, type, label: "", width: 3, height: 3, length: 8, lineWidth: 1, text: "" };
  }

  static async #addImplementationArea(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    const implementation = current[implIndex];
    if (!Number.isInteger(implIndex) || !implementation) return;
    implementation.areas = Array.from(implementation.areas ?? []);
    implementation.areas.push(FastNriItemSheet.#blankAreaPreset());
    this._activeImplementationId = implementation.id;
    await this.item.update({ "system.implementations": current });
  }

  static async #removeImplementationArea(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const areaIndex = Number(target.dataset.areaIndex);
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    const implementation = current[implIndex];
    if (!Number.isInteger(implIndex) || !Number.isInteger(areaIndex) || !implementation) return;
    implementation.areas = Array.from(implementation.areas ?? []);
    implementation.areas.splice(areaIndex, 1);
    this._activeImplementationId = implementation.id;
    await this.item.update({ "system.implementations": current });
  }

  static async #addImplementationProfileComponent(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const degree = target.dataset.degree;
    const kind = target.dataset.outcomeKind;
    if (!Number.isInteger(implIndex) || !Object.hasOwn(ABILITY_PROFILE_DEGREES, degree) || !["damage", "healing", "tempHp"].includes(kind)) return;
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    const impl = current[implIndex];
    if (!impl) return;
    const channel = impl.profiles?.[degree]?.[kind];
    if (!channel) return;
    channel.enabled = true;
    impl.profiles[degree].enabled = true;
    channel.components = Array.from(channel.components ?? []);
    channel.components.push({ formula: "1d6", damageType: "physical", traitIds: [] });
    await this.item.update({ "system.implementations": current });
  }

  static async #removeImplementationProfileComponent(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const degree = target.dataset.degree;
    const kind = target.dataset.outcomeKind;
    const componentIndex = Number(target.dataset.index);
    if (!Number.isInteger(implIndex) || !Number.isInteger(componentIndex) || !Object.hasOwn(ABILITY_PROFILE_DEGREES, degree) || !["damage", "healing", "tempHp"].includes(kind)) return;
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    const channel = current[implIndex]?.profiles?.[degree]?.[kind];
    if (!channel) return;
    channel.components = Array.from(channel.components ?? []);
    channel.components.splice(componentIndex, 1);
    if (!channel.components.length) channel.enabled = false;
    await this.item.update({ "system.implementations": current });
  }

  static async #removeImplementationEffect(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const uuid = target.dataset.effectUuid;
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    if (!Number.isInteger(implIndex) || !current[implIndex] || !uuid) return;
    current[implIndex].effectUuids = Array.from(current[implIndex].effectUuids ?? []).filter(value => value !== uuid);
    await this.item.update({ "system.implementations": current });
  }

  static async #removeImplementationProfileEffect(event, target) {
    event.preventDefault();
    const implIndex = Number(target.dataset.implementationIndex);
    const degree = target.dataset.degree;
    const uuid = target.dataset.effectUuid;
    const current = Array.from(this.item.system?.implementations ?? []).map(value => foundry.utils.deepClone(value));
    if (!Number.isInteger(implIndex) || !current[implIndex] || !Object.hasOwn(ABILITY_PROFILE_DEGREES, degree) || !uuid) return;
    const profile = current[implIndex].profiles?.[degree];
    if (!profile) return;
    profile.effectUuids = Array.from(profile.effectUuids ?? []).filter(value => value !== uuid);
    await this.item.update({ "system.implementations": current });
  }

  static async #removeLinkedEffect(event, target) {
    event.preventDefault();

    if (this.item.type !== "ability") return;

    const uuid = target.dataset.effectUuid;
    if (!uuid) return;

    const next = Array.from(this.item.system?.effectUuids ?? [])
      .filter(value => value !== uuid);

    await this.item.update({
      "system.effectUuids": next
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    const damageComponentProfiles = [
      ["partial", "Частичный"],
      ["success", "Успех"],
      ["great", "Большой"]
    ].map(([id, label]) => ({
      id,
      label,
      components: Array.from(this.item.system.damageComponents?.[id] ?? []).map((component, index) => ({
        index,
        formula: String(component?.formula ?? "1d6"),
        damageType: String(component?.damageType ?? "physical"),
        traitIds: Array.from(component?.traitIds ?? [])
      }))
    }));

    const legacyKind = String(this.item.system.outcome?.kind ?? "none");
    const legacyComponents = Array.from(this.item.system.outcome?.components ?? []);

    const outcomeLabels = {
      damage: {
        label: "Урон",
        icon: "fa-burst"
      },
      healing: {
        label: "Лечение",
        icon: "fa-heart-pulse"
      },
      tempHp: {
        label: "Временные HP",
        icon: "fa-shield-heart"
      }
    };

    const outcomeChannels = ["damage", "healing", "tempHp"].map(kind => {
      const modern = this.item.system.outcomes?.[kind] ?? {};
      const modernComponents = Array.from(modern.components ?? []);
      const legacyMatches = legacyKind === kind;
      const raw = modernComponents.length
        ? modernComponents
        : legacyMatches
          ? legacyComponents
          : [];

      const components = (raw.length ? raw : [{
        formula: "1d6",
        damageType: "physical",
        traitIds: []
      }]).map((component, index) => ({
        index,
        formula: String(component?.formula ?? "1d6"),
        damageType: String(component?.damageType ?? "physical"),
        traitIds: Array.from(component?.traitIds ?? [])
      }));

      return {
        kind,
        label: outcomeLabels[kind].label,
        icon: outcomeLabels[kind].icon,
        enabled: Boolean(modern.enabled) || legacyMatches,
        isDamage: kind === "damage",
        isHpGain: kind === "healing" || kind === "tempHp",
        components
      };
    });

    const abilityProfiles = [];
    if (this.item.type === "ability") {
      for (const [degree, label] of Object.entries(ABILITY_PROFILE_DEGREES)) {
        const profile = this.item.system?.profiles?.[degree] ?? {};
        const channels = ["damage", "healing", "tempHp"].map(kind => {
          const raw = Array.from(profile?.[kind]?.components ?? []);
          return {
            kind,
            label: kind === "damage" ? "Урон" : kind === "healing" ? "Лечение" : "Временные HP",
            enabled: Boolean(profile?.[kind]?.enabled),
            isDamage: kind === "damage",
            removeHighest: kind === "damage" ? Math.max(0, Number(profile?.damage?.removeHighest) || 0) : 0,
            removeLowest: kind === "damage" ? Math.max(0, Number(profile?.damage?.removeLowest) || 0) : 0,
            removeAll: kind === "damage" ? Boolean(profile?.damage?.removeAll) : false,
            components: raw.map((component, index) => ({
              index,
              formula: String(component?.formula ?? "1d6"),
              damageType: String(component?.damageType ?? "physical"),
              traitIds: Array.from(component?.traitIds ?? [])
            }))
          };
        });
        const effects = await resolveEffectDocuments(profile?.effectUuids ?? []);
        abilityProfiles.push({
          degree,
          label,
          enabled: Boolean(profile.enabled),
          text: String(profile.text ?? ""),
          channels,
          effects: effects.map(effect => ({
            uuid: effect.uuid,
            name: effect.name,
            img: effect.img,
            durationLabel: durationDefinitionLabel(effect.system)
          }))
        });
      }
    }

    const abilityImplementationsView = [];
    if (this.item.type === "ability") {
      const storedImplementations = Array.from(this.item.system?.implementations ?? []);
      for (let implementationIndex = 0; implementationIndex < storedImplementations.length; implementationIndex += 1) {
        const implementation = storedImplementations[implementationIndex];
        const runtime = abilityImplementationRuntime(this.item, implementation?.id);
        const profiles = [];
        for (const [degree, label] of Object.entries(ABILITY_PROFILE_DEGREES)) {
          const profile = implementation?.profiles?.[degree] ?? {};
          const channels = ["damage", "healing", "tempHp"].map(kind => ({
            kind,
            label: kind === "damage" ? "Урон" : kind === "healing" ? "Лечение" : "Временные HP",
            enabled: Boolean(profile?.[kind]?.enabled),
            isDamage: kind === "damage",
            removeHighest: Math.max(0, Number(profile?.damage?.removeHighest) || 0),
            removeLowest: Math.max(0, Number(profile?.damage?.removeLowest) || 0),
            removeAll: Boolean(profile?.damage?.removeAll),
            components: Array.from(profile?.[kind]?.components ?? []).map((component, index) => ({
              index,
              formula: String(component?.formula ?? "1d6"),
              damageType: String(component?.damageType ?? "physical"),
              traitIds: Array.from(component?.traitIds ?? [])
            }))
          }));
          const effects = await resolveEffectDocuments(profile?.effectUuids ?? []);
          profiles.push({
            degree, label, enabled: Boolean(profile?.enabled), text: String(profile?.text ?? ""), channels,
            effects: effects.map(effect => ({ uuid: effect.uuid, name: effect.name, img: effect.img, durationLabel: durationDefinitionLabel(effect.system) }))
          });
        }
        const effects = await resolveEffectDocuments(implementation?.effectUuids ?? []);
        const areas = abilityAreaPresets(runtime).map((area, areaIndex) => ({
          ...area,
          index: areaIndex,
          labelText: abilityAreaPresetLabel(area),
          isSquare: area.type === "square",
          isRectangle: area.type === "rectangle",
          isLine: area.type === "line",
          isSpecial: area.type === "special"
        }));
        abilityImplementationsView.push({
          index: implementationIndex,
          id: implementation?.id,
          name: implementation?.name || `Реализация ${implementationIndex + 1}`,
          implementation, runtime, profiles, areas,
          costLabel: abilityCostLabel(runtime, this.item.parent?.documentName === "Actor" ? this.item.parent : null),
          traitLabel: abilityTraitLabels(runtime).join(" · "),
          effects: effects.map(effect => ({ uuid: effect.uuid, name: effect.name, img: effect.img, durationLabel: durationDefinitionLabel(effect.system) }))
        });
      }
    }

    if (abilityImplementationsView.length) {
      const ids = abilityImplementationsView.map(view => view.id);
      if (!ids.includes(this._activeImplementationId)) this._activeImplementationId = ids[0];
      for (const view of abilityImplementationsView) view.active = view.id === this._activeImplementationId;
    }

    const linkedEffects = this.item.type === "ability"
      ? await resolveEffectDocuments(this.item.system?.effectUuids ?? [])
      : [];

    const linkedEffectRows = linkedEffects.map(effect => ({
      uuid: effect.uuid,
      name: effect.name,
      img: effect.img,
      durationLabel: durationDefinitionLabel(effect.system)
    }));

    return {
      ...context,
      item: this.item,
      system: this.item.system,
      propertyChoices: this.item.type === "equipment"
        ? Object.fromEntries(Object.entries(ITEM_PROPERTIES).filter(([id]) => id !== "unarmed"))
        : ITEM_PROPERTIES,
      damageTraitChoices: CREATURE_TRAITS,
      damageComponentProfiles,
      outcomeChannels,
      abilityProfiles,
      abilityImplementations: abilityImplementationsView,
      hpGainSourceTraitChoices: HP_GAIN_SOURCE_TRAITS,
      isWeapon: this.item.type === "weapon",
      isAbility: this.item.type === "ability",
      isEquipment: this.item.type === "equipment",
      showHeldToggle: itemRequiresHands(this.item),
      itemUsable: itemIsUsable(this.item),
      isConsumable: this.item.type === "consumable",
      isEffect: this.item.type === "effect",
      linkedEffectRows,
      effectKindChoices: EFFECT_KINDS,
      effectDurationChoices: EFFECT_DURATION_MODES,
      effectExpiryChoices: EFFECT_EXPIRY_PHASES,
      effectStackingChoices: EFFECT_STACKING_MODES,
      effectDurationLabel:
        this.item.type === "effect"
          ? durationDefinitionLabel(this.item.system)
          : "",
      effectRuntimeStackCount:
        this.item.type === "effect"
          ? effectStackCount(this.item)
          : 0,
      effectRuntimeDuration:
        this.item.type === "effect" && this.item.isEmbedded
          ? runtimeDurationLabel(this.item, game.combat?.started ? {
              combatId: game.combat.id,
              round: Number(game.combat.round) || 0
            } : null)
          : "",
      defenseProcedureChoices: DEFENSE_ACTION_PROCEDURES,
      defenseTargetScopeChoices: DEFENSE_TARGET_SCOPES,
      defenseRangeModeChoices: DEFENSE_RANGE_MODES,
      defenseMovementModeChoices: DEFENSE_MOVEMENT_MODES,
      defenseDamageSelectionChoices: DEFENSE_DAMAGE_SELECTION_MODES,
      defenseModifierScopeChoices: DEFENSE_MODIFIER_SCOPES,
      abilityIsSpell:
        this.item.type === "ability" && abilityIsSpell(this.item),
      abilityTraitChoices: ABILITY_TRAITS,
      abilityTargetModeChoices: ABILITY_TARGET_MODES,
      abilityTargetRelationChoices: ABILITY_TARGET_RELATIONS,
      abilityRangeModeChoices: ABILITY_RANGE_MODES,
      abilityAreaShapeChoices: ABILITY_AREA_SHAPES,
      abilityAreaPresetChoices: ABILITY_AREA_PRESET_TYPES,
      abilityProfileDegreeChoices: ABILITY_PROFILE_DEGREES
    };
  }
}
