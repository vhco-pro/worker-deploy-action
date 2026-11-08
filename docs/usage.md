# Use the Worker deploy action

The [reusable workflow](https://github.com/vhco-pro/worker-release-workflow)
handles GitHub environment selection, approval, exact checkout and artifact
download. Use the action inside that protected job. A direct caller supplies
those same safeguards.

## Call the action

```yaml
- id: deploy
  uses: vhco-pro/worker-deploy-action@586f03db605260f752621b288200c6cccd70bc72 # v0.1.0
  with:
    target: ${{ inputs.target }}
    worker: ${{ vars.WORKER_NAME }}
    tag: ${{ inputs.tag }}
    commit: ${{ steps.release.outputs.commit }}
    artifact: ${{ runner.temp }}/selected-release
    account: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}
    token: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    rehearse: 'true'
```

| Input | What to pass |
| --- | --- |
| `project` | Worker directory relative to the exact tag checkout. Defaults to the repository root. |
| `target` | Target slug matching the published manifest and target config. |
| `worker` | Expected Worker name from the selected environment. |
| `tag`, `commit` | Stable release tag and its exact commit. |
| `artifact` | Directory with the selected release files named `worker.mjs` and `manifest.json`. |
| `account`, `token` | Cloudflare account ID and deployment token from the target environment. |
| `rehearse` | Set to `'true'` for a synthetic no-bundle dry run. Defaults to `'false'`. |

For a rehearsal, set the account ID to a 32-digit dummy value and the token
to `synthetic-worker-rehearsal-<target>`. The action verifies the target token
and clears Cloudflare credentials before starting Wrangler's dry run.
Rehearsal succeeds once the dry-run bytes match the release module.

## Read the activation receipt

| Output | Meaning |
| --- | --- |
| `version` | Worker version Cloudflare reports at 100% traffic. |
| `deployment` | Active Cloudflare deployment ID. |
| `previous-version` | Prior serving Worker version when available. |

Activation stops if the artifact, source, config, toolchain or target does
not match. It also stops if the serving deployment changed during upload.
If Cloudflare reports the same release already active, the action can return
the current receipt without another upload. Receipt recovery expects any
previous deployment it reads to have a single version receiving all traffic.

Record the previous version and the applicable state and route recovery
procedure before activation. Initial provisioning and rollback are
separate operations. [Cloudflare versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/)
