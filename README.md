# poll-for-deploy

A composite GitHub Action that polls a URL until its content changes from the
last hash it recorded, to detect when a new deploy has gone live.

This is useful when your host's deploys are decoupled from the git push that
triggers CI, so a workflow can't assume a new build is live the moment CI
starts. It polls instead of guessing a fixed sleep duration.

## How the baseline works

The baseline is the hash this action recorded the last time it ran, restored
from the Actions cache. That matters because a deploy can win the race against
the runner: if the action captured its own "before" picture on startup, a deploy
that already went live would have *already* been in that picture, and the action
would poll a page that was never going to change again and report
`deployed: false` on a deploy that succeeded.

Comparing against the previous run's hash removes the race. If the deploy landed
early, the first request already differs from the recorded hash and the action
returns immediately.

Before the first hash is recorded — the first run, a new cache scope, or an
entry evicted after 7 days of no reads — there is nothing to compare against
yet, so the action fetches a live baseline and logs a notice saying so. That one
run is exposed to the race; every run after it is not.

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

## Inputs

| Name               | Description                                                                                                                                            | Required | Default |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------- |
| `url`              | The URL to poll.                                                                                                                                        | Yes      |         |
| `max-attempts`     | Maximum number of polling attempts before giving up.                                                                                                    | No       | `45`    |
| `interval-seconds` | Seconds to wait between polling attempts.                                                                                                               | No       | `20`    |

## Outputs

| Name       | Description                                                                 |
| ---------- | --------------------------------------------------------------------------- |
| `deployed` | `"true"` if a new deploy was detected before `max-attempts`, else `"false"`.  |

The hashes themselves are an implementation detail and aren't exposed; the run
log prints the baseline and every observed hash if you need to debug a poll.

## Notes

- **Cache scope.** Actions caches are scoped per branch, with the default
  branch's caches readable from every branch. A workflow that polls on pushes to
  `main` shares one baseline. A pull request branch reads `main`'s recorded hash
  but writes its own, so it won't disturb `main`'s baseline.
- **The entry is keyed by URL**, so every job polling a given URL on a branch
  shares one baseline, which is what you want when they are all watching the
  same site.
- **The hash is recorded even when the poll times out**, so a run of quiet
  deploys keeps the entry alive rather than letting it age out.
- **This detects change, not authorship.** If something else updates the page
  between runs, the next run attributes that change to itself. For strict
  attribution, serve a build marker (a commit SHA in the HTML) and assert on it
  after this action reports `deployed`.
- Failed requests during polling count as "unchanged", so a site that is briefly
  down produces a timeout rather than a false positive.
