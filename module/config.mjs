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
