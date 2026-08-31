// Foundry v14 createScrollingText receives PIXI.TextStyle properties
// directly in the options object. PF2e uses numeric fills the same way.
const DAMAGE_COLOR = 0xff0000;
const HEALING_COLOR = 0x00ff00;
const TEMP_HP_COLOR = 0x4f9ee8;
const TEXT_STROKE_COLOR = 0x000000;

export const HP_FEEDBACK_SUPPRESS_OPTION = "fastNriSuppressHpFeedback";
const HP_FEEDBACK_BEFORE_OPTION = "fastNriHpFeedbackBefore";

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
export async function showHpChangeFeedback({ tokenUuid, amount, kind, horizontalOffset = 0 }) {
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
    x: center.x + (Number(horizontalOffset) || 0),
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


function normalizedHpState(actor) {
  return {
    value: Math.max(0, Number(actor?.system?.hp?.value) || 0),
    temp: Math.max(0, Number(actor?.system?.hp?.temp) || 0)
  };
}

function updateTouchesManualHp(changes) {
  const hp = changes?.system?.hp;
  if (hp && typeof hp === "object") {
    if (["value", "temp"].some(key => Object.prototype.hasOwnProperty.call(hp, key))) {
      return true;
    }
  }

  return ["system.hp.value", "system.hp.temp"].some(
    key => Object.prototype.hasOwnProperty.call(changes ?? {}, key)
  );
}

/**
 * Convert a direct Actor HP edit into the same semantic feedback categories
 * used by normal damage / healing / temporary-HP application.
 *
 * Decreases of ordinary HP and temporary HP are one damage amount because
 * normal damage can consume both pools in the same delivery.
 */
export function classifyManualHpFeedback(before = {}, after = {}) {
  const oldHp = Math.max(0, Number(before.value) || 0);
  const oldTemp = Math.max(0, Number(before.temp) || 0);
  const newHp = Math.max(0, Number(after.value) || 0);
  const newTemp = Math.max(0, Number(after.temp) || 0);

  const damage = Math.max(0, oldHp - newHp) + Math.max(0, oldTemp - newTemp);
  const healing = Math.max(0, newHp - oldHp);
  const tempHp = Math.max(0, newTemp - oldTemp);

  const feedback = [];
  if (damage > 0) feedback.push({ kind: "damage", amount: damage });
  if (healing > 0) feedback.push({ kind: "healing", amount: healing });
  if (tempHp > 0) feedback.push({ kind: "tempHp", amount: tempHp });
  return feedback;
}

async function feedbackFromManualActorUpdate(actor, options) {
  const before = options?.[HP_FEEDBACK_BEFORE_OPTION];
  if (!before) return false;

  const feedback = classifyManualHpFeedback(before, normalizedHpState(actor));
  if (feedback.length === 0) return false;

  const tokens = Array.from(actor?.getActiveTokens?.(false, false) ?? []);
  if (tokens.length === 0) return false;

  for (const token of tokens) {
    const tokenUuid = token?.document?.uuid;
    if (!tokenUuid) continue;

    // Multiple fields can be edited in one submit. Slight horizontal spacing
    // keeps simultaneous semantic messages readable instead of overlapping.
    const middle = (feedback.length - 1) / 2;
    feedback.forEach((entry, index) => {
      void showHpChangeFeedback({
        tokenUuid,
        amount: entry.amount,
        kind: entry.kind,
        horizontalOffset: (index - middle) * 28
      });
    });
  }

  return true;
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
  // Actor Sheet edits do not create a chat-card, so capture the previous HP
  // values before the update and emit the same floating feedback afterwards.
  // Programmatic Fast NRI HP actions opt out because their ChatMessage hooks
  // already produce the feedback and would otherwise double it.
  Hooks.on("preUpdateActor", (actor, changes, options = {}) => {
    if (options?.[HP_FEEDBACK_SUPPRESS_OPTION]) return;
    if (!updateTouchesManualHp(changes)) return;
    options[HP_FEEDBACK_BEFORE_OPTION] = normalizedHpState(actor);
  });

  Hooks.on("updateActor", (actor, changes, options = {}) => {
    if (options?.[HP_FEEDBACK_SUPPRESS_OPTION]) return;
    if (!updateTouchesManualHp(changes)) return;
    void feedbackFromManualActorUpdate(actor, options);
  });

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
