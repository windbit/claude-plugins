# Feature map

Карта функциональных зон хаба. По каждой заводим `features/<id>.md` (по шаблону из README) в момент
прохода. Статус: ⬜ не начато · 🟡 сценарии написаны · 🟢 прогнано+зелёное · 🔴 есть открытые баги.

| # | Фича (id) | Что покрывает | Ключевой код | Статус |
|---|---|---|---|---|
| 1 | `binding-routing` | `/bind` `/unbind` `/allow`, ключ чата→`bindings.json`→папка→сессии, hot-reload, доступ (admin/allow) | `hub.ts` роутинг, `bindings.ts`, `registry.ts` | ⬜ |
| 2 | `trusted-groups` | авто-бинд новых топиков, режимы folder/worktree, хук `wt.py`, транслит кириллицы, выбор режима | `pendingTopics`/`pendingModeChoice`, `runAutoTopic` | ⬜ |
| 3 | `session-lifecycle` | `/resume` `/new` `/restart` `/stop`, автоспавн хаба, авто-ack стартовых промптов, не-двойной-старт, `reviveBoundSessions` | `spawnSession`, `restartSession`, `stopSession` | 🟢 (SL4 restart+контекст ✅, SL5 не-двойной ✅, SL1-3 ✅ набл.; TODO SL6) |
| 4 | `death-notice` | 💀 при пропаже tmux/процесса без `/restart`, грейс | `notifyUnexpectedDeath` | 🟢 (DN1 kill→💀 ✅, DN2 штатный-без-💀 ✅; TODO DN3 реконнект-в-грейсе) |
| 5 | `core-messaging` | входящее→сессия (только reply, не транскрипт), `reply`/`react`/`edit_message`, очередь при спавне | `handleInbound`, `enqueueForTopic`/`flushQueued` | 🟢 (CM4 очередь-hold ✅ e2e, CM1/CM5/CM6 ✅ набл.; TODO react/edit-тулы) |
| 6 | `picker-bridge` | `AskUserQuestion`/`/model`→кнопки, single/multi/custom, тап→кейстроки, авто-ack trust-промптов | `detectPicker`, `picker.ts`, `handlePickCallback` | 🟢 (PB1 single ✅, PB2 /model ✅, PB5 trust-ack ✅; TODO multi/custom/PB6-7) |
| 7 | `permissions` | разрешение тула → picker Yes/No в топике (канальный 🔐-путь убран) | picker-мост (`detectPicker`) | 🟢 (канальный путь удалён 0a9619c; picker — единственный UX, проверено e2e) |
| 8 | `status-posts` | самообновляемые посты: агенты/тудушки/скиллы (PerTurnEditablePost) | `PerTurnEditablePost`, `subagent-hook.ts` | 🟢 (SP1 todo один-пост-без-дублей ✅, SP4 ✅; TODO агенты/скиллы/мульти-трекер) |
| 9 | `ops-commands` | `/compact` `/clear` `/esc`(дренаж очереди) `/enter` `/status` `/model` | ops-диспатч в `hub.ts`, `parseOpsCommand` | 🟢 (OC3 esc-прерывание ✅, OC4 compact ✅, OC1/OC2/OC7 ✅; TODO clear/enter) |
| 10 | `live-views` | `/screen`(PNG) `/last`(текст), one-per-pane, Закрыть, авто-стоп, 5с | `startLiveScreen`, `paneDigest`, `renderScreenPng` | 🟢 (P1/P3/P4/N1/N2/N3 ✅; остаётся P2 chrome, N4 рестарт-шов) |
| 11 | `voice` | STT входящих, TTS `reply(voice:true)` | STT/TTS в `hub.ts`/`stub.ts` | 🟢 (V2 TTS→sendVoice ✅, V3 no-key→текст ✅; V1 STT-in — механизм доказан, e2e-инъекция в топик TODO) |
| 12 | `skills` | глобальные скиллы как команды бота, меню `/skills` (пагинация), инъекция слэша (фаззи-фикс) | `skills.ts`, `typeSlashCommand`, `injectSlashToPanes` | 🟢 (SK2 регрессия-литерал ✅ e2e, SK3 пустой стейт ✅, SK5 шов ✅; TODO меню-пагинация+мэнглинг) |
| 13 | `reply-fallback` | добор ответа из транскрипта на turnend, если агент не отправил | `forwardFallbackReply`, `session-id.ts` | 🟢 (RF1 авто-досыл ✅ e2e, RF2/RF3/RF4 ✅) |
| 14 | `restart-persistence` | Stage 1 посты / Stage 2 fallback / Stage 3 пермишены+пикеры через рестарт | `state-repo.ts`, hydrate в `hub.ts` | 🟡 (RP3 пикеры ✅ end-to-end, RP1 fallback-маркер ✅; RP5 пермишены — нужна non-bypass сессия) |
| 15 | `context-badge` | `⚠️ Контекст NN%` перед ответом при пороге | `parseContextPct`, `TELEGRAM_CONTEXT_WARN_PCT` | ⬜ |
| 16 | `pane-detectors` | детект компакции/воркфлоу/ошибок в `pollScreens` | `handleCompaction`/`handleWorkflow`/`handleErrors` | ⬜ |
| 17 | `debug-log` | `screenlog.jsonl` — таймлайн, кольцо 1000, финальный текст | `logDebugEvent` | ⬜ |

Порядок прохода — по приоритету/свежести (сначала то, что недавно трогали и где уже были баги:
`live-views`, `restart-persistence`, `skills`, `picker-bridge`).
