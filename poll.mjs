// Polls a URL until its content differs from the hash recorded by the previous
// run.
//
// Vite (and most modern bundlers) content-hash every asset filename, so the
// served index.html changes on every build -- poll until it differs from the
// baseline instead of guessing a fixed delay.
//
// The baseline is whatever this URL last served as of the previous run. A
// baseline captured now would be wrong whenever the deploy beat the runner to
// it: the "before" picture would already be the new page, and the poll would
// time out on a deploy that had in fact gone live.
//
// Invoked by action.yml; configured entirely through the environment:
//
//   POLL_URL       the URL to poll
//   MAX_ATTEMPTS   how many requests before giving up
//   INTERVAL       seconds between requests
//   STATE_DIR      directory holding the recorded hash, restored from the cache
//   GITHUB_OUTPUT  where step outputs are written
//   ASSUME_DEPLOYED_ON_FIRST_RUN
//                  "true" to report deployed without polling when no hash is
//                  recorded yet
//
// Run it directly to test: POLL_URL=... MAX_ATTEMPTS=3 INTERVAL=1 \
//   ASSUME_DEPLOYED_ON_FIRST_RUN=false STATE_DIR=/tmp/s \
//   GITHUB_OUTPUT=/tmp/out node poll.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';

// A workflow command is a single line, so %, CR and LF in the message have to
// be encoded or it is truncated at the first newline -- which is what happens
// to a multi-line stack trace. Same encoding @actions/core applies.
const escapeData = (message) =>
  String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

const logInfo = (message) => console.log(`::notice::${escapeData(message)}`);
const logWarning = (message) => console.log(`::warning::${escapeData(message)}`);
const logError = (message) => console.log(`::error::${escapeData(message)}`);

const getEnvInteger = (name) => {
  const raw = process.env[name] ?? '';
  if (!/^\d+$/.test(raw)) {
    logError(`${name} must be a non-negative integer, got '${raw}'.`);
    process.exit(1);
  }
  return Number(raw);
};

// Strict rather than truthy: action inputs arrive as strings, and the string
// "false" is truthy in JS.
const getEnvBoolean = (name) => {
  const raw = process.env[name] ?? '';
  if (raw !== 'true' && raw !== 'false') {
    logError(`${name} must be true or false, got '${raw}'.`);
    process.exit(1);
  }
  return raw === 'true';
};

const TARGET_URL = process.env.POLL_URL;
const STATE_DIR = process.env.STATE_DIR;
const STATE_FILE = `${STATE_DIR}/hash`;
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const MAX_ATTEMPTS = getEnvInteger('MAX_ATTEMPTS');
const INTERVAL = getEnvInteger('INTERVAL');
const ASSUME_DEPLOYED_ON_FIRST_RUN = getEnvBoolean('ASSUME_DEPLOYED_ON_FIRST_RUN');

const setOutput = (key, value) =>
  fs.appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);

const sleep = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

// Used for both the baseline and every poll, so the two can never be hashed
// differently -- which would report a change on the first attempt of every run.
// Redirects are followed: the curl this replaced did not, so a url that 301s
// hashed an empty body that never changed.
const fetchHash = async () => {
  const res = await fetch(TARGET_URL, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  return crypto.createHash('sha256').update(body).digest('hex');
};

// The hash output is internal: it tells the save step there is a hash worth
// persisting. Only `deployed` is exposed by the action.
const record = (hash) => {
  fs.writeFileSync(STATE_FILE, `${hash}\n`);
  setOutput('hash', hash);
};

const main = async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  let baseline = null;
  let source = 'live';
  if (fs.existsSync(STATE_FILE)) {
    const cached = fs.readFileSync(STATE_FILE, 'utf8').trim();
    // Ignore anything that isn't a sha256 digest, rather than baselining
    // against a truncated or corrupted cache entry.
    if (/^[0-9a-f]{64}$/.test(cached)) {
      baseline = cached;
      source = 'cache';
    } else {
      logWarning(`Discarding malformed cached hash for ${TARGET_URL}.`);
    }
  }

  // Only reachable before the first hash is recorded (or after the entry is
  // evicted); there is nothing else to compare against yet, so the honest
  // answer is "unknown" and the flag decides which way to resolve it.
  if (!baseline) {
    logInfo(
      ASSUME_DEPLOYED_ON_FIRST_RUN
        ? `No hash recorded for ${TARGET_URL} yet; recording what it serves now and reporting deployed=true without polling.`
        : `No hash recorded for ${TARGET_URL} yet, so this run is baselining against the page as it looks now. If the deploy already went live, this run may not detect it.`,
    );
    try {
      baseline = await fetchHash();
    } catch (err) {
      logError(
        `Failed to compute a checksum for ${TARGET_URL}; cannot establish a baseline. (${err.message})`,
      );
      process.exit(1);
    }

    // Still fetched and recorded above: the next run needs a baseline either
    // way, and without one it would land here again.
    if (ASSUME_DEPLOYED_ON_FIRST_RUN) {
      record(baseline);
      setOutput('deployed', 'true');
      return;
    }
  }

  console.log(`Baseline (${source}): ${baseline}`);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let current = null;
    try {
      current = await fetchHash();
    } catch (err) {
      console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}: request failed (${err.message}).`);
    }

    if (current && current !== baseline) {
      console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}: new deploy detected (${current}).`);
      record(current);
      setOutput('deployed', 'true');
      return;
    }
    if (current) console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}: unchanged.`);
    if (attempt < MAX_ATTEMPTS) await sleep(INTERVAL);
  }

  console.log(`No new deploy detected after ${MAX_ATTEMPTS * INTERVAL} seconds.`);
  record(baseline);
  setOutput('deployed', 'false');
};

try {
  await main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
