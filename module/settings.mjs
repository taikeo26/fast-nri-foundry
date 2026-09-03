/**
 * User-facing Fast NRI system settings.
 *
 * Keep gameplay settings centralized here instead of scattering visible
 * switches across migration/feature modules. Hidden migration markers stay in
 * their owning modules.
 */

export const FAST_NRI_SETTING_KEYS = Object.freeze({
  preventDuplicateTargetSelections: "preventDuplicateTargetSelections"
});

export function registerFastNriSettings() {
  game.settings.register(game.system.id, FAST_NRI_SETTING_KEYS.preventDuplicateTargetSelections, {
    name: "HB-05: не добавлять одну цель дважды в один слот",
    hint: "Защита от случайного повторного добавления одной и той же цели в один TargetSlot. Не мешает выбирать ту же цель в других частях/слотах действия. Отключите, чтобы разрешить повторы в одном слоте.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
}

/**
 * World-level UX policy. The setting is read at the moment a target is added,
 * so changing it does not require reload and never rewrites existing state.
 */
export function preventDuplicateTargetSelectionsEnabled() {
  try {
    return Boolean(game.settings.get(game.system.id, FAST_NRI_SETTING_KEYS.preventDuplicateTargetSelections));
  } catch (_error) {
    // Safe default matches the registered setting. This fallback also keeps
    // isolated QA helpers predictable if called before settings are available.
    return true;
  }
}
