# detect-deploy

A GitHub Action that polls a URL until its content changes from the last hash it recorded, to detect when a new deploy has gone live.

The step blocks while it polls — `max-seconds`, 15 minutes by default — so give the job a `timeout-minutes` above that.

This is useful when your host's deploys are decoupled from the git push that triggers CI, so a workflow can't assume a new build is live the moment CI starts. It polls instead of guessing a fixed sleep duration.

The baseline it compares against is the hash recorded by the previous run, kept in the Actions cache — so a deploy that went live before the workflow even started is still detected, rather than timing out.

## Usage

Detection goes in one job, and everything downstream keys off its result. This example shows both ways to use that result: a step in the same job dispatching an existing workflow, and a separate job gated on the output.

```yaml
name: Detect Deploy

on:
  push:
    branches: [main]

# A newer push makes an in-flight poll obsolete: it's chasing a build that has
# been superseded. Cancel it and let the newer run detect the newer deploy.
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: true

permissions:
  contents: read
  actions: write # required to dispatch another workflow

jobs:
  detect-deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    # Only needed to gate another job; a step in this one reads steps.detect
    # directly.
    outputs:
      deployed: ${{ steps.detect.outputs.deployed }}

    steps:
      - name: Detect Deploy
        id: detect
        uses: bvandrc/detect-deploy@v1
        with:
          url: https://example.com

      # Example: useful for triggering a separate workflow, if wanting that
      # workflow to only occur upon deployment.
      - name: Trigger Separate Workflow
        if: steps.detect.outputs.deployed == 'true'
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh workflow run separate-workflow.yml --ref main --repo ${{ github.repository }}

  # Example: triggering/gating a separate job.
  post-deploy-checks:
    name: Post-deploy checks
    needs: detect-deploy
    if: needs.detect-deploy.outputs.deployed == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: echo "run your post-deploy checks here"
```

Three things that will bite you here:

- **`actions: write` is necessary but not sufficient.** Workflow dispatch is one of the few events `GITHUB_TOKEN` is allowed to trigger, but the repository must also permit it: Settings → Actions → General → Workflow permissions must be "Read and write". Without it the `gh workflow run` step 403s.
- **The dispatched run starts from `--ref main`, not from the commit that was deployed.** If pushes land faster than the poll finishes, the target runs against whatever `main` points at then. That's usually what you want for a production audit — it matches what's actually live — but it does mean the run isn't pinned to the pushed commit.
- **A step output doesn't cross a job boundary.** `steps.detect.outputs.deployed` is readable only inside `detect-deploy`; another job needs the `outputs:` mapping above and reads it as `needs.detect-deploy.outputs.deployed`. Drop the mapping and the gate silently evaluates to empty, so the job never runs.

## Keeping the baseline warm

The recorded hash lives in the Actions cache, and GitHub evicts entries that have gone 7 days without a read. If more than a week can pass between deploys, the entry is gone by the next one and that run starts over with no baseline.

If that's possible for you, schedule a run that does nothing but read the hash and record it again:

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
      - uses: bvandrc/detect-deploy@v1
        with:
          url: https://example.com
          max-seconds: "0" # one request, no polling
```

One request, no waiting, and its `deployed` output is meant to be ignored. Run it on your default branch — those caches are readable from every branch, so a single job keeps every branch's lookups alive.

Two things to know: if the page did change since the last run, this records the new hash, so the next real deploy compares against it rather than reporting a change twice. And GitHub disables scheduled workflows in a repository with no activity for 60 days — past that the cron stops and the entry ages out anyway.

## Inputs

| Name               | Description                                                                                                                                            | Required | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- |
| `url`              | The URL to poll.                                                                                                                                        | Yes      |         |
| `max-seconds`      | How long to keep polling before giving up. `0` makes one request and returns.                                                                           | No       | `900`   |
| `interval-seconds` | Seconds to wait between polling attempts.                                                                                                               | No       | `20`    |
| `assume-deployed-on-first-run` | Report `true` without polling when no hash is recorded yet, so dependent steps run instead of being skipped.                  | No       | `true`  |

## Outputs

| Name       | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `deployed` | `"true"` if a new deploy was detected within `max-seconds`, else `"false"`.   |

The hashes themselves are an implementation detail and aren't exposed; the run log prints the baseline and every observed hash if you need to debug a poll.

## Notes

- **The first run has nothing to compare against**, so the answer is genuinely unknown. By default it resolves that as `true` and reports a deploy without polling, so dependent steps run rather than being skipped — against a page that may still be the old build. Set `assume-deployed-on-first-run: false` to baseline against the page as it looks then and poll instead, which reports honestly but misses a deploy that had already gone live. Either way the hash is recorded, so later runs are exact.

  **This applies after every cache eviction, not just the first run ever.** GitHub evicts entries unread for 7 days, so on the default a repository that deploys less often than weekly reports `deployed=true` on its first run back, every time, without checking anything. If your deploys can be more than a week apart, either keep the entry alive (see [keeping the baseline warm](#keeping-the-baseline-warm)) or set the input to `false` and accept the opposite error.
- **One baseline per URL, per branch.** Actions caches are scoped to a branch, with the default branch's readable from all of them, so a pull request branch reads `main`'s hash but writes its own.
- **This detects change, not authorship.** If something else updates the page between runs, the next run attributes that change to itself. For strict attribution, serve a build marker (a commit SHA in the HTML) and assert on it after this action reports `deployed`.
- Failed requests count as "unchanged", so a briefly-down site times out instead of reporting a false positive. Redirects are followed.
- **`max-seconds` bounds when polling stops, not when the step does.** A request already in flight is allowed to finish, so a run can overrun by up to the 30-second request timeout. Leave a minute of headroom in `timeout-minutes` rather than setting it to exactly `max-seconds`.

## Development

The action source is `src/index.ts`. Because a JavaScript action runs the checked-in file rather than the source, the bundle at `dist/index.js` is committed and must be rebuilt whenever `src/` changes:

```sh
npm ci
npm run all   # type-check, bundle, test
```

The tests run the built bundle as a subprocess against a local HTTP server, feeding it `INPUT_*` variables the way a runner does — so they cover the artifact that actually ships rather than the source it came from. The Actions cache isn't reachable outside a workflow, so the action skips it and reads the recorded hash straight off disk; seeding that file is how the tests cover the cache-hit paths.

They're written in TypeScript and run through Node's own type stripping, so running them needs Node 22.6 or newer. There is no test framework or transpile step — `node --test` and `node:assert`.

Pushing without rebuilding is safe on a branch — CI rebuilds and commits the bundle if it differs from what you pushed. On a pull request it can't commit, so it fails instead.
