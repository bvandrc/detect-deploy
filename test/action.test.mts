/**
 * Runs the built bundle the way a runner does -- as a subprocess fed INPUT_*
 * environment variables -- and asserts on its annotations and step outputs.
 * Testing dist/ rather than src/ means these cover the artifact that actually
 * ships.
 *
 *   npm run build && npm test
 *
 * The Actions cache is unreachable outside a workflow, so the action skips it
 * (isFeatureAvailable) and reads the recorded hash straight off disk. Seeding
 * that file is what lets these tests cover the cache-hit paths.
 */

import assert from 'node:assert/strict'
import { type ExecFileException, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ACTION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'index.js',
)

// Loopback rather than localhost: it can't resolve to IPv6 on some machines
// while the server listens on IPv4, and it keeps the tests off the network.
const HOST = '127.0.0.1'

const sha256 = (body: string): string =>
  createHash('sha256').update(Buffer.from(body)).digest('hex')

const openServers: { close: () => Promise<void> }[] = []

/**
 * A server whose body can change after a set number of requests, so a deploy
 * landing mid-poll is deterministic instead of timing-dependent.
 */
const startTestServer = async ({
  body,
  changeAfter = null,
  nextBody = null,
  status = 200,
}: {
  body: string
  /** Serve `nextBody` once this many requests have been answered. */
  changeAfter?: number | null
  nextBody?: string | null
  status?: number
}): Promise<{
  url: string
  redirectUrl: string
  readonly requests: number
  close: () => Promise<void>
}> => {
  let requests = 0
  let current = body
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(301, { Location: '/' })
      res.end()
      return
    }
    requests += 1
    if (changeAfter !== null && requests > changeAfter && nextBody !== null)
      current = nextBody
    res.writeHead(status, { 'Content-Type': 'text/html' })
    res.end(current)
  })
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://${HOST}:${port}`
  const testServer = {
    url: `${origin}/`,
    redirectUrl: `${origin}/redirect`,
    get requests() {
      return requests
    },
    close: () =>
      new Promise<void>((resolve) => void server.close(() => resolve())),
  }
  openServers.push(testServer)
  return testServer
}

// Cleanup is uniform, so it belongs in a hook; construction is not -- every
// test needs a differently configured server -- so it stays in the test body.
// A hook also closes the server when an assertion throws, which a trailing
// close() in the test would not.
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((s) => s.close()))
})

/** Parses the `key<<delim\nvalue\ndelim` format core.setOutput writes. */
const parseOutputs = (text: string): Record<string, string> => {
  const outputs: Record<string, string> = {}
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^([^<]+)<<(.+)$/.exec(lines[i] ?? '')
    if (!match) continue
    const key = match[1] as string
    const delimiter = match[2] as string
    const value: string[] = []
    while (++i < lines.length && lines[i] !== delimiter)
      value.push(lines[i] as string)
    outputs[key] = value.join('\n')
  }
  return outputs
}

const runAction = async ({
  url,
  maxAttempts = 3,
  interval = 0,
  assumeDeployed = true,
  recordedHash = null,
}: {
  /** Omitted entirely when undefined, to exercise the missing-input path. */
  url?: string | undefined
  maxAttempts?: number | string
  interval?: number | string
  assumeDeployed?: boolean | string
  recordedHash?: string | null
} = {}): Promise<{
  code: number
  stdout: string
  stderr: string
  outputs: Record<string, string>
  /** The hash left on disk for the next run, or null if none was written. */
  recorded: string | null
  annotations: string[]
}> => {
  const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-test-'))
  const outputFile = path.join(runnerTemp, 'github-output')
  fs.writeFileSync(outputFile, '')

  const stateDir = path.join(runnerTemp, 'detect-deploy')
  const stateFile = path.join(stateDir, 'hash')
  if (recordedHash !== null) {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(stateFile, `${recordedHash}\n`)
  }

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    RUNNER_TEMP: runnerTemp,
    GITHUB_OUTPUT: outputFile,
    GITHUB_RUN_ID: '1',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_JOB: 'test',
    'INPUT_MAX-ATTEMPTS': String(maxAttempts),
    'INPUT_INTERVAL-SECONDS': String(interval),
    'INPUT_ASSUME-DEPLOYED-ON-FIRST-RUN': String(assumeDeployed),
  }
  if (url !== undefined) env.INPUT_URL = url

  const result = await new Promise<{
    code: number
    stdout: string
    stderr: string
  }>((resolve) => {
    execFile(
      process.execPath,
      [ACTION],
      { env },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr })
      },
    )
  })

  return {
    ...result,
    outputs: parseOutputs(fs.readFileSync(outputFile, 'utf8')),
    recorded: fs.existsSync(stateFile)
      ? fs.readFileSync(stateFile, 'utf8').trim()
      : null,
    annotations: result.stdout
      .split('\n')
      .filter((l) => /^::(notice|warning|error)::/.test(l)),
  }
}

// The runner reads action.yml and passes the result in as INPUT_*; the action
// never sees the default itself. So runAction hardcodes a stand-in, and this
// keeps that stand-in honest -- otherwise every test above could be exercising
// a default the action doesn't actually ship.
test('the harness default matches the one declared in action.yml', () => {
  const actionYml = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'action.yml'),
    'utf8',
  )
  const declared = actionYml
    .split('assume-deployed-on-first-run:')[1]
    ?.match(/^\s+default: "(true|false)"$/m)?.[1]
  assert.equal(
    declared,
    'true',
    'action.yml default changed; update runAction and the tests that rely on it',
  )
})

test('first run baselines against the live page and records its hash', async () => {
  const server = await startTestServer({ body: '<html>a</html>' })
  const run = await runAction({ url: server.url, assumeDeployed: false })
  assert.equal(run.outputs.deployed, 'false')
  assert.equal(run.recorded, sha256('<html>a</html>'))
  assert.match(run.stdout, /No hash recorded/)
  assert.match(run.stdout, /Baseline \(live\)/)
})

test('a deploy that landed before the run started is detected on attempt 1', async () => {
  const server = await startTestServer({ body: '<html>new</html>' })
  const run = await runAction({
    url: server.url,
    recordedHash: sha256('<html>old</html>'),
  })
  assert.equal(run.outputs.deployed, 'true')
  assert.match(run.stdout, /Baseline \(cache\)/)
  assert.match(run.stdout, /Attempt 1\/3: new deploy detected/)
  assert.equal(run.recorded, sha256('<html>new</html>'))
})

test('an unchanged page polls to exhaustion and reports false', async () => {
  const server = await startTestServer({ body: '<html>same</html>' })
  const run = await runAction({
    url: server.url,
    recordedHash: sha256('<html>same</html>'),
  })
  assert.equal(run.outputs.deployed, 'false')
  assert.equal(server.requests, 3, 'should poll exactly max-attempts times')
  assert.match(run.stdout, /No new deploy detected/)
})

test('a deploy landing mid-poll is detected on the attempt it appears', async () => {
  const server = await startTestServer({
    body: '<html>old</html>',
    changeAfter: 2,
    nextBody: '<html>new</html>',
  })
  const run = await runAction({
    url: server.url,
    maxAttempts: 6,
    recordedHash: sha256('<html>old</html>'),
  })
  assert.equal(run.outputs.deployed, 'true')
  assert.match(run.stdout, /Attempt 3\/6: new deploy detected/)
})

test('the baseline and the poll hash identically, so nothing reports a false change', async () => {
  // Would fail if the two were ever computed by different code paths.
  const server = await startTestServer({ body: '<html>stable</html>' })
  const run = await runAction({
    url: server.url,
    maxAttempts: 2,
    assumeDeployed: false,
  })
  assert.equal(run.outputs.deployed, 'false')
  assert.doesNotMatch(run.stdout, /Attempt \d+\/\d+: new deploy detected/)
})

test('a malformed recorded hash is discarded rather than used as a baseline', async () => {
  const server = await startTestServer({ body: '<html>a</html>' })
  const run = await runAction({
    url: server.url,
    recordedHash: 'not-a-digest',
    assumeDeployed: false,
  })
  assert.ok(
    run.annotations.some((a) =>
      a.startsWith('::warning::Discarding malformed'),
    ),
  )
  assert.match(run.stdout, /Baseline \(live\)/)
  assert.equal(run.outputs.deployed, 'false')
})

test('assume-deployed-on-first-run reports true without polling, but still records', async () => {
  const server = await startTestServer({ body: '<html>a</html>' })
  const run = await runAction({ url: server.url, assumeDeployed: true })
  assert.equal(run.outputs.deployed, 'true')
  assert.equal(
    server.requests,
    1,
    'should fetch once to seed the baseline, then stop',
  )
  assert.equal(run.recorded, sha256('<html>a</html>'))
  assert.doesNotMatch(run.stdout, /Attempt/)
})

test('assume-deployed-on-first-run does not short-circuit once a hash exists', async () => {
  const server = await startTestServer({ body: '<html>same</html>' })
  const run = await runAction({
    url: server.url,
    assumeDeployed: true,
    recordedHash: sha256('<html>same</html>'),
  })
  assert.equal(run.outputs.deployed, 'false')
  assert.match(run.stdout, /Attempt 1\/3/)
})

test('failed requests count as unchanged rather than as a deploy', async () => {
  const server = await startTestServer({ body: 'missing', status: 404 })
  const run = await runAction({
    url: server.url,
    recordedHash: sha256('<html>old</html>'),
  })
  assert.equal(
    run.outputs.deployed,
    'false',
    'a broken site must not look like a deploy',
  )
  assert.match(run.stdout, /request failed \(HTTP 404\)/)
})

test('redirects are followed instead of hashing an empty redirect body', async () => {
  const server = await startTestServer({ body: '<html>target</html>' })
  const run = await runAction({ url: server.redirectUrl })
  assert.equal(run.recorded, sha256('<html>target</html>'))
})

test('an unreachable url with no recorded hash fails the step', async () => {
  // Port 1 is reserved and never listening, so the connection fails outright.
  const run = await runAction({ url: `http://${HOST}:1/nothing` })
  assert.equal(run.code, 1)
  assert.ok(
    run.annotations.some((a) =>
      a.startsWith('::error::Failed to compute a checksum'),
    ),
  )
})

test('a bad max-attempts fails with one annotation, not an unhandled stack', async () => {
  const server = await startTestServer({ body: 'x' })
  const run = await runAction({ url: server.url, maxAttempts: 'abc' })
  assert.equal(run.code, 1)
  assert.deepEqual(run.annotations, [
    "::error::max-attempts must be a non-negative integer, got 'abc'.",
  ])
})

test('a bad boolean input fails the step', async () => {
  const server = await startTestServer({ body: 'x' })
  const run = await runAction({ url: server.url, assumeDeployed: 'yes' })
  assert.equal(run.code, 1)
  assert.ok(run.annotations.some((a) => a.startsWith('::error::')))
})

test('a missing url fails the step', async () => {
  const run = await runAction({ url: undefined })
  assert.equal(run.code, 1)
  assert.ok(
    run.annotations.some((a) =>
      a.includes('Input required and not supplied: url'),
    ),
  )
})
