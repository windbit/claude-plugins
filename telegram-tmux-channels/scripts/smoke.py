#!/usr/bin/env python3
"""Смоук через настоящий путь: Telegram → хаб → tmux-сессия агента → Telegram.

Зачем: юнит-тесты зелены и во время аварий — они про чистые функции, а ломается на швах
(гейты доверия, tmux, доставка). Проверять «рядом» бесполезно: 2026-08-17 так прошли три
поломки Codex подряд, каждую нашёл пользователь.

Сценарий на агента: создать топик → дождаться пикера → выбрать харнесс и папку → написать
сообщение → убедиться, что пришёл РОВНО ОДИН ответ, без плашки досыла и без вопроса-пикера.

    python3 scripts/smoke.py --chat -1004355407865 --agent codex
    python3 scripts/smoke.py --chat -1004355407865 --agent claude --agent codex

Драйвит аккаунт-водитель через наш MCP-сервер Telegram (тот же, которым пользуется агент).
Адрес и токен берём из ~/.claude.json и НИКОГДА не печатаем.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

MCP_NAME = 'telegram-mcp'
# Плашки хаба, а не ответы агента: старт сессии, окно tmux, статусы, компакция.
SERVICE = ('⏳', '🪟', '🆕', '🚀', '💀', '📁', '▶️', '🗜', '🤖', '📋', '📝', '⚙️', '🔀', '🧩', '⚠️', '✅')
ANSWER = 'пинг'
PROMPT = f'ответь ровно одним словом: {ANSWER}'


def mcp_config(path=os.path.expanduser('~/.claude.json')):
    def walk(node):
        if isinstance(node, dict):
            if MCP_NAME in node and isinstance(node[MCP_NAME], dict):
                return node[MCP_NAME]
            for v in node.values():
                found = walk(v)
                if found:
                    return found
        elif isinstance(node, list):
            for v in node:
                found = walk(v)
                if found:
                    return found
        return None
    cfg = walk(json.load(open(path)))
    if not cfg:
        sys.exit(f'{MCP_NAME} не найден в {path}')
    return cfg['url'], cfg.get('headers', {})


class Mcp:
    """Минимальный клиент streamable-HTTP MCP: ответы приходят как SSE, сессия — в заголовке."""

    def __init__(self, url, headers):
        self.url, self.headers, self.session, self.n = url, headers, None, 0

    def _post(self, payload):
        head = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            **self.headers,
        }
        if self.session:
            head['mcp-session-id'] = self.session
        req = urllib.request.Request(self.url, json.dumps(payload).encode(), head)
        with urllib.request.urlopen(req, timeout=120) as resp:
            self.session = self.session or resp.headers.get('mcp-session-id')
            body = resp.read().decode()
        for line in body.splitlines():
            if line.startswith('data: '):
                return json.loads(line[6:])
        return {}

    def start(self):
        self._post({'jsonrpc': '2.0', 'id': 0, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-06-18', 'capabilities': {},
            'clientInfo': {'name': 'ttc-smoke', 'version': '1'}}})
        self._post({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})

    def call(self, tool, **args):
        self.n += 1
        out = self._post({'jsonrpc': '2.0', 'id': self.n, 'method': 'tools/call',
                          'params': {'name': tool, 'arguments': args}})
        if 'error' in out:
            raise RuntimeError(f'{tool}: {out["error"]}')
        text = ''.join(c.get('text', '') for c in out.get('result', {}).get('content', []))
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text


def messages(mcp, chat, limit=20):
    raw = mcp.call('list_messages', chat_id=chat, limit=limit)
    if isinstance(raw, dict) and 'result' in raw:
        raw = json.loads(raw['result']) if isinstance(raw['result'], str) else raw['result']
    return raw.get('results', []) if isinstance(raw, dict) else []


def wait_for(fn, timeout, step=3, what='условия'):
    deadline = time.time() + timeout
    while time.time() < deadline:
        got = fn()
        if got:
            return got
        time.sleep(step)
    raise AssertionError(f'не дождался {what} за {timeout}с')


def buttons(mcp, chat, msg_id=None):
    raw = mcp.call('list_inline_buttons', chat_id=chat, **({'message_id': msg_id} if msg_id else {}))
    if isinstance(raw, dict) and 'result' in raw:
        raw = json.loads(raw['result']) if isinstance(raw['result'], str) else raw['result']
    return raw if isinstance(raw, dict) else {}


def pick_mode(opts, case):
    """Индекс кнопки режима. worktree в пикере подписан по базе («🌿 worktree от dev»);
    со стендом резать или без — решает переключатель хука, а не отдельная кнопка."""
    if case.startswith('worktree'):
        i = next((i for i, t in enumerate(opts) if 'worktree' in t.lower()), None)
        if i is None:
            raise AssertionError(f'в пикере нет режима {case}: {opts}')
        return i
    return next(i for i, t in enumerate(opts) if 'Default folder' in t)


def hook_is_on(label):
    return not (label.lower().rstrip().endswith('off') or 'выкл' in label.lower())


def exchange(mcp, chat, tid, agent, reply_timeout, prompt=PROMPT):
    """Написать в топик и дождаться РОВНО ОДНОГО чистого ответа. Возвращает (секунды, проблемы)."""
    mcp.call('reply_to_message', chat_id=chat, message_id=tid, text=prompt)
    start = time.time()
    prompt_id = wait_for(
        lambda: next((m['id'] for m in messages(mcp, chat, 15)
                      if m.get('text') == prompt and 'bot' not in m.get('sender', '').lower()), None),
        30, step=2, what='своего промпта в ленте')

    def answers():
        out = []
        for m in messages(mcp, chat, 25):
            if 'bot' not in m.get('sender', '').lower():
                continue
            if m.get('id', 0) <= prompt_id:
                continue
            if str(m.get('reply_to')) not in (str(prompt_id), str(tid)):
                continue
            if m.get('text', '').startswith(SERVICE):
                continue
            out.append(m)
        return out or None

    got = wait_for(answers, reply_timeout, what=f'ответа от {agent}')
    problems = []
    if len(got) > 1:
        problems.append(f'ответов {len(got)}, а должен быть один: {[m["id"] for m in got]}')
    for m in got:
        if 'auto-forward' in m['text']:
            problems.append(f'ответ пришёл досылом (id {m["id"]})')
        if m['text'].startswith('❓'):
            problems.append(f'вместо ответа вопрос-пикер (id {m["id"]})')
    return int(time.time() - start), problems


def run(mcp, chat, agent, reply_timeout, case='folder'):
    topic = mcp.call('create_forum_topic', chat_id=chat, title=f'smoke {agent} {int(time.time())}')
    tid = (topic.get('results') or [{}])[0].get('topic_id') if isinstance(topic, dict) else None
    if not tid:
        tid = json.loads(topic['result'])['results'][0]['topic_id'] if isinstance(topic, dict) else None
    print(f'  топик {tid} создан')

    kb = wait_for(lambda: buttons(mcp, chat) or None, 60, what='пикера режима')
    pick_id, opts = kb['message_id'], [b['text'] for b in kb['results']]
    print(f'  пикер: {opts}')

    # харнесс переключаем, пока в подписи не появится нужный агент (кнопка одна, меняется на месте)
    want = 'Codex' if agent == 'codex' else 'Claude'
    for _ in range(3):
        cur = [t for t in opts if t.startswith('🔄')]
        if not cur or want.lower() in cur[0].lower():
            break
        mcp.call('press_inline_button', chat_id=chat, message_id=pick_id, button_index=0)
        opts = [b['text'] for b in buttons(mcp, chat, pick_id)['results']]
    # стенд — тем же переключателем, что и харнесс: подпись показывает текущее положение
    for _ in range(3):
        cur = next((t for t in opts if t.startswith('🪝')), None)
        if not cur or hook_is_on(cur) == (case != 'worktree-plain'):
            break
        mcp.call('press_inline_button', chat_id=chat, message_id=pick_id, button_index=opts.index(cur))
        opts = [b['text'] for b in buttons(mcp, chat, pick_id)['results']]
    if case == 'worktree-plain' and not any(t.startswith('🪝') for t in opts):
        raise AssertionError(f'в пикере нет переключателя стенда: {opts}')
    mode_idx = pick_mode(opts, case)
    mcp.call('press_inline_button', chat_id=chat, message_id=pick_id, button_index=mode_idx)
    print(f'  выбран {want} + {opts[mode_idx]}')

    took, problems = exchange(mcp, chat, tid, agent, reply_timeout)

    # Мёртвая сессия: гасим её штатным `/stop` и пишем снова — хаб обязан поднять и ответить.
    # Это самый частый реальный сценарий после простоя, и раньше он ломался молча.
    if case == 'revive' and not problems:
        mcp.call('reply_to_message', chat_id=chat, message_id=tid, text='/stop')
        time.sleep(20)
        took2, problems = exchange(mcp, chat, tid, agent, reply_timeout, 'после стопа ответь одним словом: жив')
        took += took2
        print(f'  сессия погашена и поднята заново')

    return tid, took, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--chat', required=True)
    ap.add_argument('--agent', action='append', choices=['claude', 'codex'], required=True)
    ap.add_argument('--timeout', type=int, default=180, help='сколько ждать ответа, с')
    ap.add_argument('--case', action='append', choices=['folder', 'worktree', 'worktree-plain', 'revive'],
                    help='клетки матрицы; по умолчанию folder')
    args = ap.parse_args()

    url, headers = mcp_config()
    mcp = Mcp(url, headers)
    mcp.start()

    failed = False
    for agent in args.agent:
      for case in (args.case or ['folder']):
        print(f'== {agent} / {case}')
        try:
            tid, took, problems = run(mcp, args.chat, agent, args.timeout, case)
        except Exception as e:  # noqa: BLE001 — смоук: любая осечка это провал прогона
            print(f'  ПРОВАЛ: {e}')
            failed = True
            continue
        if problems:
            failed = True
            print(f'  ПРОВАЛ (топик {tid}):')
            for p in problems:
                print(f'    — {p}')
        else:
            print(f'  ок: один чистый ответ за {took}с (топик {tid})')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
