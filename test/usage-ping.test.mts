/**
 * Covers the ping each run sends to usage.bvandercar.dev: what it reveals
 * about the repo, and that it never sends outside Actions or once opted out.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, mock, test } from 'node:test'

import { buildRunPing, sendUsagePing } from '../src/usage-ping.ts'

const ACTION_DIR = '/home/runner/work/_actions/bvandrc/detect-deploy/v1/dist'

/** Writes an event payload whose repository has the given fields. */
const createEventFile = (repository: Record<string, unknown>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ping-test-'))
  const file = path.join(dir, 'event.json')
  fs.writeFileSync(file, JSON.stringify({ repository }))
  return file
}

const buildEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'Octo-Org/Octo-Repo',
  GITHUB_REPOSITORY_OWNER: 'Octo-Org',
  GITHUB_RUN_ID: '123456789',
  GITHUB_RUN_ATTEMPT: '2',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SERVER_URL: 'https://github.com',
  RUNNER_OS: 'Linux',
  RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_EVENT_PATH: createEventFile({ visibility: 'public' }),
  ...overrides,
})

const OCTO_REPO_HASH = createHash('sha256')
  .update('action-usage:octo-org/octo-repo')
  .digest('hex')

const build = (env: NodeJS.ProcessEnv, actionDir = ACTION_DIR) =>
  buildRunPing({ action: 'bvandrc/detect-deploy', actionDir, env })

describe('buildRunPing', () => {
  test('names a public repo, with its run', () => {
    assert.deepEqual(build(buildEnv()), {
      action: 'bvandrc/detect-deploy',
      ref: 'v1',
      ownRepo: false,
      event: 'push',
      runnerOs: 'Linux',
      runnerEnvironment: 'github-hosted',
      ghes: false,
      visibility: 'public',
      repo: 'Octo-Org/Octo-Repo',
      runId: 123_456_789,
      runAttempt: 2,
    })
  })

  test("sends any other repo's name only as a hash", () => {
    const EVENTS = {
      private: { visibility: 'private' },
      internal: { visibility: 'internal' },
      // Older GitHub Enterprise Server payloads have only the boolean.
      'private boolean': { private: true },
      // Nothing to go on, so treated as private.
      unknown: {},
    }
    for (const [label, repository] of Object.entries(EVENTS)) {
      const ping = build(
        buildEnv({ GITHUB_EVENT_PATH: createEventFile(repository) })
      )
      assert.equal(ping.visibility === 'public', false, label)
      assert.equal('repo' in ping || 'runId' in ping, false, label)
      assert.equal('repoHash' in ping && ping.repoHash, OCTO_REPO_HASH, label)
    }
  })

  test('sends a run with no event payload as unknown, by hash', () => {
    const ping = build(buildEnv({ GITHUB_EVENT_PATH: '/nonexistent.json' }))
    assert.equal(ping.visibility, 'unknown')
    assert.equal('repoHash' in ping && ping.repoHash, OCTO_REPO_HASH)
  })

  test('reads the ref from the runner, else its checkout path', () => {
    const CASES = [
      [{ GITHUB_ACTION_REF: 'v1.2.0' }, ACTION_DIR, 'v1.2.0'],
      [{}, 'D:\\a\\_actions\\bvandrc\\detect-deploy\\abc123\\dist', 'abc123'],
      // `uses: ./` runs a checkout of the action's own repo.
      [{}, '/home/runner/work/detect-deploy/detect-deploy/dist', 'local'],
    ] as const
    for (const [env, actionDir, ref] of CASES) {
      assert.equal(build(buildEnv(env), actionDir).ref, ref, actionDir)
    }
  })

  test("marks a run in the action owner's own repo, in any casing", () => {
    const ping = build(buildEnv({ GITHUB_REPOSITORY_OWNER: 'BVANDRC' }))
    assert.equal(ping.ownRepo, true)
  })

  test('marks a run on a server other than github.com', () => {
    const ping = build(
      buildEnv({ GITHUB_SERVER_URL: 'https://github.example.com' })
    )
    assert.equal(ping.ghes, true)
  })
})

describe('sendUsagePing', () => {
  afterEach(() => mock.restoreAll())

  const mockFetch = (impl: () => Promise<Response>) =>
    mock.method(globalThis, 'fetch', impl)

  const send = (env: NodeJS.ProcessEnv, enabled = true) =>
    sendUsagePing({
      action: 'bvandrc/detect-deploy',
      actionDir: ACTION_DIR,
      env,
      enabled,
    })

  test('posts the run to the collector', async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 202 }))
    const ENV = buildEnv()
    await send(ENV)
    const [url, init] = fetchMock.mock.calls[0]?.arguments ?? []
    assert.equal(url, 'https://usage.bvandercar.dev/v1/runs')
    assert.deepEqual(JSON.parse(String(init?.body)), build(ENV))
  })

  test('sends nothing when opted out, or outside Actions', async () => {
    const fetchMock = mockFetch(async () => new Response(null))
    const CASES = [
      ['telemetry: false', buildEnv(), false],
      ['DO_NOT_TRACK=1', buildEnv({ DO_NOT_TRACK: '1' }), true],
      ['outside Actions', buildEnv({ GITHUB_ACTIONS: undefined }), true],
    ] as const
    for (const [label, env, enabled] of CASES) {
      await send(env, enabled)
      assert.equal(fetchMock.mock.callCount(), 0, label)
    }
  })

  test('still sends when DO_NOT_TRACK is set to off', async () => {
    const fetchMock = mockFetch(async () => new Response(null))
    await send(buildEnv({ DO_NOT_TRACK: '0' }))
    assert.equal(fetchMock.mock.callCount(), 1)
  })

  test('resolves when the collector is unreachable', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')))
    await send(buildEnv())
  })
})
