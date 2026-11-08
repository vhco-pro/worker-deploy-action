# Worker deploy action

Activates one verified Worker bundle for an already provisioned Cloudflare
target. Call it from a protected deployment job after checking out the exact
release tag and downloading that target's immutable GitHub release assets.

Supply the expected Worker name and account independently through the target's
environment. The action checks the release tag, commit, bundle, target config,
npm lockfile and toolchain. It uploads the bundle with Wrangler's no-bundle
path, activates the returned version ID and reads back the active deployment.
The receipt includes the prior version ID when it is available.

The action requires one active version at 100 percent before activation.
Bootstrap, route changes, state migrations and rollback need their own runbook.

Run `bun test` to exercise the activation protocol. The artifact integration
test also needs the candidate outputs from the CI action.
