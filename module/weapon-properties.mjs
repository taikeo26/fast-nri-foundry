import { ITEM_PROPERTIES } from "./config.mjs";

export const WEAPON_PROPERTY_PACK = "weapon-properties";

// 0.5.56.2: stable package-Compendium document IDs for the 21 weapon
// properties currently defined in the Rulebook section «Свойства оружия».
// These IDs are presentation/reference links only; runtime mechanics continue
// to key off the structured propertyId stored on Weapon Item documents.
export const WEAPON_PROPERTY_DOCUMENT_IDS = Object.freeze({
  reach: "Prpbaff1506c2674",
  mobile: "Prp83d6311e87d47",
  steady: "Prp0c69e7aaeb1a8",
  sweeping: "Prp9457039418268",
  piercing: "Prpa32b0438ae40e",
  guided: "Prp5b590af68f6af",
  traumatic: "Prp3a4d4cab56ac2",
  crushing: "Prp2d34680032bba",
  sturdy: "Prp7ce61bfb21441",
  vital: "Prp17cb65e86213d",
  spellcasterWeapon: "Prpc064da0681d33",
  safe: "Prpbf31c52c32b0f",
  contact: "Prp1a73af9e7ae00",
  catalyst: "Prpc6482363313dd",
  charged: "Prp37ebb98c6a9d3",
  reload: "Prpd6e6e576541fa",
  firearm: "Prp71d6e74592c20",
  trip: "Prpfdd91fbac0e56",
  defensive: "Prp802d2a9ffa218",
  deadly: "Prp82967ec5ce9e0",
  longRange: "Prp86f3df270bd9d"
});

export const WEAPON_PROPERTY_IDS = Object.freeze(Object.keys(WEAPON_PROPERTY_DOCUMENT_IDS));

export function weaponPropertyUuid(propertyId) {
  const id = String(propertyId ?? "").trim();
  const documentId = WEAPON_PROPERTY_DOCUMENT_IDS[id];
  if (!documentId) return "";
  return `Compendium.fast-nri.${WEAPON_PROPERTY_PACK}.Item.${documentId}`;
}

export function weaponPropertyReference(propertyId) {
  const id = String(propertyId ?? "").trim();
  return {
    id,
    label: ITEM_PROPERTIES[id] ?? id,
    uuid: weaponPropertyUuid(id)
  };
}
