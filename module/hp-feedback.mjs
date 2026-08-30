const DAMAGE_COLOR = "#e04848";
const HEALING_COLOR = "#45b96b";
const TEMP_HP_COLOR = "#4f9ee8";

function foundryColor(value) {
  try {
    return Number(foundry.utils.Color.fromString(value));
  } catch {
    return value;
  }
}

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
  const fill = foundryColor(isTempHp ? TEMP_HP_COLOR : isHealing ? HEALING_COLOR : DAMAGE_COLOR);

  const center = token.center;
  const origin = {
    x: center.x,
    y: center.y - Math.max(10, Number(token.h) * 0.18 || 10)
  };

  try {
    await canvas.interface.createScrollingText(origin, content, {
      anchor: CONST.TEXT_ANCHOR_POINTS.CENTER,
      direction: CONST.TEXT_ANCHOR_POINTS.TOP,
      distance: 52,
      duration: 1050,
      jitter: 0.08,
      textStyle: {
        fill,
        fontSize: 30,
        fontWeight: "700",
        stroke: {
          color: foundryColor("#1b1b1b"),
          width: 3
        }
      }
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
    void feedbackFromCreatedMessage(message);
  });

  Hooks.on("updateChatMessage", (message, changed) => {
    void feedbackFromUpdatedMessage(message, changed);
  });
}
