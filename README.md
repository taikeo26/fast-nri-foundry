# Быстрая НРИ 6.3 для Foundry VTT 14

Система реализует рабочее боевое ядро редакции 6.3 и развивается по принципу мягкой автоматизации: Foundry считает, бросает, предупреждает и подготавливает следующие действия, но игровой выбор остаётся у игрока или ведущего.

## Установка

Установите систему по manifest URL:

`https://github.com/taikeo26/fast-nri-foundry/releases/latest/download/system.json`

Поддерживаемая версия Foundry VTT: **14**.

## Основной workflow

- Weapon Attack создаёт карточку атаки с доступными профилями урона.
- Ability/Spell публикует карточку с полным текстом и явными кнопками следующих действий.
- Каждый Attack, Damage, Healing, Effect и Defense создаёт отдельную chat-card.
- Базовые ресурсы редактируются вручную; явно указанная стоимость классового ресурса списывается с Undo.
- Effect Item хранит игровое состояние, ActiveEffect используется как визуальное зеркало Foundry.

## Проверка исходников

Из корня репозитория системы:

```bash
for test_file in tests/*.mjs; do node "$test_file"; done
find . -type f \( -name '*.js' -o -name '*.mjs' \) -print0 \
  | sort -z \
  | xargs -0 -n1 node --check
```

Текущий статус и незакрытые задачи находятся в `../STATUS.md` и `../docs/ROADMAP_6.3.md` мастер-архива.
