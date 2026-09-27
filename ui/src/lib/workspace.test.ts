import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Store } from './prefs.ts'
import {
  RECENT_MAX,
  isSessionDirName,
  loadRecentFolders,
  projectOf,
  rememberFolder,
  sessionLabel,
} from './workspace.ts'

const memory = (): Store & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    keys: () => [...data.keys()],
  }
}

test('a session folder is a timestamp, with or without a clash suffix', () => {
  assert.equal(isSessionDirName('20260926-171201'), true)
  assert.equal(isSessionDirName('20260926-171201-2'), true)
  assert.equal(isSessionDirName('2026-09-26'), false)
  assert.equal(isSessionDirName('src'), false)
})

test('the project of a worktree session is the folder it was started from', () => {
  assert.equal(projectOf('/Users/me/src/zerotauri/20260926-171201'), '/Users/me/src/zerotauri')
  assert.equal(projectOf('/Users/me/src/zerotauri/20260926-171201/ui/src'), '/Users/me/src/zerotauri')
  assert.equal(projectOf('/Users/me/src/zerotauri'), '/Users/me/src/zerotauri')
  assert.equal(projectOf('C:\\src\\repo\\20260926-171201'), 'C:\\src\\repo')
})

test('the rail names a worktree session by its repo and timestamp', () => {
  assert.equal(sessionLabel('/Users/me/src/zerotauri/20260926-171201'), 'zerotauri/20260926-171201')
  assert.equal(sessionLabel('/Users/me/src/zerotauri/20260926-171201-2/ui'), 'zerotauri/20260926-171201-2')
  assert.equal(sessionLabel('/Users/me/src/zerotauri'), 'zerotauri')
  assert.equal(sessionLabel(null), '')
})

test('recent folders are newest first, unique, and capped', () => {
  const store = memory()
  assert.deepEqual(loadRecentFolders(store), [])
  rememberFolder(store, '/a')
  rememberFolder(store, '/b')
  assert.deepEqual(rememberFolder(store, '/a'), ['/a', '/b'])
  for (let i = 0; i < RECENT_MAX + 3; i += 1) rememberFolder(store, `/many/${i}`)
  const list = loadRecentFolders(store)
  assert.equal(list.length, RECENT_MAX)
  assert.equal(list[0], `/many/${RECENT_MAX + 2}`)
  store.setItem('zerotauri:prefs:v1:recent-folders', '{bad')
  assert.deepEqual(loadRecentFolders(store), [])
  assert.deepEqual(loadRecentFolders(null), [])
})
