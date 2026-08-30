export const ITEM_PROPERTIES = Object.freeze({
  reach: "Досягаемость",
  mobile: "Подвижное",
  steady: "Уверенное",
  sweeping: "Размашистое",
  piercing: "Пробивающий",
  guided: "Наводимое",
  traumatic: "Травмирующее",
  crushing: "Сокрушение",
  sturdy: "Крепкое",
  vital: "Жизненное",
  spellcasterWeapon: "Оружие заклинателя",
  safe: "Безопасное",
  contact: "Контактное",
  catalyst: "Катализатор",
  charged: "Заряженное",
  reload: "Перезарядка",
  firearm: "Огнестрельное",
  trip: "Подсечка",
  poison: "Яд",
  defensive: "Защитное",
  deadly: "Смертельное",
  longRange: "Дальнобойное"
});

export const ITEM_PROPERTY_IDS = Object.freeze(Object.keys(ITEM_PROPERTIES));

export function propertyLabel(id) {
  return ITEM_PROPERTIES[id] ?? id;
}

// Общий нормативный реестр признаков, которыми могут обладать существа,
// а также к которым могут относиться Уязвимости и Иммунитеты.
//
// Горение намеренно отсутствует: это Периодический эффект Огня,
// а не самостоятельный признак. Яд и Кровотечение остаются отдельными
// признаками, потому что к ним существуют прямые Иммунитеты.
export const CREATURE_TRAITS = Object.freeze({
  humanoid: "Гуманоид",
  demon: "Демон",
  chthonic: "Хтонь",
  beast: "Зверь",
  monster: "Чудовище",
  undead: "Нежить",
  construct: "Конструкт",
  mysticalCreature: "Мистическое существо",
  fey: "Фея",

  physical: "Физический",
  magic: "Магический",

  fire: "Огонь",
  water: "Вода",
  ice: "Лёд",
  air: "Воздух",
  electricity: "Электричество",
  earth: "Земля",
  spirit: "Дух",
  holy: "Святой",
  unholy: "Нечестивый",
  poison: "Яд",
  force: "Силовой",
  bleeding: "Кровотечение"
});

export const CREATURE_TRAIT_IDS = Object.freeze(Object.keys(CREATURE_TRAITS));

export const RESISTANCE_TRAITS = Object.freeze({
  universal: "Универсальная",
  ...CREATURE_TRAITS
});

export const RESISTANCE_TRAIT_IDS = Object.freeze(Object.keys(RESISTANCE_TRAITS));

export function creatureTraitLabel(id) {
  return CREATURE_TRAITS[id] ?? id;
}

export function resistanceTraitLabel(id) {
  return RESISTANCE_TRAITS[id] ?? creatureTraitLabel(id);
}

