# Feature map

Карта функциональных зон хаба. По каждой заводим `features/<id>.md` (по шаблону из README) в момент
прохода. Статус: ⬜ не начато · 🟡 сценарии написаны · 🟢 прогнано+зелёное · 🔴 есть открытые баги.

| # | Фича (id) | Что покрывает | Ключевой код | Статус |
|---|---|---|---|---|
| 1 | `binding-routing` | `/bind` `/unbind` `/allow`, ключ чата→`bindings.json`→папка→сессии, hot-reload, доступ (admin/allow) | `hub.ts` роутинг, `bindings.ts`, `registry.ts` | ⬜ |
| 2 | `trusted-groups` | авто-бинд новых топиков, режимы folder/worktree, хук `wt.py`, транслит кириллицы, выбор режима | `pendingTopics`/`pendingModeChoice`, `runAutoTopic` | ⬜ |
| 3 | `session-lifecycle` | `/resume` `/new` `/restart` `/stop`, автоспавн хаба, авто-ack стартовых промптов, не-двойной-старт, `reviveBoundSessions` | `spawnSession`, `restartSession`, `stopSession` | ⬜ |
| 4 | `death-notice` | 💀 при пропаже tmux/процесса без `/restart`, грейс | `notifyUnexpectedDeath` | ⬜ |
| 5 | `core-messaging` | входящее→сессия (только reply, не транскрипт), `reply`/`react`/`edit_message`, очередь при спавне | `handleInbound`, `enqueueForTopic`/`flushQueued` | ⬜ |
| 6 | `picker-bridge` | `AskUserQuestion`/`/model`→кнопки, single/multi/custom, тап→кейстроки, авто-ack trust-промптов | `detectPicker`, `picker.ts`, `handlePickCallback` | ⬜ |
| 7 | `permissions` | кнопки allow/deny/подробнее, текст `y/n <token>` | `doPermissionRequest`, `resolvePermission` | ⬜ |
| 8 | `status-posts` | самообновляемые посты: агенты/тудушки/скиллы (PerTurnEditablePost) | `PerTurnEditablePost`, `subagent-hook.ts` | ⬜ |
| 9 | `ops-commands` | `/compact` `/clear` `/esc`(дренаж очереди) `/enter` `/status` `/model` | ops-диспатч в `hub.ts`, `parseOpsCommand` | ⬜ |
| 10 | `live-views` | `/screen`(PNG) `/last`(текст), one-per-pane, Закрыть, авто-стоп, 5с | `startLiveScreen`, `paneDigest`, `renderScreenPng` | 🟡 |
| 11 | `voice` | STT входящих, TTS `reply(voice:true)` | STT/TTS в `hub.ts`/`stub.ts` | ⬜ |
| 12 | `skills` | глобальные скиллы как команды бота, меню `/skills` (пагинация), инъекция слэша (фаззи-фикс) | `skills.ts`, `typeSlashCommand`, `injectSlashToPanes` | ⬜ |
| 13 | `reply-fallback` | добор ответа из транскрипта на turnend, если агент не отправил | `forwardFallbackReply`, `session-id.ts` | ⬜ |
| 14 | `restart-persistence` | Stage 1 посты / Stage 2 fallback / Stage 3 пермишены+пикеры через рестарт | `state-repo.ts`, hydrate в `hub.ts` | 🟡 |
| 15 | `context-badge` | `⚠️ Контекст NN%` перед ответом при пороге | `parseContextPct`, `TELEGRAM_CONTEXT_WARN_PCT` | ⬜ |
| 16 | `pane-detectors` | детект компакции/воркфлоу/ошибок в `pollScreens` | `handleCompaction`/`handleWorkflow`/`handleErrors` | ⬜ |
| 17 | `debug-log` | `screenlog.jsonl` — таймлайн, кольцо 1000, финальный текст | `logDebugEvent` | ⬜ |

Порядок прохода — по приоритету/свежести (сначала то, что недавно трогали и где уже были баги:
`live-views`, `restart-persistence`, `skills`, `picker-bridge`).
