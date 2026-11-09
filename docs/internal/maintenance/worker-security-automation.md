# Maintenance for Worker security automation

## Definition

Outcome: Enable weekly dependency update checks and CodeQL for worker-deploy-action.
Preserved contract: Existing build, release and deployment workflow behavior and executable dependency pins.
Task base: 140f807860a5c484cd8384c4eba64cfa1f7c9f6e
Affected paths: .github/dependabot.yml,.github/workflows/codeql-actions.yml,.github/workflows/codeql-js.yml
Verification inputs: The workflows, dependency updater configuration, shared CodeQL v1.2.4 interface, and existing repository source and lockfiles.
Proposed change: Reuse the org Dependabot baseline and pinned CodeQL workflow.
Required checks: actionlint, YAML policy checks, and existing runtime checks where available. Confirm hosted scans and Dependabot runs after merge.

## Evidence

No Dependabot version config or CodeQL results were present at the base. Local actionlint and updater policy checks passed. Existing delivery workflow YAML parses to the same values as the base.

All seven deploy action tests passed against the released v0.1.1 fixtures.

## Reviews

## State

Independent review pending.
