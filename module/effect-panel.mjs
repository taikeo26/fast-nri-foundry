import {
  EFFECT_KINDS,
  EFFECT_STACKING_MODES,
  durationDefinitionLabel,
  effectStackCount,
  removeOneEffectStack,
  runtimeDurationLabel,
  isSystemOnlyEffect
} from "./effect-system.mjs";
import { isPeriodicEffect } from "./periodic-damage.mjs";

const PANEL_ID = "fast-nri-applied-effects-panel";
const TOOLTIP_ID = "fast-nri-applied-effect-tooltip";

let renderGeneration = 0;

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function escAttr(value) {
  return esc(value).replaceAll('"', "&quot;");
}

export function selectedEffectActor() {
  const controlled = Array.from(canvas?.tokens?.controlled ?? []);
  return controlled.length === 1
    ? controlled[0].actor ?? null
    : null;
}

export function actorAppliedEffects(actor) {
  return Array.from(actor?.items ?? [])
    .filter(item => item.type === "effect")
    .sort((a, b) => {
      const aSort = Number(a.sort) || 0;
      const bSort = Number(b.sort) || 0;
      if (aSort !== bSort) return aSort - bSort;
      return String(a.name).localeCompare(String(b.name), "ru");
    });
}

function combatDisplayState() {
  const combat = game.combat;
  if (!combat?.started) return null;

  return {
    combatId: combat.id,
    round: Number(combat.round) || 0
  };
}

export function effectPanelData(effect, combatState = null) {
  const count = effectStackCount(effect);
  const kind = EFFECT_KINDS[effect.system?.effectKind]
    ?? EFFECT_KINDS.condition;

  const stacking = EFFECT_STACKING_MODES[effect.system?.stacking?.mode]
    ?? EFFECT_STACKING_MODES.none;

  return {
    id: effect.id,
    name: effect.name,
    img: effect.img,
    systemOnly: isSystemOnlyEffect(effect),
    periodic: isPeriodicEffect(effect),
    periodicStoredValue: Number(effect.system?.periodic?.runtime?.storedValue) || 0,
    kind,
    stackCount: count,
    stacking,
    durationDefinition: durationDefinitionLabel(effect.system),
    durationRemaining: runtimeDurationLabel(effect, combatState)
  };
}

function panelRoot() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement("section");
  panel.id = PANEL_ID;
  panel.className = "fast-nri-applied-effects-panel";
  panel.hidden = true;

  const uiTop = document.getElementById("ui-top");
  (uiTop ?? document.body).append(panel);

  return panel;
}

function tooltipRoot() {
  let tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) return tooltip;

  tooltip = document.createElement("aside");
  tooltip.id = TOOLTIP_ID;
  tooltip.className = "fast-nri-applied-effect-tooltip";
  tooltip.hidden = true;
  document.body.append(tooltip);

  return tooltip;
}

function hideTooltip() {
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) tooltip.hidden = true;
}

async function enrichedDescription(effect) {
  const source = String(effect.system?.description ?? "").trim();
  if (!source) return '<p class="fast-nri-effect-tooltip-empty">Без описания.</p>';

  try {
    const TextEditorClass =
      foundry.applications?.ux?.TextEditor?.implementation
      ?? globalThis.TextEditor;

    if (TextEditorClass?.enrichHTML) {
      return await TextEditorClass.enrichHTML(source, {
        async: true,
        secrets: Boolean(effect.isOwner),
        relativeTo: effect
      });
    }
  } catch (error) {
    console.debug(
      "Быстрая НРИ | Не удалось обогатить описание Effect для tooltip",
      error
    );
  }

  return source;
}

async function showTooltip(effect, button) {
  const tooltip = tooltipRoot();
  const data = effectPanelData(effect, combatDisplayState());
  const description = await enrichedDescription(effect);

  tooltip.innerHTML = `
    <header class="fast-nri-effect-tooltip-header">
      <img src="${escAttr(data.img)}" alt="" />
      <div>
        <strong>${esc(data.name)}</strong>
        <small>${esc(data.kind)}</small>
      </div>
    </header>

    <div class="fast-nri-effect-tooltip-description">
      ${description}
    </div>

    <dl class="fast-nri-effect-tooltip-properties">
      <div>
        <dt>Осталось</dt>
        <dd>${esc(data.durationRemaining)}</dd>
      </div>
      <div>
        <dt>Длительность</dt>
        <dd>${esc(data.durationDefinition)}</dd>
      </div>
      ${data.periodic ? `
      <div>
        <dt>Сохранённое значение</dt>
        <dd>${esc(data.periodicStoredValue)}</dd>
      </div>` : `
      <div>
        <dt>Стаки</dt>
        <dd>${esc(data.stackCount)}</dd>
      </div>
      <div>
        <dt>Режим стаков</dt>
        <dd>${esc(data.stacking)}</dd>
      </div>`}
    </dl>

    <footer>
      ${data.systemOnly
        ? "Системный эффект — снимается автоматически"
        : "ЛКМ — открыть эффект • ПКМ — снять один стак"}
    </footer>
  `;

  tooltip.hidden = false;

  const rect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();

  // Prefer showing the tooltip to the left of the icon column, PF2e-style.
  let left = rect.left - tooltipRect.width - 10;
  if (left < 8) left = Math.min(window.innerWidth - tooltipRect.width - 8, rect.right + 10);

  let top = rect.top;
  if (top + tooltipRect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - tooltipRect.height - 8);
  }

  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function durationBadge(data) {
  if (/Вручную|не запущен/i.test(data.durationRemaining)) return "";

  const roundMatch = data.durationRemaining.match(/^(\d+)\s/);
  if (roundMatch) return roundMatch[1];

  if (/начале хода/i.test(data.durationRemaining)) return "↥";
  if (/конце хода/i.test(data.durationRemaining)) return "↧";

  return "•";
}

async function renderPanel() {
  if (!game.ready) return;

  const generation = ++renderGeneration;
  const panel = panelRoot();
  const actor = selectedEffectActor();

  if (!actor) {
    panel.hidden = true;
    panel.replaceChildren();
    hideTooltip();
    return;
  }

  const effects = actorAppliedEffects(actor);

  if (!effects.length) {
    panel.hidden = true;
    panel.replaceChildren();
    hideTooltip();
    return;
  }

  const combatState = combatDisplayState();
  const rows = effects.map(effect => ({
    effect,
    data: effectPanelData(effect, combatState)
  }));

  if (generation !== renderGeneration) return;

  panel.innerHTML = `
    <div class="fast-nri-applied-effects-icons" aria-label="Действующие эффекты">
      ${rows.map(({ data }) => {
        const duration = durationBadge(data);

        return `
          <button
            type="button"
            class="fast-nri-applied-effect-icon"
            data-fast-nri-panel-effect-id="${escAttr(data.id)}"
            aria-label="${escAttr(data.name)}"
          >
            <img src="${escAttr(data.img)}" alt="" />
            ${data.stackCount > 1
              ? `<span class="fast-nri-panel-stack-badge">${esc(data.stackCount)}</span>`
              : ""}
            ${duration
              ? `<span class="fast-nri-panel-duration-badge">${esc(duration)}</span>`
              : ""}
          </button>
        `;
      }).join("")}
    </div>
  `;

  panel.hidden = false;

  for (const button of panel.querySelectorAll("[data-fast-nri-panel-effect-id]")) {
    const effect = actor.items.get(button.dataset.fastNriPanelEffectId);
    if (!effect) continue;

    button.addEventListener("click", event => {
      event.preventDefault();
      hideTooltip();
      effect.sheet?.render?.({ force: true });
    });

    button.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      hideTooltip();
      if (isSystemOnlyEffect(effect)) return;
      void removeOneEffectStack(effect);
    });

    button.addEventListener("mouseenter", () => {
      void showTooltip(effect, button);
    });

    button.addEventListener("mouseleave", () => {
      hideTooltip();
    });

    button.addEventListener("focus", () => {
      void showTooltip(effect, button);
    });

    button.addEventListener("blur", () => {
      hideTooltip();
    });
  }
}

export function refreshFastNriEffectPanel() {
  void renderPanel();
}

export function activateFastNriEffectPanel() {
  Hooks.on("controlToken", () => refreshFastNriEffectPanel());
  Hooks.on("canvasReady", () => refreshFastNriEffectPanel());
  Hooks.on("combatTurnChange", () => refreshFastNriEffectPanel());
  Hooks.on("updateCombat", () => refreshFastNriEffectPanel());
  Hooks.on("deleteCombat", () => refreshFastNriEffectPanel());

  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => {
      if (item.type !== "effect") return;
      refreshFastNriEffectPanel();
    });
  }

  window.addEventListener("resize", hideTooltip);
  document.addEventListener("pointerdown", event => {
    const panel = document.getElementById(PANEL_ID);
    const tooltip = document.getElementById(TOOLTIP_ID);

    if (
      !panel?.contains(event.target)
      && !tooltip?.contains(event.target)
    ) {
      hideTooltip();
    }
  });

  refreshFastNriEffectPanel();
}
