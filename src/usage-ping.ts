/**
 * Tells usage.bvandercar.dev that this action ran, so its runs can be counted.
 *
 * Copied into each of bvandrc's actions; bvandrc/action-usage's README
 * documents what is sent and what the collector keeps.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const ENDPOINT = 'https://usage.bvandercar.dev/v1/runs'

/** Long enough for one round trip from any runner; never worth more. */
const TIMEOUT_MS = 2000

const VISIBILITIES = ['public', 'private', 'internal'] as const

type Visibility = (typeof VISIBILITIES)[number] | 'unknown'

type RunFields = {
  action: string
  ref: string
  ownRepo: boolean
  event: string | null
  runnerOs: string | null
  runnerEnvironment: string | null
  ghes: boolean
}

/** One run, as the collector takes it: a public repo by name, any other by hash. */
export type RunPing = RunFields &
  (
    | { visibility: 'public'; repo: string; runId: number; runAttempt: number }
    | { visibility: Exclude<Visibility, 'public'>; repoHash: string }
  )

type PingOptions = {
  /** The action's `owner/name` */
  action: string
  /** The directory the running file is in; the runner's checkout path names the ref */
  actionDir: string
  env: NodeJS.ProcessEnv
}

const readVisibility = (eventPath: string | undefined): Visibility => {
  if (!eventPath) return 'unknown'
  try {
    const { repository } = JSON.parse(readFileSync(eventPath, 'utf8'))
    const visibility = VISIBILITIES.find((v) => v === repository?.visibility)
    if (visibility) return visibility
    // Older GitHub Enterprise Server payloads have only the boolean.
    if (typeof repository?.private === 'boolean') {
      return repository.private ? 'private' : 'public'
    }
  } catch {
    // Unreadable is unknown, which is sent as if private.
  }
  return 'unknown'
}

const readRef = (env: NodeJS.ProcessEnv, actionDir: string): string =>
  env.GITHUB_ACTION_REF ||
  // The runner checks a used action out to _actions/<owner>/<name>/<ref>/.
  /[\\/]_actions[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)/.exec(actionDir)?.[1] ||
  // Anywhere else is a checkout of the action's own repo (`uses: ./`).
  'local'

/**
 * This run's ping, read from the runner's environment.
 *
 * A repo that isn't known to be public is sent only as a SHA-256 of its
 * lowercased name, so its name never leaves the runner.
 */
export const buildRunPing = ({
  action,
  actionDir,
  env,
}: PingOptions): RunPing => {
  const repo = env.GITHUB_REPOSITORY ?? ''
  const fields: RunFields = {
    action,
    ref: readRef(env, actionDir),
    ownRepo:
      (env.GITHUB_REPOSITORY_OWNER ?? '').toLowerCase() ===
      action.split('/')[0]?.toLowerCase(),
    event: env.GITHUB_EVENT_NAME || null,
    runnerOs: env.RUNNER_OS || null,
    runnerEnvironment: env.RUNNER_ENVIRONMENT || null,
    ghes:
      (env.GITHUB_SERVER_URL ?? 'https://github.com') !== 'https://github.com',
  }
  const visibility = readVisibility(env.GITHUB_EVENT_PATH)
  if (visibility === 'public') {
    return {
      ...fields,
      visibility,
      repo,
      runId: Number(env.GITHUB_RUN_ID),
      runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    }
  }
  return {
    ...fields,
    visibility,
    repoHash: createHash('sha256')
      .update(`action-usage:${repo.toLowerCase()}`)
      .digest('hex'),
  }
}

/**
 * Sends this run's ping, unless `enabled` is false, `DO_NOT_TRACK` is set, or
 * it isn't running in GitHub Actions.
 *
 * Start it alongside the action's own work and await it at the end: it gives
 * up after two seconds and never rejects, so it can't slow or fail a run that
 * takes longer.
 */
export const sendUsagePing = async ({
  enabled,
  ...options
}: PingOptions & { enabled: boolean }): Promise<void> => {
  const { env } = options
  const doNotTrack =
    env.DO_NOT_TRACK && !['0', 'false'].includes(env.DO_NOT_TRACK)
  if (!enabled || doNotTrack || env.GITHUB_ACTIONS !== 'true') return
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRunPing(options)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // Unreachable, slow, or refused: the run goes uncounted, nothing more.
  }
}
