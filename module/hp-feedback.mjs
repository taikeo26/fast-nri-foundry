// Foundry v14 createScrollingText receives PIXI.TextStyle properties
// directly in the options object. PF2e uses numeric fills the same way.
const DAMAGE_COLOR = 0xff0000;
const HEALING_COLOR = 0x00ff00;
const TEMP_HP_COLOR = 0x4f9ee8;
const TEXT_STROKE_COLOR = 0x000000;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function tokenFromUuid(tokenUuid) {
  if (!tokenUuid || !canvas?.ready || !canvas?.scene) return null;

  let tokenDocument = null;

  try {
    tokenDocument = await fromUuid(tokenUuid);
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось получить Token для HP feedback", error);
    return null;
  }

  if (!tokenDocument || tokenDocument.documentName !== "Token") return null;
  if (tokenDocument.parent?.id !== canvas.scene.id) return null;

  return tokenDocument.object ?? canvas.tokens?.get(tokenDocument.id) ?? null;
}

/**
 * Небольшая визуальная обратная связь над Token.
 * Используем штатный Foundry v14 canvas.interface.createScrollingText.
 * Никаких DOM-overlays или собственного animation engine.
 */
export async function showHpChangeFeedback({ tokenUuid, amount, kind }) {
  const magnitude = finitePositive(amount);
  if (!magnitude) return false;

  const token = await tokenFromUuid(tokenUuid);
  if (!token || !canvas?.interface?.createScrollingText) return false;

  const isHealing = kind === "healing";
  const isTempHp = kind === "tempHp";
  const positive = isHealing || isTempHp;
  const content = `${positive ? "+" : "−"}${magnitude}`;
  const fill = isTempHp ? TEMP_HP_COLOR : isHealing ? HEALING_COLOR : DAMAGE_COLOR;

  const center = token.center;
  const origin = {
    x: center.x,
    y: center.y - Math.max(10, Number(token.h) * 0.18 || 10)
  };

  try {
    // Foundry v14 / PF2e: PIXI.TextStyle properties belong directly
    // in the options object, not inside a nested textStyle object.
    await canvas.interface.createScrollingText(origin, content, {
      anchor: CONST.TEXT_ANCHOR_POINTS.TOP,
      direction: CONST.TEXT_ANCHOR_POINTS.TOP,
      duration: 1200,
      jitter: 0.12,
      fill,
      fontSize: 34,
      fontWeight: "800",
      stroke: TEXT_STROKE_COLOR,
      strokeThickness: 4
    });
    return true;
  } catch (error) {
    console.warn("Быстрая НРИ | Не удалось показать HP feedback", error);
    return false;
  }
}

async function feedbackFromCreatedMessage(message) {
  const kind = message?.getFlag("fast-nri", "kind");
  const tokenUuid = message?.getFlag("fast-nri", "tokenUuid");

  if (kind === "damage-applied") {
    return showHpChangeFeedback({
      tokenUuid,
      amount: message.getFlag("fast-nri", "appliedDamage"),
      kind: "damage"
    });
  }

  // Future-ready: когда появится отдельная chat-card лечения, ей достаточно
  // создать message kind=healing-applied с tokenUuid и appliedHealing.
  if (kind === "healing-applied") {
    return showHpChangeFeedback({
      tokenUuid,
      amount: message.getFlag("fast-nri", "appliedHealing"),
      kind: "healing"
    });
  }

  if (kind === "temp-hp-applied") {
    return showHpChangeFeedback({
      tokenUuid,
      amount: message.getFlag("fast-nri", "appliedTempIncrease"),
      kind: "tempHp"
    });
  }

  // Общий signed delta для будущих chat HP actions.
  if (kind === "hp-change") {
    const delta = Number(message.getFlag("fast-nri", "hpDelta"));
    if (!Number.isFinite(delta) || delta === 0) return false;

    return showHpChangeFeedback({
      tokenUuid,
      amount: Math.abs(delta),
      kind: delta > 0 ? "healing" : "damage"
    });
  }

  return false;
}

async function feedbackFromUpdatedMessage(message, changed) {
  const undone = foundry.utils.getProperty(changed, "flags.fast-nri.undone");
  if (undone !== true) return false;

  const kind = message?.getFlag("fast-nri", "kind");
  if (kind === "damage-applied") {
    return showHpChangeFeedback({
      tokenUuid: message.getFlag("fast-nri", "tokenUuid"),
      amount: message.getFlag("fast-nri", "restoredAmount"),
      kind: "healing"
    });
  }

  if (kind === "healing-applied") {
    return showHpChangeFeedback({
      tokenUuid: message.getFlag("fast-nri", "tokenUuid"),
      amount: message.getFlag("fast-nri", "restoredAmount"),
      kind: "damage"
    });
  }

  return false;
}

export function activateHpFeedback() {
  Hooks.on("createChatMessage", (message) => {
    void (async () => {
      const shown = await feedbackFromCreatedMessage(message);
      if (!shown) return;

      try {
        await message.setFlag("fast-nri", "customHpFeedbackShown", true);
      } catch (error) {
        console.debug(
          "Быстрая НРИ | HP feedback показан, но диагностический flag не записан",
          error
        );
      }
    })();
  });

  Hooks.on("updateChatMessage", (message, changed) => {
    void feedbackFromUpdatedMessage(message, changed);
  });
}
