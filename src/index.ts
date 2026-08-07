/**
 * Polls a URL until its content differs from the hash recorded by the previous
 * run.
 *
 * Vite (and most modern bundlers) content-hash every asset filename, so the
 * served index.html changes on every build -- poll until it differs from the
 * baseline instead of guessing a fixed delay.
 *
 * The baseline is whatever this URL last served as of the previous run. A
 * baseline captured now would be wrong whenever the deploy beat the runner to
 * it: the "before" picture would already be the new page, and the poll would
 * time out on a deploy that had in fact gone live.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFeatureAvailable, restoreCache, saveCache } from '@actions/cache'
import {
  debug,
  getBooleanInput,
  getInput,
  info,
  notice,
  setFailed,
  setOutput,
  warning,
} from '@actions/core'

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

const getIntegerInput = (name: string): number => {
  const raw = getInput(name)
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got '${raw}'.`)
  }
  return Number(raw)
}

const sleep = (seconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000))

// Everything runs inside one scope so that a bad input is thrown where the
// handler below can turn it into a single annotation. Left at module level it
// would escape as an uncaught exception and print a stack trace through the
// bundle, which buries a plain "max-attempts must be an integer" in noise.
const main = async (): Promise<void> => {
  const targetUrl = getInput('url', { required: true })
  const maxAttempts = getIntegerInput('max-attempts')
  const interval = getIntegerInput('interval-seconds')
  const assumeDeployedOnFirstRun = getBooleanInput(
    'assume-deployed-on-first-run',
  )

  // A directory, because the cache API caches paths rather than values.
  const stateDir = join(process.env.RUNNER_TEMP ?? tmpdir(), 'detect-deploy')
  const stateFile = join(stateDir, 'hash')

  // Cache entries are immutable, so every run writes a new key and reads back
  // the most recent one matching the prefix. The url is digested to bound the
  // key length and to keep one url from prefix-matching another. The job is
  // part of the key so two jobs polling the same url in one run don't collide
  // on it; it is not part of the prefix, so they still read each other's
  // hashes.
  const urlId = createHash('sha256')
    .update(targetUrl)
    .digest('hex')
    .slice(0, 32)
  const cachePrefix = `detect-deploy-v1-${urlId}-`
  const cacheKey =
    cachePrefix +
    [
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_RUN_ATTEMPT,
      process.env.GITHUB_JOB,
    ].join('-')

  // Used for both the baseline and every poll, so the two can never be hashed
  // differently -- which would report a change on the first attempt of every
  // run. Redirects are followed: the curl this replaced did not, so a url that
  // 301s hashed an empty body that never changed.
  const fetchHash = async (): Promise<string> => {
    const res = await fetch(targetUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = Buffer.from(await res.arrayBuffer())
    return createHash('sha256').update(body).digest('hex')
  }

  // A cache miss is normal and a cache failure is survivable -- the run just
  // falls back to a live baseline -- so neither is allowed to fail the step.
  const restoreBaseline = async (): Promise<string | null> => {
    if (isFeatureAvailable()) {
      try {
        const matched = await restoreCache([stateDir], cacheKey, [cachePrefix])
        if (matched) debug(`Restored ${matched}`)
      } catch (err) {
        warning(`Could not read the recorded hash: ${message(err)}`)
      }
    } else {
      debug(
        'Actions cache is unavailable; the baseline cannot carry across runs.',
      )
    }

    // Read whatever is on disk rather than trusting the restore result: the
    // file is the state, the cache is only how it usually gets here. A second
    // invocation in the same job finds it even if the save lost a key race.
    if (!existsSync(stateFile)) return null
    const cached = readFileSync(stateFile, 'utf8').trim()
    // Ignore anything that isn't a sha256 digest, rather than baselining
    // against a truncated or corrupted cache entry.
    if (!/^[0-9a-f]{64}$/.test(cached)) {
      warning(`Discarding malformed cached hash for ${targetUrl}.`)
      return null
    }
    return cached
  }

  // Set by record(), saved in the finally: a run that timed out still
  // re-records its hash, which keeps the entry clear of the eviction window.
  let hashToRecord: string | null = null
  const record = (hash: string): void => {
    writeFileSync(stateFile, `${hash}\n`)
    hashToRecord = hash
  }

  try {
    mkdirSync(stateDir, { recursive: true })

    let baseline = await restoreBaseline()
    const source = baseline ? 'cache' : 'live'

    // Only reachable before the first hash is recorded (or after the entry is
    // evicted); there is nothing else to compare against yet, so the honest
    // answer is "unknown" and the flag decides which way to resolve it.
    if (!baseline) {
      const noHashYet = `No hash recorded for ${targetUrl} yet.`
      notice(
        assumeDeployedOnFirstRun
          ? `${noHashYet} Recording what it serves now and reporting deployed=true without polling.`
          : `${noHashYet} This run is baselining against the page as it looks now, so a deploy that already went live may not be detected.`,
      )
      try {
        baseline = await fetchHash()
      } catch (err) {
        throw new Error(
          `Failed to compute a checksum for ${targetUrl}; cannot establish a baseline. (${message(err)})`,
        )
      }

      // Still fetched and recorded below: the next run needs a baseline either
      // way, and without one it would land here again.
      if (assumeDeployedOnFirstRun) {
        record(baseline)
        setOutput('deployed', 'true')
        return
      }
    }

    info(`Baseline (${source}): ${baseline}`)

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const label = `Attempt ${attempt}/${maxAttempts}`
      let current: string | null = null
      try {
        current = await fetchHash()
      } catch (err) {
        info(`${label}: request failed (${message(err)}).`)
      }

      if (current && current !== baseline) {
        info(`${label}: new deploy detected (${current}).`)
        record(current)
        setOutput('deployed', 'true')
        return
      }
      if (current) info(`${label}: unchanged.`)
      if (attempt < maxAttempts) await sleep(interval)
    }

    info(`No new deploy detected after ${maxAttempts * interval} seconds.`)
    record(baseline)
    setOutput('deployed', 'false')
  } finally {
    if (hashToRecord && isFeatureAvailable()) {
      try {
        await saveCache([stateDir], cacheKey)
      } catch (err) {
        // Includes the benign case of two invocations in one job racing on the
        // key, which the cache service rejects rather than overwriting.
        warning(`Could not record the hash for the next run: ${message(err)}`)
      }
    }
  }
}

// Not top-level await: the bundle is CommonJS, which has no such thing.
main().catch((err: unknown) => setFailed(message(err)))
