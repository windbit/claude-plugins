// Russian UI strings. Typed against `typeof en` (via Strings) so the compiler flags drift.
import type { Strings } from './index'

export const ru: Strings = {
  // ── bot command descriptions ──
  cmd_status: 'Статус сессии (папка/tmux/claude/лимиты)',
  cmd_resume: 'Поднять сессию (с выбором, какую)',
  cmd_screen: 'Показать экран сессии как есть',
  cmd_last: 'Последнее с экрана текстом (живо, без картинки)',
  cmd_new: 'Запустить свежую сессию',
  cmd_skills: 'Проектные скиллы этой сессии (кнопками)',
  cmd_stand_up: 'Поднять стенд этой папки (хук из .tmux-channels.json)',
  cmd_stand_down: 'Погасить стенд этой папки',
  cmd_pin: 'Не выгружать эту сессию по простою',
  cmd_unpin: 'Разрешить выгрузку по простою',
  cmd_reload: 'Пересканировать скиллы плагинов → команды',
  cmd_compact: 'Отправить /compact в сессию',
  cmd_clear: 'Очистить историю сессии',
  cmd_esc: 'Прервать текущий ход',
  cmd_enter: 'Отправить Enter (сабмитнуть строку ввода)',
  cmd_model: 'Выбрать модель (интерактивно, кнопками)',
  cmd_stop: 'Остановить сессию (graceful /exit → Ctrl-C)',
  cmd_restart: 'Аккуратный перезапуск сессии',
  cmd_bind: 'Привязать этот чат/топик к папке проекта (админ)',
  cmd_unbind: 'Снять привязку (админ)',
  cmd_delete: 'Снять привязку + удалить топик (админ)',
  cmd_allow: 'Дать доступ пользователю к этому биндингу (админ)',
  cmd_lang: 'Переключить язык интерфейса en/ru (админ)',

  // ── session lifecycle / delivery ──
  contextWarn: pct => `\n\n⚠️ Контекст: ${pct}%`,
  sessionDied:
    '💀 <b>Сессия оборвалась неожиданно</b> (процесс/tmux пропал без <code>/restart</code>). ' +
    'Напиши что-нибудь — переподнимется автоматически, или используй <code>/resume</code>.',
  truncatedNote: '…(ответ обрезан)',
  autoForwardLabelHtml: '↩️ <i>авто-досыл</i>',
  autoForwardLabelPlain: '↩️ авто-досыл',
  raisingSession: '▶️ <b>Поднимаю сессию…</b>',
  sessionNotConnectedInTime: '⚠️ Сессия не подключилась вовремя — сообщение не доставлено, попробуй ещё раз.',
  sessionNotUpInTime: '⚠️ Сессия не поднялась вовремя — отложенные сообщения не доставлены, повтори.',
  notInTmuxSlash: '⚠️ Сессия не в tmux — слэш-команду не набрать.',
  tmuxCreated: (name, path) => `🪟 tmux <code>${name}</code> создан в ${path}.`,
  tmuxExists: name => `🪟 tmux <code>${name}</code> уже есть — набираю запуск в его активный pane.`,
  modeResume: '🚀 <b>Возобновляю</b>',
  modeRestart: '🚀 <b>Запускаю заново</b>',
  modeNew: '🆕 <b>Запускаю сессию</b>',
  spawnFailed: (mode, err) => `⚠️ <b>${mode} не удалось</b>: ${err}`,
  sessionSpawnFail: err => `⚠️ <b>Не удалось поднять сессию</b>: ${err}`,

  // ── pickers ──
  pickerDefaultTitle: 'Вопрос',
  pickerAnsweredInTerminal: '<i>отвечено в терминале</i>',
  pickerClosedRestart: '❓ <i>Пикер закрыт (рестарт)</i>',
  pickerClosedNoRevive: '❓ <i>Пикер закрыт (сессия не восстановилась)</i>',
  sendAnswerMsg: '✍️ <b>Пришли ответ</b> сообщением.',

  // ── notifiers ──
  agentsHeader: '🤖 <b>Агенты</b>',
  compaction: (bar, pct, elapsed) => `🗜 <b>Компакция</b> ${bar} ${pct}%${elapsed ? ` <i>(${elapsed})</i>` : ''}`,
  compactionDone: '✅ <b>Компакция готова.</b>',
  workflow: (name, done, total) => `${done >= total ? '✅' : '🤖'} <b>Воркфлоу</b> <code>${name}</code> — ${done}/${total} агентов`,
  workflowDone: (name, total) => `✅ <b>Воркфлоу</b> <code>${name}</code> готов (${total} агентов)`,
  authHint:
    '\n\n🔑 Ход умирает сразу — ответа не будет. Сначала <code>/restart</code> (часто это протухшая авторизация ' +
    'в памяти процесса); если повторится — на хосте нужен <code>claude /login</code>.',
  sessionError: (err, hint) => `⛔️ <b>Ошибка в сессии</b>\n\n<code>${err}</code>${hint}`,
  tasksHeader: '📋 <b>Задачи</b>',
  skillLine: (skill, args) => `🧩 Скилл: <b>${skill}</b>${args ? ` — <i>${args}</i>` : ''}`,

  // ── screen / last ──
  updateStopped: 'обновление остановлено',
  btnClose: '✖️ Закрыть',
  btnCancel: '✖️ Отмена',
  btnNewSession: '🆕 Новая сессия',

  // ── callback toasts ──
  toastPickerClosed: 'Пикер закрыт',
  toastNoAccess: 'Нет доступа',
  toastChosen: 'Выбрано',
  toastSent: 'Отправлено',
  toastSendText: 'Пришли текст',
  toastClosed: 'Закрыто',
  toastMenuStale: 'Меню устарело — вызови /skills снова',
  toastNoLiveResume: 'Нет живой сессии — /resume',
  toastNotInTmux: 'Сессия не в tmux',
  toastAlreadyChosen: 'Уже выбрано или устарело',
  toastNoRights: 'Нет прав',
  toastBindingGone: 'Привязка исчезла',
  toastSessionGoneResume: 'Сессия пропала — вызови /resume заново',
  toastSwitching: 'Переключаю…',
  toastRaising: 'Поднимаю…',
  toastLaunching: 'Запускаю…',
  toastRun: name => `▶ /${name}`,

  // ── skills menu / reload ──
  rescanning: '⏳ Пересканирую скиллы…',
  skillsScanFail: '⚠️ Не смог просканировать скиллы.',
  skillsCollapsed: (n, prev, failed, retrySec) =>
    `⚠️ Скиллы схлопнулись (${n} < ${prev}), ${failed} плагин(ов) не ответили — держу прошлый список, ретрай через ${retrySec}с.`,
  cmdsSummary: (total, ops, skills, dropped, capNote, failNote) =>
    `📋 Команд: ${total} (опсы ${ops} + скиллы ${skills}${dropped ? `, пропущено ${dropped}` : ''}${capNote}${failNote}).`,
  cmdsCapNote: cap => `, описания ≤${cap}`,
  cmdsFailNote: (failed, retrySec) => `; ⚠️ ${failed} плагин(ов) не ответили, ретрай через ${retrySec}с`,
  noProjectSkills: dir =>
    `📂 Нет проектных скиллов в <code>${dir}/.claude/skills</code>.\n\nГлобальные — набирай как команды, автодополнение по <code>/</code>.`,
  projectSkillsMenu: count => `📂 <b>Проектные скиллы</b> (${count}) — тапни, чтобы запустить:`,
  skillLaunched: name => `▶️ <b>/${name}</b> — запущено.`,

  // ── bindings / access ──
  noBinding: '⚠️ Тут нет привязки — сначала <code>/bind</code>.',
  noBindingBindFirst: '⚠️ Тут нет привязки — сначала <code>/bind &lt;папка&gt;</code>.',
  bindUsage: projects => `Использование: <code>/bind &lt;папка&gt;</code>\n\nИмя в ${projects} или абсолютный путь.`,
  bound: (key, path) => `🔗 <b>Привязано</b>\n\n<code>${key}</code> → ${path}\n\nКак стартуем?`,
  bindFail: err => `⚠️ <b>Не удалось привязать</b>: ${err}`,
  nothingBoundHere: 'Здесь ничего не привязано.',
  nothingBoundBindFirst: 'Здесь ничего не привязано. Сначала <code>/bind &lt;папка&gt;</code>.',
  bindFirst: 'Сначала привяжи: <code>/bind &lt;папка&gt;</code>',
  allowNobody: '<i>никого</i>',
  allowStatus: current =>
    `👥 <b>Доступ</b>: ${current}\n\nИспользование: <code>/allow &lt;id …&gt;</code>\n<i>Убрать — правкой bindings.json.</i>`,
  allowUsage: 'Использование: <code>/allow &lt;id …&gt;</code>',
  allowSet: ids => `✅ <b>Доступ</b>: <code>${ids}</code>`,

  // ── unbind / delete ──
  unbound: tidPart => `🔓 <b>Отвязано</b>${tidPart}`,
  unboundTopicPart: tid => ` — топик <code>#${tid}</code>`,
  unboundSessionPart: sid => `\n💬 Сессия <code>${sid}</code>`,
  tmuxClosed: name => `\n🪟 tmux <code>${name}</code> закрыт.`,
  cleanupHookOk: branch => `\n🗑 Хук очистки (<code>${branch}</code>) выполнен.`,
  cleanupHookFail: err => `\n⚠️ Хук очистки не удался: ${err}`,
  worktreeRemoved: '\n🗑 Worktree удалён (<code>git worktree remove</code>).',
  worktreeRemoveFail: err => `\n⚠️ Удаление worktree не удалось: ${err}`,
  topicDeletedCleanup: note => `🗑 <b>Топик удалён</b> — прибрал за ним.\n\n${note}`,
  deleteOnlyInTopic: '❌ <code>/delete</code> — только в топике форума (General/обычную группу так не удалить).',
  noBindingInTopic: (tid, title) => `🔓 <i>Бинда в топике <code>#${tid}</code>${title ? ` «${title}»` : ''} не было.</i>`,
  topicDeletedShort: tid => `🗑 Топик <code>#${tid}</code> удалён.`,
  topicDeleteFail: err => `⚠️ Топик не удалён (у бота есть право can_delete_messages?): ${err}`,

  // ── stand ──
  standUpProgress: '⏳ Поднимаю стенд…',
  standDownProgress: '⏳ Гашу стенд…',
  noStandConfig: (dir, cfgFile, kind) =>
    `📄 В ${dir} нет <code>${cfgFile}</code> с командой <code>stand.${kind}</code>.\n\n` +
    `Пример: <code>{ "stand": { "up": "…", "down": "…", "status": "…" } }</code>`,
  standUpOk: '🟢 <b>Стенд поднят</b>',
  standDownOk: '⚪️ <b>Стенд погашен</b>',
  standHookFail: kind => `⚠️ <b>Хук стенда (${kind}) упал</b>`,

  // ── pin / unpin ──
  pinned: idleOffNote => `📌 <b>Закреплено</b> — эта сессия не выгружается по простою.${idleOffNote}`,
  pinnedIdleOffNote: '\n<i>(авто-выгрузка сейчас выключена — TELEGRAM_IDLE_UNLOAD_MINUTES=0)</i>',
  unpinned: whenNote => `📌 <b>Откреплено</b> — сессия снова выгружается по простою${whenNote}.`,
  unpinnedInNote: min => ` (через ${min} мин)`,
  unpinnedWhenOnNote: ' <i>(когда включат авто-выгрузку)</i>',

  // ── /resume ──
  noSessionNamed: (want, dir) =>
    `⚠️ Нет сессии <code>${want}</code> в ${dir}.\n\n<code>/resume</code> без аргумента покажет список.`,
  prefixAmbiguous: (want, count) => `⚠️ Префикс <code>${want}</code> подходит ${count} сессиям — уточни.`,
  couldntStopCurrentScreen: '⚠️ Не смог остановить текущую сессию — глянь <code>/screen</code>.',
  sessionListFail: '⚠️ Список сессий не открылся (агент занят?). Попробуй позже, глянь /screen, или /stop и затем /resume.',
  switchSessionHdr: total => `⏪ <b>Переключить сессию</b> <i>(${total}, без перезапуска)</i>`,
  alreadyConnected: pane => `⚙️ Сессия уже подключена <i>(${pane})</i>.\n\nИспользуй <code>/restart</code> или <code>/compact</code>.`,
  alreadyConnectedNoTmux: 'не в tmux',
  foreignClaude: pids =>
    `⚠️ <b>Эту беседу уже ведёт claude вне хаба</b> <i>(pid ${pids})</i> — ` +
    'хаб им не управляет.\n\nНе поднимаю вторую: <code>/resume</code> форкнул бы её. ' +
    'Закрой ту сессию (или перезапусти её с dev-каналом) и повтори.',
  whichSessionRaise: '⏪ <b>Какую сессию поднять?</b> (свежие сверху)',
  switchedTo: title => `⏪ Переключился: <b>${title}</b>`,
  staleListChanged: 'Список изменился — вызови /resume заново',
  staleCursorMiss: 'Не попал по курсору — вызови /resume заново',
  closedShort: '✖️ Закрыто.',
  stoppingCurrentSession: '🛑 Останавливаю текущую сессию…',
  couldntStopCurrentTmux: '⚠️ Не смог остановить текущую сессию — глянь в tmux.',
  resumingId: id => `⏪ Возобновляю <code>${id}…</code>`,
  launchingNew: '🆕 Запускаю новую сессию…',

  // ── compact / clear / esc / enter / model / stop / restart ──
  noLiveSession: '⚠️ Нет живой сессии. Попробуй <code>/resume</code>.',
  notInTmuxControl: '⚠️ Сессия не в tmux — не могу ей управлять.',
  compactSent: '🗜 <code>/compact</code> отправлен.',
  historyCleared: '🧹 <b>История очищена.</b>',
  escSent: '⎋ <b>Esc</b> отправлен (+ очередь ввода очищена).',
  enterSent: '⏎ <b>Enter</b> отправлен.',
  modelSent: '📋 <code>/model</code> отправлен — жди меню с кнопками.',
  stopNoProc: '⚠️ Стоп недоступен — не опознал процесс claude.',
  stopping: '🛑 <b>Останавливаю</b> сессию… Если всплывёт вопрос про фоновые задачи — ответь кнопками, иначе через ~10с выйду сам.',
  procNotDead: '⚠️ Процесс не умер — глянь руками в tmux.',
  sessionStopped: '🛑 <b>Сессия остановлена.</b> Что дальше?',
  stopFail: err => `⚠️ Стоп не удался: ${err}`,
  restartNoProc: '⚠️ Рестарт недоступен — не опознал процесс claude.',
  restarting: '♻️ <b>Перезапускаю</b> сессию…',
  restartSent: '♻️ Перезапуск отправлен.',
  restartFail: err => `⚠️ Рестарт не удался: ${err}`,
  cmdFail: (cmd, err) => `⚠️ <b>${cmd} не удалось</b>: ${err}`,

  // ── status ──
  statusNotBound: key => `📊 <b>${key}</b>\n\n<i>Не привязано.</i> Привяжи через <code>/bind &lt;папка&gt;</code> (админ).`,
  pidAlive: pid => `жив <i>(pid ${pid})</i>`,
  pidDead: pid => `<b>мёртв</b> <i>(pid ${pid})</i>`,
  pidUnknown: 'pid неизвестен',
  statusClaudeConnected: pidState => `🟢 claude: подключён, ${pidState}`,
  statusClaudeDisconnected: '⚪️ claude: не подключён',
  tmuxHas: 'есть',
  tmuxNone: 'нет сессии',
  statusTmux: (name, state) => `🪟 tmux <code>${name}</code>: ${state}`,
  statusResumeHint: '→ <code>/resume</code> чтобы поднять',
  statusPinned: '📌 закреплена — не выгружается по простою',
  statusIdleUnload: min => `💤 выгрузка по простою через ${min} мин (<code>/pin</code> чтобы держать)`,
  statusStandUp: url => `🖥 стенд: 🟢 поднят${url ? ` → ${url}` : ''}`,
  statusStandDown: '🖥 стенд: ⚪️ не поднят → <code>/stand_up</code>',
  statusAccess: ids => `👥 доступ: <code>${ids}</code>`,

  // ── new-topic mode prompt ──
  ownDirLabel: '✏️ Своя папка',
  sendFolderPromptBind: '📁 Пришли папку для этого топика — как в <code>/bind</code>: имя в ~/projects или абсолютный путь.',
  sendFolderPromptShort: '📁 Пришли папку — как в <code>/bind</code>: имя в ~/projects или абсолютный путь.',
  branchNote: branch => `, ветка <code>${branch}</code>`,
  preparingSession: (mode, branchNote) => `⏳ Готовлю сессию (<code>${mode}</code>${branchNote})…`,
  notAFolder: err => `⚠️ <b>Не похоже на папку</b>: ${err}\n\nПришли ещё раз.`,
  modeIntroFolder: '📁 <b>Папка по умолчанию</b> — работать прямо в базе.',
  modeIntroWorktree:
    '🌿 <b>Worktree</b> — своя git-ветка/папка от базы (обычный <code>git worktree add</code>, ' +
    'или внешний скрипт из конфига группы, если задан — напр. ещё поднимает БД).',
  modeBaseSet: dir => `База: ${dir}`,
  modeBaseUnset: 'База не задана — после выбора спрошу папку.',
  ownDirSuffix: label => `${label} — указать путь для этого топика вручную.`,
  newTopicPrompt: 'Похоже, это новый топик — как поднять сессию?',
  howRaiseTopic: 'Как поднять сессию для этого топика?',
  modeChosen: label => `${label} — выбрано.`,

  // ── mode labels (trusted-groups) ──
  modeLabelFolder: '📁 Папка по умолчанию',
  modeLabelWorktree: '🌿 Worktree (своя git-ветка)',

  // ── picker keyboard (picker-drive) ──
  pkCustom: '✍️ Свой вариант',
  pkSubmit: '✅ Submit',
  pkTitleDefault: 'Выбор:',

  // ── limits (limits.ts) ──
  durZero: '0м',
  durDaysHours: (d, h) => `${d}д${h}ч`,
  durHoursMins: (h, mm) => `${h}ч${mm}м`,
  durMins: m => `${m}м`,
  limContext: pct => `Контекст: ${pct}`,
  limReset: until => `, сброс ${until}`,
  limFiveHour: (pct, reset) => `Сессия 5ч: ${pct}${reset}`,
  limSevenDay: (pct, reset) => `Сессия 7д: ${pct}${reset}`,
  limStale: ago => `(данные ${ago} назад)`,

  // ── /lang ──
  langUsage: cur => `Использование: <code>/lang en</code> | <code>/lang ru</code>\n\nСейчас: <b>${cur}</b>.`,
  langSwitched: lang => `🌐 Язык интерфейса: <b>${lang}</b>. Обновляю команды…`,
}
