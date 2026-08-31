const HP_COLOR = 0x35c759;
const TEMP_HP_COLOR = 0x4f9ee8;
const EMPTY_COLOR = 0x10141a;
const BORDER_COLOR = 0x000000;
const MAX_TEMP_SHARE = 0.70;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calculate the visual shares of the single combined HP bar.
 *
 * Order:
 *   current HP (green) -> missing normal HP (empty gap) -> temporary HP (blue)
 *
 * The whole bar represents maxHP + tempHP = 100%.
 * Temporary HP therefore occupy tempHP / (maxHP + tempHP).
 * Blue is capped at 70% only as a visual ceiling for extreme temp HP.
 * Current and missing ordinary HP preserve currentHP / maxHP inside
 * the ordinary-HP portion.
 */
export function calculateHpBarLayout({ value = 0, max = 0, temp = 0 } = {}) {
  const maxHp = Math.max(0, Number(max) || 0);
  const currentHp = clamp(Number(value) || 0, 0, maxHp);
  const tempHp = Math.max(0, Number(temp) || 0);

  if (maxHp <= 0) {
    return {
      green: 0,
      gap: tempHp > 0 ? 1 - MAX_TEMP_SHARE : 1,
      blue: tempHp > 0 ? MAX_TEMP_SHARE : 0
    };
  }

  if (tempHp <= 0) {
    const green = currentHp / maxHp;
    return {
      green,
      gap: 1 - green,
      blue: 0
    };
  }

  // Canonical visual rule:
  // max normal HP + current temporary HP = 100% of the bar.
  //
  // Example: max 100 + temp 20 => total visual maximum 120,
  // so temp occupies 20 / 120 = 16.67%.
  const effectiveMaximum = maxHp + tempHp;
  const rawBlue = tempHp / effectiveMaximum;
  const blue = Math.min(rawBlue, MAX_TEMP_SHARE);

  // If blue did not hit the 70% visual ceiling, ordinary HP naturally
  // occupies maxHp / (maxHp + tempHp). If it did hit the ceiling, the
  // entire ordinary-HP scale is compressed into the remaining 30%.
  const ordinaryShare = 1 - blue;
  const hpRatio = currentHp / maxHp;
  const green = ordinaryShare * hpRatio;
  const gap = ordinaryShare * (1 - hpRatio);

  return { green, gap, blue };
}

export function touchesHp(changes) {
  const hp = changes?.system?.hp;
  if (hp && typeof hp === "object") {
    if (["value", "max", "temp"].some(
      key => Object.prototype.hasOwnProperty.call(hp, key)
    )) return true;
  }

  // Be tolerant of flattened update data produced by direct Document.update
  // calls or integrations which submit dot-path keys.
  return ["system.hp.value", "system.hp.max", "system.hp.temp"].some(
    key => Object.prototype.hasOwnProperty.call(changes ?? {}, key)
  );
}

export function refreshActorHpBars(actor) {
  // getActiveTokens(..., false) returns canvas Token placeables. The previous
  // code requested TokenDocuments and then tried to use renderFlags on them,
  // so hp.temp-only updates could leave the custom combined bar stale.
  for (const token of actor?.getActiveTokens?.(false, false) ?? []) {
    token.renderFlags?.set?.({ refreshBars: true });
  }
}

/**
 * Fast NRI uses one custom HP resource bar:
 * green current HP, dark missing-HP gap, blue temporary HP.
 *
 * The supported Token._drawBar extension point is the same one used by PF2e,
 * but the visual model is specific to Fast NRI.
 */
export function registerFastNriTokenVisuals() {
  const BaseToken = CONFIG.Token.objectClass;

  class FastNriToken extends BaseToken {
    _drawBar(number, bar, data) {
      if (!canvas?.initialized) return;

      const actor = this.document?.actor;
      if (data?.attribute !== "hp" || !actor?.system?.hp) {
        return super._drawBar(number, bar, data);
      }

      const hp = actor.system.hp;
      const layout = calculateHpBarLayout({
        value: hp.value,
        max: hp.max,
        temp: hp.temp
      });

      // Follow the core/PF2e height convention so the bar remains familiar.
      let h = Math.max(canvas.dimensions.size / 12, 8);
      if (this.document.height >= 2) h *= 1.6;

      const border = clamp(h / 8, 1, 2);
      const innerX = border;
      const innerY = border;
      const innerWidth = Math.max(0, this.w - border * 2);
      const innerHeight = Math.max(1, h - border * 2);

      const greenWidth = innerWidth * layout.green;
      const blueWidth = innerWidth * layout.blue;

      // Blue is anchored to the right. The untouched background between
      // green and blue is exactly the visual share of missing ordinary HP.
      const blueX = innerX + innerWidth - blueWidth;

      bar.clear();

      // Whole bar / missing HP.
      bar.lineStyle(0)
        .beginFill(EMPTY_COLOR, 0.82)
        .drawRoundedRect(0, 0, this.w, h, 3);

      // Current ordinary HP.
      if (greenWidth > 0) {
        bar.lineStyle(0)
          .beginFill(HP_COLOR, 1)
          .drawRect(innerX, innerY, greenWidth, innerHeight);
      }

      // Temporary HP.
      if (blueWidth > 0) {
        bar.lineStyle(0)
          .beginFill(TEMP_HP_COLOR, 1)
          .drawRect(blueX, innerY, blueWidth, innerHeight);
      }

      // Single container border around the combined bar.
      bar.beginFill(BORDER_COLOR, 0)
        .lineStyle(border, BORDER_COLOR, 1)
        .drawRoundedRect(0, 0, this.w, h, 3);

      bar.position.set(0, number === 0 ? this.h - h : 0);
    }
  }

  CONFIG.Token.objectClass = FastNriToken;

  // `hp.temp` is not the token's bound resource value, so explicitly request
  // a bar refresh when any HP field changes.
  Hooks.on("updateActor", (actor, changes) => {
    if (!touchesHp(changes)) return;
    refreshActorHpBars(actor);
  });
}
