import { setItemEquipped, setItemHands } from "./equipment.mjs";
import {
  CREATURE_TRAITS,
  HP_GAIN_DEFENSE_TRAITS,
  HP_GAIN_SOURCE_TRAITS,
  ITEM_PROPERTIES,
  RESISTANCE_TRAITS
} from "./config.mjs";
import { useAbility } from "./ability-use.mjs";
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

    const abilities = items.filter(
      item => item.type === "ability" && item.system.category !== "spell"
    );

    const spells = items.filter(
      item => item.type === "ability" && item.system.category === "spell"
    );

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
        skills: { active: this._activeTab === "skills" }
      },

      abilities,
      spells,
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

        const itemId = event.currentTarget
          .closest("[data-item-id]")
          ?.dataset?.itemId;

        const item = this.actor.items.get(itemId);
        if (!item) return;

        event.currentTarget.disabled = true;

        try {
          await setItemEquipped(item, event.currentTarget.checked);
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка экипировки Item", error);
          ui.notifications.error(`Не удалось изменить экипировку: ${error.message}`);
        } finally {
          event.currentTarget.disabled = false;
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
    if (!["weapon", "ability", "equipment", "consumable"].includes(type)) return;

    const category = target.dataset.itemCategory || "";

    const names = {
      weapon: "Новое оружие",
      ability: category === "spell" ? "Новое заклинание" : "Новая способность",
      equipment: "Новое снаряжение",
      consumable: "Новый расходник"
    };

    const data = {
      name: names[type],
      type
    };

    if (type === "ability" && category) {
      data.system = { category };
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
      addOutcomeComponent: FastNriItemSheet.#addOutcomeComponent,
      removeOutcomeComponent: FastNriItemSheet.#removeOutcomeComponent
    }
  };

  static PARTS = {
    main: {
      root: true,
      template: "systems/fast-nri/templates/item-sheet.hbs"
    }
  };

  async _onRender(context, options) {
    await super._onRender(context, options);

    const equipped = this.element.querySelector("[data-fast-nri-item-equipped]");
    if (equipped) {
      equipped.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.disabled = true;

        try {
          await setItemEquipped(this.item, event.currentTarget.checked);
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка экипировки Item", error);
          ui.notifications.error(`Не удалось изменить экипировку: ${error.message}`);
        } finally {
          event.currentTarget.disabled = false;
        }
      });
    }

    const hands = this.element.querySelector("[data-fast-nri-item-hands]");
    if (hands) {
      hands.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.disabled = true;

        try {
          await setItemHands(this.item, event.currentTarget.value);
        } catch (error) {
          console.error("Быстрая НРИ | Ошибка изменения занятых рук", error);
          ui.notifications.error(`Не удалось изменить число рук: ${error.message}`);
        } finally {
          event.currentTarget.disabled = false;
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

    for (const input of this.element.querySelectorAll("[data-fast-nri-outcome-component-field]")) {
      input.addEventListener("change", async event => {
        event.preventDefault();
        event.stopPropagation();
        await this.#updateOutcomeComponent(event.currentTarget);
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


  #outcomeComponentArray() {
    const raw = Array.from(this.item.system.outcome?.components ?? []);
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
    const index = Number(element.dataset.index);
    const field = element.dataset.fastNriOutcomeComponentField;
    if (!Number.isInteger(index) || index < 0) return;
    if (!["formula", "damageType", "traitIds"].includes(field)) return;

    const components = this.#outcomeComponentArray();
    if (!components[index]) return;

    let value = element.value;
    if (field === "traitIds") value = Array.from(value ?? []);
    else value = String(value ?? "");

    components[index][field] = value;
    await this.item.update({ "system.outcome.components": components });
  }

  static async #addOutcomeComponent(event) {
    event.preventDefault();
    const raw = Array.from(this.item.system.outcome?.components ?? []);
    const components = raw.length
      ? raw.map(component => ({
          formula: String(component?.formula ?? "1d6"),
          damageType: String(component?.damageType ?? "physical"),
          traitIds: Array.from(component?.traitIds ?? [])
        }))
      : [{ formula: "1d6", damageType: "physical", traitIds: [] }];

    components.push({ formula: "1d6", damageType: "physical", traitIds: [] });
    await this.item.update({ "system.outcome.components": components });
  }

  static async #removeOutcomeComponent(event, target) {
    event.preventDefault();
    const index = Number(target.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;

    const raw = Array.from(this.item.system.outcome?.components ?? []);
    const components = raw.length
      ? raw.map(component => ({
          formula: String(component?.formula ?? "1d6"),
          damageType: String(component?.damageType ?? "physical"),
          traitIds: Array.from(component?.traitIds ?? [])
        }))
      : [{ formula: "1d6", damageType: "physical", traitIds: [] }];

    if (components.length <= 1) {
      ui.notifications.info("У автоматического результата должен остаться хотя бы один компонент.");
      return;
    }

    components.splice(index, 1);
    await this.item.update({ "system.outcome.components": components });
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

    const outcomeKind = String(this.item.system.outcome?.kind ?? "none");
    const rawOutcomeComponents = Array.from(this.item.system.outcome?.components ?? []);
    const outcomeComponents = (rawOutcomeComponents.length ? rawOutcomeComponents : [{
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
      ...context,
      item: this.item,
      system: this.item.system,
      propertyChoices: ITEM_PROPERTIES,
      damageTraitChoices: CREATURE_TRAITS,
      damageComponentProfiles,
      outcomeKind,
      outcomeIsDamage: outcomeKind === "damage",
      outcomeIsHpGain: ["healing", "tempHp"].includes(outcomeKind),
      outcomeComponents,
      hpGainSourceTraitChoices: HP_GAIN_SOURCE_TRAITS,
      isWeapon: this.item.type === "weapon",
      isAbility: this.item.type === "ability",
      isEquipment: this.item.type === "equipment",
      isConsumable: this.item.type === "consumable",
      abilityIsSpell:
        this.item.type === "ability" && this.item.system.category === "spell"
    };
  }
}
