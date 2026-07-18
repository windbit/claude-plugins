# Feature: restart-persistence (Stage 1–3)

**Цель.** Рестарт хаба не теряет интерактив. Stage 1 — статус-посты не дублируются в рамках хода
(в памяти, не про рестарт). Stage 2 — reply-fallback маркеры (`pendingAnswer`/`lastFallback`).
Stage 3 — запросы пермишенов и открытые пикеры. Персист — `HubStateRepository` →
`~/.claude/channels/telegram/hub-state.json` (atomic tmp→rename, debounce, flush на shutdown,
hydrate на boot; age-out 1ч).

**Предусловия.** Контейнер `clod-tmux`. ВАЖНО: дефолтная сессия — `--permission-mode bypassPermissions`,
поэтому **пермишены (Stage 3) не триггерятся** — для их теста нужен запуск сессии БЕЗ bypass
(`TELEGRAM_LAUNCH_CMD` без `bypassPermissions` или ручной запуск в пейне). Пикеры триггерятся, если
попросить агента вызвать `AskUserQuestion`.

**Код.** `state-repo.ts` (`HubStateRepository`), hydrate-циклы + `armPending`/`disarmPending`/
`armPermission`/`disarmPermission`/`armPicker`/`disarmPicker` в `hub.ts`, `forwardFallbackReply`,
`recoveredPickers` + грейс.

**Как рестартить хаб в контейнере** (сохранив tmux-сессии — они переживают рестарт хаба):
`pkill -f hub.ts; sleep 1; docker compose exec -d clod-tmux … bun run src/hub.ts`. Смотреть
`hub-state.json` ДО и ПОСЛЕ, лог boot (`reply-fallback: rechecking N …`, `picker recovered`).

---

## Юниты (есть)
- `tests/state-repo.test.ts` ✅ — round-trip permissions+pickers, бэккомпат старого файла.

## Stage 2 — reply-fallback

**RP1. `pendingAnswer` переживает рестарт.** `[СПЕЦ]`
- Шаги: входящее в топик (арм `pendingAnswer`) → до turnend `pkill hub` → поднять хаб.
- Ожидаемо: `hub-state.json` до рестарта содержит `pendingAnswer[key]`; после boot лог
  `reply-fallback: rechecking 1 …`; если ответ агента не ушёл reply-тулом — досыл «↩️ авто-досыл».
- Fail-режим: маркер потерян → fallback никогда не сработает (баг, который Stage 2 и чинит).
- Смотреть: `hub-state.json`, boot-лог, сообщения в чате.

**RP2. `lastFallback` дедупит после рестарта.** `[СПЕЦ]`
- Шаги: fallback уже сработал (в `lastFallback`) → рестарт → turnend ещё раз.
- Ожидаемо: повторного досыла нет (тот же текст в `lastFallback`).
- Смотреть: `hub-state.json`, чат (нет дубля).

## Stage 3 — пикеры

**RP3. Открытый пикер переживает рестарт (без дубля, кнопка жива).** `[СПЕЦ]`
- Шаги: попросить агента `AskUserQuestion` → пришёл пикер-кнопками → `pkill hub` → поднять.
- Ожидаемо: `hub-state.json.pickers[pane]` есть; после boot — тот же пейн показывает тот же хэш →
  `recoveredPickers` усыновляет (лог `picker recovered`), **без нового дубль-сообщения**; тап по
  старой кнопке отвечает агенту.
- Fail-режим: дубль-сообщение; мёртвая кнопка; тап уходит в чужой пейн (проверка `paneBelongsToKey`).
- Смотреть: `hub-state.json`, boot-лог, чат (нет дубля), API (кнопки), пейн (`capture-pane`).

**RP4. Пикер на переиспользованном пейне не отвечает за чужого.** `[СПЕЦ]`
- Шаги: пикер открыт → сессия убита, пейн отдан другой сессии → тап по старой кнопке.
- Ожидаемо: `paneBelongsToKey` ложь → «Пикер закрыт», без sendKeys в чужой пейн.
- Смотреть: чат (ответ callback), пейн.

## Stage 3 — пермишены — ~~RP5~~ ОТМЕНЁН

Канальный permission-путь (`pendingPermissions`) **удалён** (см. `permissions.md`, коммит 0a9619c) —
полагаемся на picker. Значит персист пермишена = **персист пикера (RP3 ✅)**. Отдельного RP5 нет.

## Лог прогона

- **2026-07-18 (проход 1)** — fault-injection в контейнере (рестарт хаба при открытом пикере):
  - **RP3 ✅ ПОЛНЫЙ** — попросил агента `AskUserQuestion` → пикер кнопками (msg64: Красный/Синий/
    Chat/Свой). `hub-state.json.pickers["%0"]` = полный DTO (msg64, hash 9354c142). `pkill hub` →
    поднял. Boot-лог: **`picker recovered: pane=%0 msg=64`**, **дубля НЕ создано** (msg64 остался
    последним пикером). Тап «Красный» ПОСЛЕ рестарта → callback «Выбрано» → msg64 → «✅ Красный»,
    агент получил ответ (пейн: `⎿ · Какой цвет выбрать? → Красный`, `● Выбор получен: Красный`),
    ответил (msg65). После резолва `hub-state.pickers` = `{}` (disarmPicker персистит удаление).
    → Stage 3 пикеры переживают рестарт end-to-end, включая доставку ответа агенту.
  - **RP1 частично ✅** — тот же рестарт: boot-лог `reply-fallback: rechecking 1 pending marker(s)
    recovered from disk` → `pendingAnswer` пережил рестарт, recheck отработал. (Полный сценарий с
    «агент не ответил reply» — отдельно.)
  - Не гонялись: RP2 (дедуп fallback), RP4 (переиспользованный пейн), **RP5 (пермишены — нужна
    non-bypass сессия)**.
- **TODO проход 2:** RP5 (запуск сессии без `bypassPermissions` → тул с запросом разрешения →
  рестарт → «Разрешить» находит живой conn), RP4 (paneBelongsToKey на recycled-пейне), RP2.
