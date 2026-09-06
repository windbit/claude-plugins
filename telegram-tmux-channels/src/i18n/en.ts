// English UI strings — the canonical table (its shape defines `Strings`; ru.ts must match).
// Values are plain strings or template fns. Dynamic args are pre-escaped by call sites.
export const en = {
  // ── bot command descriptions (setMyCommands; switch globally with /lang) ──
  cmd_status: 'Session status (folder/tmux/claude/limits)',
  cmd_doctor: 'Diagnose hub, Telegram, routing and session',
  cmd_resume: 'Bring up a session (pick which)',
  cmd_screen: 'Show the session screen as-is',
  cmd_last: 'Latest screen text (live, no image)',
  cmd_new: 'Start a fresh session',
  cmd_fork: 'Fork this conversation into its own topic',
  cmd_skills: "This project's skills (buttons)",
  cmd_stand_up: "Bring up this folder's stand (hook from .tmux-channels.json)",
  cmd_stand_down: "Tear down this folder's stand",
  cmd_pin: "Don't idle-unload this session",
  cmd_unpin: 'Allow idle-unload again',
  cmd_reload: 'Rescan plugin skills → commands',
  cmd_compact: 'Send /compact to the session',
  cmd_clear: 'Clear session history',
  cmd_esc: 'Interrupt the current turn',
  cmd_enter: 'Send Enter (submit the input line)',
  cmd_queue: 'Queue a message instead of interrupting the running turn',
  cmd_send: 'Send text literally, bypassing hub slash commands',
  sendUsage: 'Usage: <code>/send text</code>, or reply to a message with <code>/send</code>.',
  queueUsage:
    '📥 <b>/queue &lt;text&gt;</b> (or <code>/q</code>) — hold the text until the current turn ends, ' +
    'instead of cutting into it. With the session idle it goes straight through.',
  cmd_model: 'Pick a model (interactive, buttons)',
  cmd_stop: 'Stop the session (graceful /exit → Ctrl-C)',
  cmd_restart: 'Gracefully restart the session',
  cmd_bind: 'Bind this chat/topic to a project folder (admin)',
  cmd_unbind: 'Remove the binding (admin)',
  cmd_delete: 'Remove binding + delete the topic (admin)',
  cmd_allow: 'Grant a user access to this binding (admin)',
  cmd_lang: 'Switch interface language en/ru (admin)',

  // ── session lifecycle / delivery ──
  contextWarn: (pct: string) => `\n\n⚠️ Context: ${pct}%`,
  sessionDied:
    '💀 <b>Session dropped unexpectedly</b> (process/tmux vanished without <code>/restart</code>). ' +
    'Send anything — it revives automatically, or use <code>/resume</code>.',
  truncatedNote: '…(reply truncated)',
  autoForwardLabel: '↩️ *auto-forward*', // markdown: the label rides through the same renderer as the body
  raisingSession: '▶️ <b>Bringing the session up…</b>',
  sessionNotConnectedInTime: '⚠️ Session did not connect in time — message not delivered, try again.',
  sessionSlowHeld: '⏳ <b>Session is still coming up</b> — the message is held and goes through the moment it connects.',
  bringUpStuck: (seconds: number) =>
    `⚠️ <b>Session still isn't up after ${seconds}s</b>

Send <code>/last</code> to see its terminal, or <code>/restart</code>.`,
  directiveNotDelivered: (text: string) =>
    `⚠️ <b>The branch didn't take its directive</b> — its terminal wasn't accepting input. Send it again:\n<code>${text}</code>`,
  deliveryLost:
    '⚠️ <b>The session never received that message</b> — sent it twice, nothing reached the conversation. ' +
    'Try <code>/restart</code>, then send it again.',
  notInTmuxSlash: '⚠️ Session is not in tmux — can\'t type the slash command.',
  commandRejected: (line: string) => `⚠️ <b>The CLI did not take that command</b>\n\n<code>${line}</code>`,
  sessionFolder: (path: string) => `📁 ${path}`,
  tmuxForeignAgent: (command: string) => `⚠️ An unconnected <code>${command}</code> is already active in this tmux pane; refusing to type a launch into it.`,
  spawnInProgress: '⏳ This session is already starting; the duplicate launch was skipped.',
  modeResume: '🚀 <b>Resuming</b>',
  modeRestart: '🚀 <b>Restarting fresh</b>',
  modeNew: '🆕 <b>Starting a session</b>',
  modeFork: '🌱 <b>Forking the conversation</b>',
  spawnFailed: (mode: string, err: string) => `⚠️ <b>${mode} failed</b>: ${err}`,
  bindingDirectoryMissing: (path: string) =>
    `⚠️ <b>The bound folder no longer exists</b>: ${path}\nRebind this chat with <code>/bind &lt;folder&gt;</code>.`,
  adminOnly: (command: string) => `🔒 <code>/${command}</code> is available to the hub admin only.`,
  sessionSpawnFail: (err: string) => `⚠️ <b>Couldn't bring the session up</b>: ${err}`,
  retrySetup: '🔁 Retry',
  deleteAnyway: '🗑 Delete anyway',
  toastRetrying: 'Retrying…',
  toastRetryGone: 'This retry has expired — send any message to start over',

  // ── pickers ──
  pickerDefaultTitle: 'Question',
  pickerAnsweredInTerminal: '<i>answered in the terminal</i>',
  pickerClosedRestart: '❓ <i>Picker closed (restart)</i>',
  pickerClosedNoRevive: '❓ <i>Picker closed (session did not recover)</i>',
  pickerSessionGone: '<i>closed — the session was stopped</i>',
  sendAnswerMsg: '✍️ <b>Send the answer</b> as a message.',
  pkCustomSavedSubmit: 'Custom option saved. Press Submit to send the full selection.',

  // ── notifiers (agents / compaction / workflow / tasks / skills / errors) ──
  agentsHeader: '🤖 <b>Agents</b>',
  compaction: (bar: string, pct: string, elapsed: string) =>
    `🗜 <b>Compaction</b> ${bar} ${pct}%${elapsed ? ` <i>(${elapsed})</i>` : ''}`,
  compactionStarted: (trigger: string) => `🗜 <b>Compaction</b>${trigger ? ` <i>(${trigger})</i>` : ''}`,
  compactionDone: '✅ <b>Compaction done.</b>',
  workflow: (name: string, done: number, total: number) =>
    `${done >= total ? '✅' : '🤖'} <b>Workflow</b> <code>${name}</code> — ${done}/${total} agents`,
  workflowDone: (name: string, total: number) => `✅ <b>Workflow</b> <code>${name}</code> done (${total} agents)`,
  authHint:
    '\n\n🔑 The turn dies instantly — no reply coming. Try <code>/restart</code> first (often stale auth in the ' +
    "process's memory); if it recurs, the host needs <code>claude /login</code>.",
  sessionError: (err: string, hint: string) => `⛔️ <b>Session error</b>\n\n<code>${err}</code>${hint}`,
  tasksHeader: '📋 <b>Tasks</b>',
  todosHeader: '📝 <b>To Do</b>',
  bgHeader: '⚙️ <b>Background</b>',
  bgLine: (what: string, done: boolean) => `${done ? '✅' : '▶️'} ${what}`,
  skillLine: (skill: string, args: string) => `🧩 Skill: <b>${skill}</b>${args ? ` — <i>${args}</i>` : ''}`,

  // ── screen/last digest ──
  updateStopped: 'updates stopped',
  btnClose: '✖️ Close',
  btnCancel: '✖️ Cancel',
  btnNewSession: '🆕 New session',

  // ── callback toasts (short) ──
  toastPickerClosed: 'Picker closed',
  toastNoAccess: 'No access',
  toastChosen: 'Selected',
  toastSent: 'Sent',
  toastSendText: 'Send text',
  toastClosed: 'Closed',
  toastMenuStale: 'Menu is stale — run /skills again',
  toastNoLiveResume: 'No live session — /resume',
  toastNotInTmux: 'Session is not in tmux',
  toastAlreadyChosen: 'Already chosen or stale',
  toastNoRights: 'No rights',
  toastBindingGone: 'Binding vanished',
  toastSessionGoneResume: 'Session gone — run /resume again',
  toastSwitching: 'Switching…',
  toastRaising: 'Resuming…',
  toastLaunching: 'Starting…',
  toastRun: (name: string) => `▶ /${name}`,

  // ── skills menu / reload ──
  rescanning: '⏳ Rescanning skills…',
  skillsScanFail: '⚠️ Could not scan skills.',
  skillsCollapsed: (n: number, prev: number, failed: number, retrySec: number) =>
    `⚠️ Skills collapsed (${n} < ${prev}), ${failed} plugin(s) didn't answer — keeping the previous list, retry in ${retrySec}s.`,
  cmdsSummary: (
    total: number,
    ops: number,
    skills: number,
    dropped: number,
    capNote: string,
    failNote: string,
  ) => `📋 Commands: ${total} (ops ${ops} + skills ${skills}${dropped ? `, dropped ${dropped}` : ''}${capNote}${failNote}).`,
  cmdsCapNote: (cap: number) => `, descriptions ≤${cap}`,
  cmdsFailNote: (failed: number, retrySec: number) =>
    `; ⚠️ ${failed} plugin(s) didn't answer, retry in ${retrySec}s`,
  noProjectSkills: (dir: string) =>
    `📂 No project skills in <code>${dir}/.claude/skills</code>.\n\nGlobal ones — type them as commands, autocomplete on <code>/</code>.`,
  projectSkillsMenu: (count: number) => `📂 <b>Project skills</b> (${count}) — tap to run:`,
  skillLaunched: (name: string) => `▶️ <b>/${name}</b> — launched.`,

  // ── bindings / access ──
  noBinding: '⚠️ Nothing is bound here — <code>/bind</code> first.',
  noBindingBindFirst: '⚠️ Nothing is bound here — <code>/bind &lt;folder&gt;</code> first.',
  conversationGone: '🗑 The saved conversation is no longer on disk — starting a fresh one.',
  clearStartsFresh: '🧹 The session is unloaded — starting a fresh one instead of resuming just to clear it.',
  noBindingPickFolder: '👋 Nothing is bound here yet. Pick a folder to work in — or send <code>/bind &lt;path&gt;</code>.',
  bindUsage: (projects: string) => `Usage: <code>/bind &lt;folder&gt;</code>\n\nA name in ${projects} or an absolute path.`,
  bound: (key: string, path: string) => `🔗 <b>Bound</b>\n\n<code>${key}</code> → ${path}\n\nHow do we start?`,
  rebound: (key: string, from: string, to: string, sessionId?: string) =>
    `🔗 <b>Rebound</b>\n\n<code>${key}</code>\n${from} → ${to}${sessionId ? `\n\n💬 Session <code>${sessionId}</code> preserved.` : ''}\n\nHow do we start?`,
  bindFail: (err: string) => `⚠️ <b>Couldn't bind</b>: ${err}`,
  nothingBoundHere: 'Nothing is bound here.',
  nothingBoundBindFirst: 'Nothing is bound here. <code>/bind &lt;folder&gt;</code> first.',
  bindFirst: 'Bind first: <code>/bind &lt;folder&gt;</code>',
  allowNobody: '<i>nobody</i>',
  allowStatus: (current: string) =>
    `👥 <b>Access</b>: ${current}\n\nUsage: <code>/allow &lt;id …&gt;</code>\n<i>To remove — edit bindings.json.</i>`,
  allowUsage: 'Usage: <code>/allow &lt;id …&gt;</code>',
  allowSet: (ids: string) => `✅ <b>Access</b>: <code>${ids}</code>`,

  // ── unbind / delete ──
  unbound: (tidPart: string) => `🔓 <b>Unbound</b>${tidPart}`,
  unboundTopicPart: (tid: number) => ` — topic <code>#${tid}</code>`,
  unboundSessionPart: (sid: string) => `\n💬 Session <code>${sid}</code>`,
  tmuxClosed: (name: string) => `\n🪟 tmux <code>${name}</code> closed.`,
  cleanupHookOk: (branch: string) => `\n🗑 Cleanup hook (<code>${branch}</code>) ran.`,
  cleanupHookFail: (err: string) => `\n⚠️ Cleanup hook failed: ${err}`,
  worktreeRemoved: '\n🗑 Worktree removed (<code>git worktree remove</code>).',
  worktreeRemoveFail: (err: string) => `\n⚠️ Worktree removal failed: ${err}`,
  dirStillInUse: (tids: string) => `\n📌 Folder kept — still bound in ${tids}.`,
  topicDeletedCleanup: (note: string) => `🗑 <b>Topic deleted</b> — cleaned up after it.\n\n${note}`,
  deleteOnlyInTopic: '❌ <code>/delete</code> — only in a forum topic (can\'t delete General/a plain group this way).',
  deleting: '🗑 <b>Deleting the topic</b>…',
  deletingCleanup: (seconds: number) => `🧹 Removing the worktree and stand… ${seconds}s`,
  cleanupDone: (seconds: number) => `🧹 Cleaned up in ${seconds}s`,
  noBindingInTopic: (tid: number, title: string) =>
    `🔓 <i>No binding in topic <code>#${tid}</code>${title ? ` «${title}»` : ''}.</i>`,
  topicDeletedShort: (tid: number) => `🗑 Topic <code>#${tid}</code> deleted.`,
  topicDeleteFail: (err: string) =>
    `⚠️ Topic not deleted (does the bot have can_delete_messages?): ${err}\n` +
    'The topic is still open; its next message will offer setup again.',
  deleteKeptOnCleanupFail:
    '🛑 <b>Nothing was touched</b> — the cleanup failed, and tearing the topic down over a live worktree would kill the session and leave the stand running. Fix the cause and retry, or delete anyway — the worktree and its stand then stay on disk.',
  queuedDropped: (n: number) => `\n💤 ${n} held message(s) never reached the session — they are gone with the binding.`,
  teardownForced: '\n⚠️ Forced: the cleanup failed, so the worktree and its stand are still on disk — remove them by hand.',

  // ── stand up/down ──
  standUpProgress: '⏳ Bringing the stand up…',
  standDownProgress: '⏳ Tearing the stand down…',
  noStandConfig: (dir: string, cfgFile: string, kind: string) =>
    `📄 No <code>${cfgFile}</code> with a <code>stand.${kind}</code> command in ${dir}.\n\n` +
    `Example: <code>{ "stand": { "up": "…", "down": "…", "status": "…" } }</code>`,
  standUpOk: '🟢 <b>Stand is up</b>',
  standDownOk: '⚪️ <b>Stand is down</b>',
  standHookFail: (kind: string) => `⚠️ <b>Stand hook (${kind}) failed</b>`,

  // ── pin / unpin ──
  pinned: (idleOffNote: string) => `📌 <b>Pinned</b> — this session won't idle-unload.${idleOffNote}`,
  pinnedIdleOffNote: '\n<i>(auto-unload is off right now — TELEGRAM_IDLE_UNLOAD_MINUTES=0)</i>',
  unpinned: (whenNote: string) => `📌 <b>Unpinned</b> — the session idle-unloads again${whenNote}.`,
  unpinnedInNote: (min: number) => ` (in ${min} min)`,
  unpinnedWhenOnNote: ' <i>(once auto-unload is enabled)</i>',

  // ── /resume flow ──
  noSessionNamed: (want: string, dir: string) =>
    `⚠️ No session <code>${want}</code> in ${dir}.\n\n<code>/resume</code> with no argument lists them.`,
  prefixAmbiguous: (want: string, count: number) => `⚠️ Prefix <code>${want}</code> matches ${count} sessions — narrow it down.`,
  sessionOwnedByTopic: (id: string, topic: string) =>
    `⚠️ Session <code>${id}</code> is already bound to ${topic}. Resume it there instead of forking its history.`,
  couldntStopCurrentScreen: '⚠️ Couldn\'t stop the current session — check <code>/screen</code>.',
  sessionListFail: '⚠️ Session list didn\'t open (agent busy?). Try later, check /screen, or /stop then /resume.',
  switchSessionHdr: (total: string) => `⏪ <b>Switch session</b> <i>(${total}, no restart)</i>`,
  alreadyConnected: (pane: string) =>
    `⚙️ Session is already connected <i>(${pane})</i>.\n\nUse <code>/restart</code> or <code>/compact</code>.`,
  alreadyConnectedNoTmux: 'not in tmux',
  foreignClaude: (pids: string) =>
    `⚠️ <b>This conversation is already run by claude outside the hub</b> <i>(pid ${pids})</i> — ` +
    'the hub does not manage it.\n\nNot starting a second one: <code>/resume</code> would fork it. ' +
    'Close that session (or restart it with the dev channel) and retry.',
  whichSessionRaise: '⏪ <b>Which session to bring up?</b> (freshest on top)',
  switchedTo: (title: string) => `⏪ Switched: <b>${title}</b>`,
  staleListChanged: 'List changed — run /resume again',
  staleCursorMiss: 'Missed the cursor — run /resume again',
  closedShort: '✖️ Closed.',
  stoppingCurrentSession: '🛑 Stopping the current session…',
  couldntStopCurrentTmux: '⚠️ Couldn\'t stop the current session — check tmux by hand.',
  resumingId: (id: string) => `⏪ Resuming <code>${id}…</code>`,
  launchingNew: '🆕 Starting a new session…',

  // ── compact / clear / esc / enter / model / stop / restart ──
  noLiveSession: '⚠️ No live session. Try <code>/resume</code>.',
  revivingForCommand: (cmd: string) => `▶️ <b>Bringing the session up</b> for <code>/${cmd}</code>…`,
  nothingToInterrupt: '⚠️ Nothing to interrupt — no live session.',
  sessionAsksFirst: (cmd: string) => `⚠️ The session came up with a question — answer it with the buttons above and I'll run <code>/${cmd}</code> right after.`,
  pendingCmdDropped: (cmd: string) => `🚫 The question stayed unanswered — <code>/${cmd}</code> was dropped.`,
  forkNoConversation: '⚠️ Nothing to fork yet — this topic has no conversation.',
  forkNeedsTopic: '⚠️ A fork needs its own topic — run it in a forum group, not a DM.',
  forkCreating: (name: string) => `🌱 <b>Forking</b> into «${name}»…`,
  forkTopicFailed: (err: string) => `⚠️ Couldn't create the topic: <code>${err}</code>\n\nThe bot needs the «Manage topics» right.`,
  forkedFrom: (threadId: number, id: string) =>
    `🌱 <b>Fork of the conversation</b>\n\nSame history up to this point, its own life from here. Parent topic: <code>${threadId}</code>, conversation <code>${id}</code>.`,
  notInTmuxControl: '⚠️ Session is not in tmux — can\'t control it.',
  compactSent: '🗜 <code>/compact</code> sent.',
  historyCleared: '🧹 <b>History cleared.</b>',
  escSent: '⎋ <b>Esc</b> sent (+ input queue cleared).',
  enterSent: '⏎ <b>Enter</b> sent.',
  modelSent: '📋 <code>/model</code> sent — wait for the button menu.',
  stopNoProc: '⚠️ Stop unavailable — couldn\'t identify the claude process.',
  stopping: '🛑 <b>Stopping</b> the session… If a background-tasks question pops up — answer with buttons, otherwise I exit myself in ~10s.',
  procNotDead: '⚠️ Process didn\'t die — check tmux by hand.',
  sessionStopped: '🛑 <b>Session stopped.</b> What next?',
  stopFail: (err: string) => `⚠️ Stop failed: ${err}`,
  restartNoProc: '⚠️ Restart unavailable — couldn\'t identify the claude process.',
  restarting: '♻️ <b>Restarting</b> the session…',
  restartWaiting: (seconds: number) => `⏳ Waiting for it to come back… ${seconds}s`,
  restartReady: (seconds: number) => `✅ <b>Session restarted</b> in ${seconds}s`,
  restartNotReady: (seconds: number) => `⚠️ <b>No connection after ${seconds}s</b> — check <code>/last</code>`,
  restartFail: (err: string) => `⚠️ Restart failed: ${err}`,
  cmdFail: (cmd: string, err: string) => `⚠️ <b>${cmd} failed</b>: ${err}`,

  // ── status ──
  statusNotBound: (key: string) => `📊 <b>${key}</b>\n\n<i>Not bound.</i> Bind via <code>/bind &lt;folder&gt;</code> (admin).`,
  pidAlive: (pid: number) => `alive <i>(pid ${pid})</i>`,
  pidDead: (pid: number) => `<b>dead</b> <i>(pid ${pid})</i>`,
  pidUnknown: 'pid unknown',
  statusClaudeConnected: (pidState: string) => `🟢 claude: connected, ${pidState}`,
  statusClaudeDisconnected: '⚪️ claude: not connected',
  tmuxHas: 'present',
  tmuxNone: 'no session',
  statusTmux: (name: string, state: string) => `🪟 tmux <code>${name}</code>: ${state}`,
  statusResumeHint: '→ <code>/resume</code> to bring it up',
  statusCronHold: (when: string, count: number) =>
    `⏰ ${count} cron/loop in this session — kept awake, next run ${when}`,
  statusCronList: (schedule: string, once: boolean) => `   <code>${schedule}</code>${once ? ' <i>(one-shot)</i>' : ''}`,
  statusPinned: '📌 pinned — not idle-unloaded',
  statusIdleUnload: (min: number) => `💤 idle-unload in ${min} min (<code>/pin</code> to keep)`,
  statusStandUp: (url: string) => `🖥 stand: 🟢 up${url ? ` → ${url}` : ''}`,
  statusStandDown: '🖥 stand: ⚪️ down → <code>/stand_up</code>',
  statusAccess: (ids: string) => `👥 access: <code>${ids}</code>`,
  statusContextUsed: (pct: number) => `Context: ${pct}% used`,
  statusQuota: (label: string, pct: number, reset: string) => `${label}: ${pct}% left${reset ? ` (resets ${reset})` : ''}`,
  statusQuotaStale: '⚠️ Codex reports that limits may be stale.',
  statusQuotaUnavailable: 'ℹ️ Live Codex limits were not refreshed: the pane is busy or has a local draft.',

  // ── doctor ──
  doctorHeader: '🩺 <b>Telegram hub doctor</b>',
  doctorSummary: (ok: number, warn: number, fail: number) =>
    `<b>Result:</b> ${ok} passed · ${warn} warnings · ${fail} failures`,
  doctorHub: 'Hub',
  doctorTelegram: 'Telegram API',
  doctorPermissions: 'Bot permissions',
  doctorRegistry: 'Binding registry',
  doctorFolder: 'Project folder',
  doctorRouting: 'MCP routing',
  doctorProcess: 'Agent process',
  doctorTmux: 'tmux',
  doctorPane: 'Terminal pane',
  doctorConversation: 'Conversation',
  doctorVoice: 'Voice',
  doctorNoBinding: 'this chat/topic is not bound; session checks were skipped',
  doctorApiOk: (username: string) => `reachable as @${username}`,
  doctorApiFail: (error: string) => `unreachable: ${error}`,
  doctorAdminOk: 'administrator with topic management permission',
  doctorAdminLimited: (status: string) => `${status}; topic management may be unavailable`,
  doctorPrivateChat: 'private chat; group permissions are not required',
  doctorBindingOk: (agent: string) => `valid binding, agent ${agent}`,
  doctorFolderOk: (path: string) => `${path} exists and resolves`,
  doctorFolderFail: (error: string) => `unavailable: ${error}`,
  doctorRoutingOk: 'exactly one live channel connection',
  doctorRoutingNone: 'no live channel connection; /resume or any message should revive it',
  doctorRoutingMany: (count: number) => `${count} live connections claim this binding`,
  doctorProcessOk: (pid: number) => `pid ${pid} is alive`,
  doctorProcessFail: (pid: number) => `pid ${pid} is dead`,
  doctorProcessUnknown: 'live connection did not report a pid',
  doctorTmuxOk: (name: string) => `session ${name} exists`,
  doctorTmuxMissing: (name: string) => `session ${name} is missing`,
  doctorPaneOk: (pane: string, command: string) => `${pane} is readable; foreground ${command}`,
  doctorPaneFail: (error: string) => `not readable: ${error}`,
  doctorConversationOk: (id: string) => `resume id ${id}`,
  doctorConversationMissing: 'resume id is not known yet',
  doctorVoiceOk: 'STT and TTS credentials are configured',
  doctorVoiceOff: 'OPENAI_API_KEY is absent; voice input/output is disabled',

  // ── new-topic mode prompt ──
  ownDirLabel: '✏️ Own folder',
  sendFolderPromptBind: (projects: string) => `📁 Send the folder for this topic — like <code>/bind</code>: a name in ${projects} or an absolute path.`,
  sendFolderPromptShort: (projects: string) => `📁 Send a folder — like <code>/bind</code>: a name in ${projects} or an absolute path.`,
  branchNote: (branch: string) => `, branch <code>${branch}</code>`,
  harnessToggle: (name: string) => `🔄 ${name}`,
  modeWorktreeFrom: (base: string) => `🌿 worktree from ${base}`,
  modeWorktreePlainFrom: (base: string) => `🌿 worktree from ${base} · no project hook`,
  branchRenamed: (wanted: string, used: string) =>
    `🔀 Branch <code>${wanted}</code> already exists (an older topic of the same name) — ` +
    `working in <code>${used}</code>, cut fresh from the base.`,
  preparingSession: (mode: string, branchNote: string) => `⏳ Preparing the session (<code>${mode}</code>${branchNote})…`,
  hookPreparing: (seconds: number) => `🌱 The project hook is preparing the worktree… ${seconds}s`,
  hookPrepared: (seconds: number) => `🌱 Worktree ready in ${seconds}s`,
  notAFolder: (err: string) => `⚠️ <b>Doesn't look like a folder</b>: ${err}\n\nSend it again.`,
  modeIntroFolder: '📁 <b>Default folder</b> — work right in the base.',
  modeIntroWorktree:
    '🌿 <b>Worktree</b> — its own git branch/folder off the base (a plain <code>git worktree add</code>, ' +
    "or the group config's external script if set — e.g. also brings up a DB).",
  modeBaseSet: (dir: string) => `Base: ${dir}`,
  modeBaseUnset: 'Base not set — I\'ll ask for a folder after you pick.',
  ownDirSuffix: (label: string) => `${label} — give a path for this topic by hand.`,
  newTopicPrompt: 'Looks like a new topic — how to bring a session up?',
  howRaiseTopic: 'How to bring up a session for this topic?',
  modeChosen: (label: string) => `${label} — chosen.`,

  // ── mode labels (trusted-groups) ──
  modeLabelFolder: '📁 Default folder',
  modeLabelWorktree: '🌿 Worktree (own git branch)',
  modeLabelWorktreePlain: '🌿 Worktree · no project hook',

  // ── picker keyboard (picker-drive) ──
  pkCustom: '✍️ Custom option',
  pkSubmit: '✅ Submit',
  pkTitleDefault: 'Choose:',

  // ── limits (limits.ts) ──
  durZero: '0m',
  durDaysHours: (d: number, h: number) => `${d}d${h}h`,
  durHoursMins: (h: number, mm: string) => `${h}h${mm}m`,
  durMins: (m: number) => `${m}m`,
  limContext: (pct: string) => `Context: ${pct}`,
  limReset: (until: string) => `, reset ${until}`,
  limFiveHour: (pct: string, reset: string) => `Session 5h: ${pct}${reset}`,
  limSevenDay: (pct: string, reset: string) => `Session 7d: ${pct}${reset}`,
  limStale: (ago: string) => `(data ${ago} ago)`,

  // ── /lang ──
  langUsage: (cur: string) => `Usage: <code>/lang en</code> | <code>/lang ru</code>\n\nCurrent: <b>${cur}</b>.`,
  langSwitched: (lang: string) => `🌐 Interface language: <b>${lang}</b>. Refreshing commands…`,
}
