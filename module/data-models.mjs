const {
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
      max: integer(hp)
    }),

    speed: integer(speed),

    combatDie: text(combatDie),

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
      combatDie: "1d6"
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
      damageType: text("physical"),
      damage: new SchemaField({
        partial: text("0"),
        success: text("0"),
        great: text("0")
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
      classResourceCost: integer(0)
    };
  }
}

export class EquipmentData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      ...itemBaseSchema(),
      category: text("")
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
