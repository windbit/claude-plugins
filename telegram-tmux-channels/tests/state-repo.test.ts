import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HubStateRepository } from '../src/state-repo'
import type { Picker } from '../src/picker'

const picker: Picker = { title: 'Pick one', options: [{ index: 0, label: 'A' }, { index: 1, label: 'B' }], hash: 'abc123', mode: 'single' }
const tmp = () => mkdtempSync(join(tmpdir(), 'hubstate-'))

describe('HubStateRepository Stage 3 persistence', () => {
  test('permissions + pickers survive a flush→reload round-trip', () => {
    const dir = tmp()
    const a = new HubStateRepository(() => {}, dir)
    a.setPermission('req-1', { tool_name: 'Bash', description: 'run', input_preview: 'ls', key: 'g:1:2', at: 1000 })
    a.setPicker('%3', { chatId: '42', threadId: 7, msgId: 555, hash: 'abc123', token: 'abc123', picker, key: 'g:1:2', at: 2000 })
    a.flush()

    // a second repo pointed at the same dir rehydrates from disk
    const b = new HubStateRepository(() => {}, dir)
    expect(Object.fromEntries(b.permissionEntries())).toEqual({
      'req-1': { tool_name: 'Bash', description: 'run', input_preview: 'ls', key: 'g:1:2', at: 1000 },
    })
    const pickers = Object.fromEntries(b.pickerEntries())
    expect(pickers['%3']?.msgId).toBe(555)
    expect(pickers['%3']?.picker.options.length).toBe(2)
    expect(pickers['%3']?.key).toBe('g:1:2')

    // deletion persists too
    b.delPermission('req-1')
    b.delPicker('%3')
    b.flush()
    const c = new HubStateRepository(() => {}, dir)
    expect(c.permissionEntries()).toEqual([])
    expect(c.pickerEntries()).toEqual([])
  })

  test('an old state file missing the new keys loads without throwing', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'hub-state.json'), JSON.stringify({ version: 1, pendingAnswer: { k: { dir: '/x', at: 5 } }, lastFallback: {} }))
    const r = new HubStateRepository(() => {}, dir)
    expect(r.pendingEntries()).toEqual([['k', { dir: '/x', at: 5 }]]) // old data still there
    expect(r.permissionEntries()).toEqual([]) // new buckets default to empty
    expect(r.pickerEntries()).toEqual([])
  })
})
