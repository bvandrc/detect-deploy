# poll-for-deploy

A GitHub Action that polls a URL until its content changes from the last hash
it recorded, to detect when a new deploy has gone live.

This is useful when your host's deploys are decoupled from the git push that
triggers CI, so a workflow can't assume a new build is live the moment CI
starts. It polls instead of guessing a fixed sleep duration.

The baseline it compares against is the hash recorded by the previous run, kept
in the Actions cache — so a deploy that went live before the workflow even
started is still detected, rather than timing out.

## Usage

```yaml
jobs:
  wait-for-deploy:
    name: Wait for deploy
    runs-on: ubuntu-latest
    timeout-minutes: 20
    if: github.event_name == 'push'

    outputs:
      deployed: ${{ steps.poll.outputs.deployed }}

    steps:
      - name: Poll for deploy
        id: poll
        uses: bvandrc/poll-for-deploy@v1
        with:
          url: https://example.com

  post-deploy-checks:
    name: Post-deploy checks
    needs: wait-for-deploy
    if: always() && (github.event_name != 'push' || needs.wait-for-deploy.outputs.deployed == 'true')
    runs-on: ubuntu-latest
    steps:
      - run: echo "run your post-deploy checks here"
```

## Keeping the baseline warm

The recorded hash lives in the Actions cache, and GitHub evicts entries that
have gone 7 days without a read. If more than a week can pass between deploys,
the entry is gone by the next one and that run starts over with no baseline.

If that's possible for you, schedule a run that does nothing but read the hash
and record it again:

```yaml
name: Keep deploy baseline warm
on:
  schedule:
    - cron: "0 4 * * 1,4" # twice weekly: a 7-day cron races the 7-day eviction
  workflow_dispatch:

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: bvandrc/poll-for-deploy@v1
        with:
          url: https://example.com
          max-attempts: "1"
```

One request, no waiting, and its `deployed` output is meant to be ignored. Run
it on your default branch — those caches are readable from every branch, so a
single job keeps every branch's lookups alive.

Two things to know: if the page did change since the last run, this records the
new hash, so the next real deploy compares against it rather than reporting a
change twice. And GitHub disables scheduled workflows in a repository with no
activity for 60 days — past that the cron stops and the entry ages out anyway.

## Inputs

| Name               | Description                                                                                                                                            | Required | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- |
| `url`              | The URL to poll.                                                                                                                                        | Yes      |         |
| `max-attempts`     | Maximum number of polling attempts before giving up.                                                                                                    | No       | `45`    |
| `interval-seconds` | Seconds to wait between polling attempts.                                                                                                               | No       | `20`    |
| `assume-deployed-on-first-run` | Report `true` without polling when no hash is recorded yet, so dependent steps run instead of being skipped.                  | No       | `false` |

## Outputs

| Name       | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `deployed` | `"true"` if a new deploy was detected before `max-attempts`, else `"false"`.  |

The hashes themselves are an implementation detail and aren't exposed; the run
log prints the baseline and every observed hash if you need to debug a poll.

## Notes

- **The first run has nothing to compare against**, so the answer is genuinely
  unknown. By default it baselines against the page as it looks then and polls,
  which can miss a deploy that already went live; set
  `assume-deployed-on-first-run` to report `true` at once instead, so dependent
  steps run rather than being skipped — against a page that may still be the
  old build. Either way the hash is recorded, so later runs are exact. This also
  applies after an entry is evicted; see [keeping the baseline
  warm](#keeping-the-baseline-warm).
- **One baseline per URL, per branch.** Actions caches are scoped to a branch,
  with the default branch's readable from all of them, so a pull request branch
  reads `main`'s hash but writes its own.
- **This detects change, not authorship.** If something else updates the page
  between runs, the next run attributes that change to itself. For strict
  attribution, serve a build marker (a commit SHA in the HTML) and assert on it
  after this action reports `deployed`.
- Failed requests count as "unchanged", so a briefly-down site times out instead
  of reporting a false positive. Redirects are followed.

## Development

The action source is `src/index.ts`. Because a JavaScript action runs the
checked-in file rather than the source, the bundle at `dist/index.js` is
committed and must be rebuilt whenever `src/` changes:

```sh
npm ci
npm run all   # typecheck, bundle, test
```

The tests run the built bundle as a subprocess against a local HTTP server,
feeding it `INPUT_*` variables the way a runner does — so they cover the
artifact that actually ships rather than the source it came from. The Actions
cache isn't reachable outside a workflow, so the action skips it and reads the
recorded hash straight off disk; seeding that file is how the tests cover the
cache-hit paths.

They're written in TypeScript and run through Node's own type stripping, so
running them needs Node 22.6 or newer. There is no test framework or transpile
step — `node --test` and `node:assert`.

Pushing without rebuilding is safe on a branch — CI rebuilds and commits the
bundle if it differs from what you pushed. On a pull request it can't commit,
so it fails instead.
