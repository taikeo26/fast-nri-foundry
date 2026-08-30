import { CREATURE_TRAIT_IDS, HP_GAIN_DEFENSE_TRAIT_IDS, RESISTANCE_TRAIT_IDS } from "./config.mjs";

const {
  ArrayField,
  BooleanField,
  HTMLField,
  NumberField,
  SchemaField,
  StringField
} = foundry.data.fields;

const integer = (initial = 0) =>
  new NumberField({
    required: true,
    nullable: false,
    integer: true,
    initial
  });

const text = (initial = "") =>
  new StringField({
    required: true,
    nullable: false,
    initial
  });

const flag = (initial = false) =>
  new BooleanField({
    required: true,
    nullable: false,
    initial
  });

const stringArray = () =>
  new ArrayField(
    new StringField({
      required: true,
      nullable: false,
      blank: false
    }),
    {
      required: true,
      nullable: false,
      initial: []
    }
  );

const traitValueSchema = (ids) =>
  new SchemaField(
    Object.fromEntries(ids.map(id => [id, integer(0)]))
  );

const damageComponentArray = () =>
  new ArrayField(
    new SchemaField({
      formula: text("1d6"),
      damageType: text("physical"),
      traitIds: stringArray()
    }),
    {
      required: true,
      nullable: false,
      initial: []
    }
  );

const outcomeComponentArray = () =>
  new ArrayField(
    new SchemaField({
      formula: text("1d6"),
      damageType: text("physical"),
      traitIds: stringArray()
    }),
    {
      required: true,
      nullable: false,
      initial: []
    }
  );


const outcomeChannelSchema = () =>
  new SchemaField({
    enabled: flag(false),
    components: outcomeComponentArray()
  });


const effectTimerArray = () =>
  new ArrayField(
    new SchemaField({
      id: text(""),
      durationMode: text("manual"),
      combatId: text(""),
      combatantId: text(""),
      appliedRound: integer(0),
      appliedTurn: integer(-1),
      expiresRound: integer(0),
      phase: text("manual"),
      untracked: flag(false)
    }),
    {
      required: true,
      nullable: false,
      initial: []
    }
  );

function skillsSchema() {
  return new SchemaField({
    acrobatics: text(""),
    athletics: text(""),
    stealth: text(""),
    sleight_of_hand: text(""),
    survival: text(""),
    medicine: text(""),
    craft: text(""),
    nature: text(""),
    religion: text(""),
    mysticism: text(""),
    arcana: text(""),
    society: text(""),
    persuasion: text(""),
    deception: text(""),
    intimidation: text("")
  });
}

function actorSchema({ hp = 10, speed = 5, combatDie = "1d6" } = {}) {
  return {
    level: integer(1),

    hp: new SchemaField({
      value: integer(hp),
      max: integer(hp),
      temp: integer(0)
    }),

    // Идентичность персонажа. Для существ поля могут оставаться пустыми.
    className: text(""),
    raceName: text(""),

    // Базовые параметры, которые пока только хранятся и показываются в карточке.
    size: text("medium"),
    initiativeBonus: integer(0),
    deathCounter: integer(0),

    // Две специализации персонажа. Их кубы фиксированы правилами:
    // основная — 2d6, дополнительная — 2d4.
    specializations: new SchemaField({
      primary: new SchemaField({
        name: text("")
      }),
      secondary: new SchemaField({
        name: text("")
      })
    }),

    // В Fast NRI теперь только три Устойчивости:
    // универсальная, физическая и магическая.
    resistances: new SchemaField({
      universal: integer(0),
      physical: integer(0),
      magic: integer(0)
    }),

    // Старые текстовые поля 0.5.12 оставлены как резерв для безопасного
    // чтения уже созданных Actor, но новый UI использует стабильные ID.
    vulnerabilities: text(""),
    immunities: text(""),

    // Свойства существа показываются только Creature, но поле существует
    // в общей схеме, чтобы структура Actor оставалась единообразной.
    creatureTraitIds: stringArray(),

    // Устойчивости и Уязвимости — числовые значения по признакам.
    // Из всех совпавших за одно нанесение применяется только наибольшее значение.
    resistanceIds: stringArray(),
    resistanceValues: traitValueSchema(RESISTANCE_TRAIT_IDS),

    vulnerabilityIds: stringArray(),
    vulnerabilityValues: traitValueSchema(CREATURE_TRAIT_IDS),

    // Иммунитет не имеет числового значения: совпавший признак удаляет
    // конкретную часть урона из дальнейшего расчёта.
    immunityIds: stringArray(),

    // Получение HP — отдельный канал от урона. Он общий для
    // восстановления обычных HP и выдачи временных HP.
    hpGainReductionIds: stringArray(),
    hpGainReductionValues: traitValueSchema(HP_GAIN_DEFENSE_TRAIT_IDS),

    hpGainBonusIds: stringArray(),
    hpGainBonusValues: traitValueSchema(HP_GAIN_DEFENSE_TRAIT_IDS),

    hpGainImmunityIds: stringArray(),

    speed: integer(speed),

    combatDie: text(combatDie),

    // Для существ Бестиария без Куба боя.
    attackModifier: integer(0),

    armor: new SchemaField({
      partial: integer(5),
      success: integer(10),
      great: integer(16)
    }),

    defenses: new SchemaField({
      awareness: integer(10),
      reflex: integer(10),
      fortitude: integer(10),
      will: integer(10)
    }),

    resources: new SchemaField({
      movement: integer(1),
      action: integer(1),
      intervention: integer(1)
    }),

    classResource: new SchemaField({
      label: text("Классовый ресурс"),
      value: integer(0),
      max: integer(0)
    }),

    skills: skillsSchema()
  };
}

export class CharacterData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return actorSchema({
      hp: 15,
      speed: 5,
      combatDie: "1d6"
    });
  }
}

export class CreatureData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return actorSchema({
      hp: 10,
      speed: 5,
      combatDie: ""
    });
  }
}

function itemBaseSchema() {
  return {
    level: integer(1),
    description: new HTMLField({
      required: true,
      nullable: false,
      initial: ""
    })
  };
}

export class WeaponData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),
      range: text("Ближняя"),
      // Канонические стабильные ID свойств.
      propertyIds: stringArray(),

      // Резервное текстовое поле для будущих предметных данных.
      // Не используется как список свойств и пока не выводится в UI.
      details: text(""),

      // Игровой статус: предмет сейчас одет / удерживается.
      equipped: flag(false),

      // Сколько рук занимает предмет при экипировке.
      // Игрок не выбирает "хват" во время игры: это характеристика Item.
      hands: integer(1),

      // Служебное время экипировки для правила "третий одноручный
      // снимает самый давно экипированный одноручный".
      equippedAt: integer(0),

      damageType: text("physical"),
      damage: new SchemaField({
        partial: text("0"),
        success: text("0"),
        great: text("0")
      }),

      // Состав каждого профиля урона. Каждый компонент получает собственный
      // тип урона и набор свойств; каждый выпавший куб/фиксированный бонус
      // внутри компонента наследует эти данные.
      // Если массив профиля пуст, используется legacy system.damage.*.
      damageComponents: new SchemaField({
        partial: damageComponentArray(),
        success: damageComponentArray(),
        great: damageComponentArray()
      })
    };
  }
}

export class AbilityData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),
      category: text("ability"),
      timing: text("Действие"),
      classResourceCost: integer(0),

      // Legacy-поле 0.5.16 оставлено для чтения уже созданных Item.
      // Новый UI и runtime используют независимые каналы outcomes ниже.
      outcome: new SchemaField({
        kind: text("none"),
        components: outcomeComponentArray()
      }),

      // Одна способность/заклинание может иметь несколько разных результатов
      // одновременно: например Лечение + Временные HP, или Урон + Лечение.
      outcomes: new SchemaField({
        damage: outcomeChannelSchema(),
        healing: outcomeChannelSchema(),
        tempHp: outcomeChannelSchema()
      }),

      // Не вся способность, наносящая урон, является Атакой.
      // Если этот блок включён, перед результатами выполняется одна
      // исходная проверка Атаки против КЗ. Её результат можно передать
      // карточке урона для Направленной защиты.
      attackCheck: new SchemaField({
        enabled: flag(false),
        formula: text("1d20 + {combatDie}"),
        directedDefense: flag(false)
      }),

      // Ссылки на Effect Item. При использовании способности они выводятся
      // в chat-card как перетаскиваемые эффекты.
      effectUuids: stringArray()
    };
  }
}

export class EquipmentData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),
      category: text(""),
      propertyIds: stringArray(),

      // Резервное текстовое поле для будущих предметных данных.
      // Не используется как список свойств и пока не выводится в UI.
      details: text(""),

      equipped: flag(false),
      hands: integer(1),
      equippedAt: integer(0)
    };
  }
}

export class ConsumableData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),
      quantity: integer(1)
    };
  }
}
export class EffectData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),

      // condition / buff / debuff — пока только организация и отображение.
      effectKind: text("condition"),

      // Мягкая автоматизация длительности.
      duration: new SchemaField({
        mode: text("manual"),
        rounds: integer(1),
        expiry: text("turnStart")
      }),

      // none        — повторное применение только обновляет длительность;
      // shared      — один таймер на все стаки, новый стак обновляет таймер;
      // independent — каждый стак имеет собственный таймер.
      stacking: new SchemaField({
        mode: text("none")
      }),

      // Источник и runtime используются только у Effect, встроенного в Actor.
      sourceUuid: text(""),
      runtime: new SchemaField({
        stackCount: integer(0),
        mirrorEffectId: text(""),
        timers: effectTimerArray()
      })
    };
  }
}
