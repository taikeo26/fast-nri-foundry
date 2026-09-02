# Weapon Compendium source — 0.5.56.1

28 `Item type=weapon` из актуальной таблицы `rulebook.md` 6.3.

- `typeId/categoryId` — канонические стабильные ID 0.5.56.
- `img` — штатные Foundry `icons/...`, выбранные из `foundry/reference/foundry-stock-icons/`.
- `rulebookHands` в `flags.fast-nri` сохраняет точную нотацию таблицы, включая `1+`.
- До отдельной реализации правила `1+` поле `system.hands` хранит фактически занятую руку (`1`); точная нотация также видна в описании Item.
- `rulebookProficientClasses` и `rulebookPrice` — справочные данные для будущих Class/Race grants и закупки; runtime их не enforce'ит.
- `packs/weapons.db` — релизный legacy NeDB source для штатной миграции package Compendium Foundry.
