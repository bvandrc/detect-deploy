# poll-for-deploy

A composite GitHub Action that polls a URL until its content changes from a
pre-recorded baseline, to detect when a new deploy has gone live.

This is useful when your host's deploys are decoupled from the git push that
triggers CI, so a workflow can't assume a new build is live the moment CI
starts. It polls instead of guessing a fixed sleep duration.

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

See [`examples/wait-for-deploy.yml`](examples/wait-for-deploy.yml) for a
full example.

## Inputs

| Name               | Description                                       | Required | Default |
| ------------------ | -------------------------------------------------- | -------- | ------- |
| `url`               | The URL to poll.                                    | Yes      |         |
| `max-attempts`      | Maximum number of polling attempts before giving up.| No       | `45`    |
| `interval-seconds`  | Seconds to wait between polling attempts.           | No       | `20`    |

## Outputs

| Name       | Description                                                              |
| ---------- | ------------------------------------------------------------------------- |
| `deployed` | `"true"` if a new deploy was detected before `max-attempts`, else `"false"`. |
