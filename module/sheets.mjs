import { rollSkillCheck } from "./rolls.mjs";

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
      rollSkill: FastNriActorSheet.#rollSkill
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

    return {
      ...context,
      actor: this.actor,
      system: this.actor.system,

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
      skillRows
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
      width: 580,
      height: 580
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: true
    }
  };

  static PARTS = {
    main: {
      root: true,
      template: "systems/fast-nri/templates/item-sheet.hbs"
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);

    return {
      ...context,
      item: this.item,
      system: this.item.system,
      isWeapon: this.item.type === "weapon",
      isAbility: this.item.type === "ability",
      isEquipment: this.item.type === "equipment",
      isConsumable: this.item.type === "consumable",
      abilityIsSpell:
        this.item.type === "ability" && this.item.system.category === "spell"
    };
  }
}
