import {
  activateTokenDefaults,
  disableTokenAutoRotateByDefaultOnce,
  migrateTokenBarsOnce,
  registerTokenDefaultSettings
} from "./module/token-defaults.mjs";
import { activateHpFeedback } from "./module/hp-feedback.mjs";
import { activateAbilityChatInteractions } from "./module/ability-use.mjs";
import { activateChatInteractions } from "./module/rolls.mjs";

import {
  CharacterData,
  CreatureData,
  WeaponData,
  AbilityData,
  EquipmentData,
  ConsumableData
} from "./module/data-models.mjs";

import {
  FastNriActorSheet,
  FastNriItemSheet
} from "./module/sheets.mjs";

Hooks.once("init", () => {
  console.log("Быстрая НРИ 6.2 | Инициализация системы");

  registerTokenDefaultSettings();
  activateTokenDefaults();

  CONFIG.Actor.dataModels = {
    character: CharacterData,
    creature: CreatureData
  };

  CONFIG.Item.dataModels = {
    weapon: WeaponData,
    ability: AbilityData,
    equipment: EquipmentData,
    consumable: ConsumableData
  };

  CONFIG.Actor.trackableAttributes = {
    character: {
      bar: ["hp", "classResource"],
      value: [
        "resources.movement",
        "resources.action",
        "resources.intervention"
      ]
    },
    creature: {
      bar: ["hp", "classResource"],
      value: [
        "resources.movement",
        "resources.action",
        "resources.intervention"
      ]
    }
  };

  const { DocumentSheetConfig } = foundry.applications.apps;

  DocumentSheetConfig.registerSheet(
    foundry.documents.Actor,
    game.system.id,
    FastNriActorSheet,
    { types: ["character", "creature"], makeDefault: true }
  );

  DocumentSheetConfig.registerSheet(
    foundry.documents.Item,
    game.system.id,
    FastNriItemSheet,
    { types: ["weapon", "ability", "equipment", "consumable"], makeDefault: true }
  );
});

Hooks.once("ready", async () => {
  console.log("Быстрая НРИ 6.2 | Система готова");
  activateChatInteractions(document);
  activateAbilityChatInteractions(document);
  activateHpFeedback();
  await migrateTokenBarsOnce();
  await disableTokenAutoRotateByDefaultOnce();
  ui.notifications.info("Быстрая НРИ 6.2 загружена");
});
