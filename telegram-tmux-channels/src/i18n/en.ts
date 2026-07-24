// English UI strings — the canonical table (its shape defines `Strings`; ru.ts must match).
// Values are plain strings or template fns. Dynamic args are pre-escaped by call sites.
export const en = {
  // ── bot command descriptions (setMyCommands; switch globally with /lang) ──
  cmd_status: 'Session status (folder/tmux/claude/limits)',
  cmd_resume: 'Bring up a session (pick which)',
  cmd_screen: 'Show the session screen as-is',
  cmd_last: 'Latest screen text (live, no image)',
  cmd_new: 'Start a fresh session',
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
  autoForwardLabelHtml: '↩️ <i>auto-forward</i>',
  autoForwardLabelPlain: '↩️ auto-forward',
  raisingSession: '▶️ <b>Bringing the session up…</b>',
  sessionNotConnectedInTime: '⚠️ Session did not connect in time — message not delivered, try again.',
  sessionNotUpInTime: '⚠️ Session did not come up in time — queued messages not delivered, resend.',
  notInTmuxSlash: '⚠️ Session is not in tmux — can\'t type the slash command.',
  tmuxCreated: (name: string, path: string) => `🪟 tmux <code>${name}</code> created in ${path}.`,
  tmuxExists: (name: string) => `🪟 tmux <code>${name}</code> already exists — typing the launch into its active pane.`,
  modeResume: '🚀 <b>Resuming</b>',
  modeRestart: '🚀 <b>Restarting fresh</b>',
  modeNew: '🆕 <b>Starting a session</b>',
  spawnFailed: (mode: string, err: string) => `⚠️ <b>${mode} failed</b>: ${err}`,
  sessionSpawnFail: (err: string) => `⚠️ <b>Couldn't bring the session up</b>: ${err}`,

  // ── pickers ──
  pickerDefaultTitle: 'Question',
  pickerAnsweredInTerminal: '<i>answered in the terminal</i>',
  pickerClosedRestart: '❓ <i>Picker closed (restart)</i>',
  pickerClosedNoRevive: '❓ <i>Picker closed (session did not recover)</i>',
  sendAnswerMsg: '✍️ <b>Send the answer</b> as a message.',

  // ── notifiers (agents / compaction / workflow / tasks / skills / errors) ──
  agentsHeader: '🤖 <b>Agents</b>',
  compaction: (bar: string, pct: string, elapsed: string) =>
    `🗜 <b>Compaction</b> ${bar} ${pct}%${elapsed ? ` <i>(${elapsed})</i>` : ''}`,
  compactionDone: '✅ <b>Compaction done.</b>',
  workflow: (name: string, done: number, total: number) =>
    `${done >= total ? '✅' : '🤖'} <b>Workflow</b> <code>${name}</code> — ${done}/${total} agents`,
  workflowDone: (name: string, total: number) => `✅ <b>Workflow</b> <code>${name}</code> done (${total} agents)`,
  authHint:
    '\n\n🔑 The turn dies instantly — no reply coming. Try <code>/restart</code> first (often stale auth in the ' +
    "process's memory); if it recurs, the host needs <code>claude /login</code>.",
  sessionError: (err: string, hint: string) => `⛔️ <b>Session error</b>\n\n<code>${err}</code>${hint}`,
  tasksHeader: '📋 <b>Tasks</b>',
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
  bindUsage: (projects: string) => `Usage: <code>/bind &lt;folder&gt;</code>\n\nA name in ${projects} or an absolute path.`,
  bound: (key: string, path: string) => `🔗 <b>Bound</b>\n\n<code>${key}</code> → ${path}\n\nHow do we start?`,
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
  topicDeletedCleanup: (note: string) => `🗑 <b>Topic deleted</b> — cleaned up after it.\n\n${note}`,
  deleteOnlyInTopic: '❌ <code>/delete</code> — only in a forum topic (can\'t delete General/a plain group this way).',
  noBindingInTopic: (tid: number, title: string) =>
    `🔓 <i>No binding in topic <code>#${tid}</code>${title ? ` «${title}»` : ''}.</i>`,
  topicDeletedShort: (tid: number) => `🗑 Topic <code>#${tid}</code> deleted.`,
  topicDeleteFail: (err: string) => `⚠️ Topic not deleted (does the bot have can_delete_messages?): ${err}`,

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
  restartSent: '♻️ Restart sent.',
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
  statusPinned: '📌 pinned — not idle-unloaded',
  statusIdleUnload: (min: number) => `💤 idle-unload in ${min} min (<code>/pin</code> to keep)`,
  statusStandUp: (url: string) => `🖥 stand: 🟢 up${url ? ` → ${url}` : ''}`,
  statusStandDown: '🖥 stand: ⚪️ down → <code>/stand_up</code>',
  statusAccess: (ids: string) => `👥 access: <code>${ids}</code>`,

  // ── new-topic mode prompt ──
  ownDirLabel: '✏️ Own folder',
  sendFolderPromptBind: '📁 Send the folder for this topic — like <code>/bind</code>: a name in ~/projects or an absolute path.',
  sendFolderPromptShort: '📁 Send a folder — like <code>/bind</code>: a name in ~/projects or an absolute path.',
  branchNote: (branch: string) => `, branch <code>${branch}</code>`,
  preparingSession: (mode: string, branchNote: string) => `⏳ Preparing the session (<code>${mode}</code>${branchNote})…`,
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
