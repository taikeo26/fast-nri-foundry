import {
  activateTokenDefaults,
  disableTokenAutoRotateByDefaultOnce,
  migrateTokenBarsOnce,
  registerTokenDefaultSettings
} from "./module/token-defaults.mjs";
import { activateHpFeedback } from "./module/hp-feedback.mjs";
import { registerFastNriTokenVisuals } from "./module/token-visuals.mjs";
import { registerFastNriTokenHud } from "./module/token-hud.mjs";
import { activateFastNriEffectPanel } from "./module/effect-panel.mjs";
import {
  activateEffectChatInteractions,
  activateEffectSystem,
  registerEffectSettings,
  seedBuiltinEffectsOnce
} from "./module/effect-system.mjs";
import { activateHealthChatInteractions } from "./module/health-actions.mjs";
import { activateWeaponRules } from "./module/weapon-rules.mjs";
import { activateFieldGeometry } from "./module/field-geometry.mjs";
// Controlled-cell rules are imported by later field automation layers.
// The module itself is pure and requires no activation hook.
import "./module/melee-control.mjs";
// Threat counting and Formation are pure rules layers consumed by later
// Surrounding automation.
import "./module/threat.mjs";
import "./module/formation.mjs";
import { activateSurroundingAutomation } from "./module/surrounding.mjs";
import {
  migrateDamageTraitsOnce,
  migrateEquipmentStateOnce,
  registerDataMigrationSettings
} from "./module/data-migrations.mjs";
import { activateAbilityChatInteractions } from "./module/ability-use.mjs";
import { activateChatInteractions } from "./module/rolls.mjs";
import {
  migrateDefenseAbilitiesOnce,
  registerDefenseActionSettings
} from "./module/defense-actions.mjs";

import {
  CharacterData,
  CreatureData,
  WeaponData,
  AbilityData,
  EquipmentData,
  ConsumableData,
  EffectData
} from "./module/data-models.mjs";

import {
  FastNriActorSheet,
  FastNriItemSheet
} from "./module/sheets.mjs";

Hooks.once("init", () => {
  console.log("Быстрая НРИ 6.2 | Инициализация системы");

  registerTokenDefaultSettings();
  registerDataMigrationSettings();
  registerEffectSettings();
  registerDefenseActionSettings();
  activateTokenDefaults();
  activateWeaponRules();
  activateFieldGeometry();
  registerFastNriTokenVisuals();
  registerFastNriTokenHud();

  CONFIG.Actor.dataModels = {
    character: CharacterData,
    creature: CreatureData
  };

  CONFIG.Item.dataModels = {
    weapon: WeaponData,
    ability: AbilityData,
    equipment: EquipmentData,
    consumable: ConsumableData,
    effect: EffectData
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
    { types: ["weapon", "ability", "equipment", "consumable", "effect"], makeDefault: true }
  );
});

Hooks.once("ready", async () => {
  console.log("Быстрая НРИ 6.2 | Система готова");
  activateChatInteractions(document);
  activateAbilityChatInteractions(document);
  activateHealthChatInteractions(document);
  activateEffectChatInteractions(document);
  activateEffectSystem();
  activateFastNriEffectPanel();
  activateHpFeedback();
  await seedBuiltinEffectsOnce();
  activateSurroundingAutomation();
  await migrateDefenseAbilitiesOnce();
  await migrateDamageTraitsOnce();
  await migrateEquipmentStateOnce();
  await migrateTokenBarsOnce();
  await disableTokenAutoRotateByDefaultOnce();
  ui.notifications.info("Быстрая НРИ 6.2 загружена");
});
