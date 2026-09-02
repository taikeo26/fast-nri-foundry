# Weapon Property Compendium source — 0.5.56.2

21 справочная карточка `Item type=weaponProperty` из нормативного раздела `rulebook.md` 6.3 «Свойства оружия».

- `system.propertyId` — стабильный runtime ID свойства.
- `_id` — стабильный document ID для UUID-ссылок из Weapon Item Sheet.
- runtime оружия не зависит от имени карточки Compendium; он продолжает использовать `propertyId`.
- выбранное свойство в Weapon Item Sheet отображается отдельной кликабельной ссылкой на соответствующий Compendium Item.
- `packs/weapon-properties.db` — релизный package Compendium source.
