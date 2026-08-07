# detect-deploy

A GitHub Action that polls a URL until its content changes from the hash recorded by the previous run, to detect when a new deployment has occurred and gone live.

Useful when your host's deploys are outside of GitHub and are triggered by way other than a git push, so a GitHub workflow can't assume a new build is live based on any other condition.

The step blocks while it polls — `max-seconds`, 15 minutes by default — so give the job a `timeout-minutes` above that.

## Usage

Detection goes in one job, and everything downstream keys off its result. This example shows both ways to use that result: a step in the same job dispatching an existing workflow, and a separate job gated on the output.

```yaml
name: Detect Deploy

on:
  push:
    branches: [main]

concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: true

permissions:
  contents: read
  # `write` not required for the detect-deploy action, just required to dispatch another workflow per this example.
  # The repository must also allow it, under Settings -> Actions -> General -> Workflow permissions
  actions: write

jobs:
  detect-deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20

    # Only needed to gate another job; a step in this one reads steps.detect-deploy directly.
    outputs:
      deployed: ${{ steps.detect-deploy.outputs.deployed }}

    steps:
      - name: Detect Deploy
        id: detect-deploy
        uses: bvandrc/detect-deploy@v1
        with:
          url: https://example.com

      # Example: useful for triggering a separate workflow, if wanting that
      # workflow to only occur upon deployment.
      # NOTE: --ref resolves when the dispatch happens, so the target runs
      # against `main` as it is then, not the commit whose deploy was detected.
      - name: Trigger Separate Workflow
        if: steps.detect-deploy.outputs.deployed == 'true'
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

## Inputs

| Name               | Description                                                                                                                                            | Required | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- |
| `url`              | The URL to poll.                                                                                                                                        | Yes      |         |
| `max-seconds`      | How long to keep polling before giving up. `0` makes one request and returns.                                                                           | No       | `900`   |
| `interval-seconds` | Seconds to wait between polling attempts.                                                                                                               | No       | `20`    |
| `assume-deployed-on-first-run` | Report `true` without polling when no hash is recorded yet, so dependent steps run instead of being skipped. See [Caveats](#caveats). | No       | `true`  |

## Outputs

| Name       | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `deployed` | `"true"` if a new deploy was detected within `max-seconds`, else `"false"`.   |

## Caveats

- **The first run has nothing to compare against**, so the answer is genuinely unknown. By default it resolves that as `true` and reports a deploy without polling, so dependent steps run rather than being skipped — against a page that may still be the old build. Set `assume-deployed-on-first-run: false` to baseline against the page as it looks then and poll instead, which reports honestly but misses a deploy that had already gone live. Either way the hash is recorded, so later runs are exact.

  **This applies after every cache eviction, not just the first run ever.** GitHub evicts entries unread for 7 days, so on the default a repository that deploys less often than weekly reports `deployed=true` on its first run back, every time, without checking anything. If your deploys can be more than a week apart, either keep the entry alive (see [keeping the baseline warm](#keeping-the-baseline-warm)) or set the input to `false` and accept the opposite error.
- **This detects change, not authorship.** If something else updates the page between runs, the next run attributes that change to itself.
- **One baseline per URL, per branch.** Actions caches are scoped to a branch, with the default branch's readable from all of them, so a pull request branch reads `main`'s hash but writes its own.
- **Failed requests count as "unchanged"**, so a briefly-down site times out instead of reporting a false positive. Redirects are followed.
- **`max-seconds` bounds when polling stops, not when the step does.** A request already in flight is allowed to finish, so a run can overrun by up to the 30-second request timeout. Leave a minute of headroom in `timeout-minutes` rather than setting it to exactly `max-seconds`.

### Keeping the baseline warm

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

Two things to know:

- If the page did change since the last run, this records the new hash, so the next real deploy compares against it rather than reporting a change twice.
- GitHub disables scheduled workflows in a repository with no activity for 60 days — past that the cron stops and the entry ages out anyway.
