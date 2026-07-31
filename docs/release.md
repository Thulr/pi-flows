# Release checklist

Releases publish to npm from CI: pushing a `vX.Y.Z` tag runs
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml), which runs
`npm run check` and then `npm publish` (with provenance). Publishing to npm is
what lists pi-flows in the [pi.dev gallery](https://pi.dev/packages).

**One-time setup:** configure npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
for the package — no token or secret required. On npmjs.com, open the **pi-flows**
package → **Settings → Trusted Publisher → GitHub Actions** and enter:

| Field | Value |
| --- | --- |
| Organization or user | `Thulr` |
| Repository | `pi-flows` |
| Workflow filename | `publish.yml` |
| Environment | _(leave blank)_ |

CI then authenticates over OIDC through the workflow's `id-token: write`
permission, and provenance is generated automatically.

## Cut a release

1. Move `CHANGELOG.md` notes from `Unreleased` into a dated, versioned section.
2. Bump the version in **both** `package.json` and `PI_FLOWS_VERSION` in
   `extensions/pi-flows/types.ts`. The publish workflow fails if the tag does
   not match `package.json`.
3. Verify locally:

   ```bash
   npm ci
   npm run check
   ```

4. Run the pre-production release evaluation with complete runtime evidence.
   Include the controlled production-failure ledger when one exists:

   ```bash
   export PI_FLOWS_EVAL_ATTESTATION_KEY="$(openssl rand -hex 32)"
   npm run eval -- \
     --release-suite \
     --trials=5 \
     --strict-trace \
     --run-id="release-<version>" \
     --failure-ledger=/secure/pi-flows-failures.jsonl \
     --runtime-trace=.thulr/runs/release.runtime.jsonl \
     --reliability-out=.thulr/runs/release.reliability.json \
     --calibration-out=.thulr/runs/release.calibration.json
   ```

   The release suite pass-gates behaviour cases and every imported production
   regression. Hard headroom cases remain score-tracked by the regular internal
   eval suite; expected partial scores are not represented as failed verified
   outcomes in the release manifest.

5. Smoke the local package in pi:

   ```bash
   pi install -l ./
   ```

   ```text
   /reload
   /flows version
   Use flow with {"list":true}
   Use flow with {"showConfig":true}
   ```

6. Commit with a [Conventional Commit](../CONTRIBUTING.md#commit-messages), open
   a PR, and merge to `main`.
7. Check out the clean merge commit, repeat the release evaluation in step 4
   against that exact commit, and generate the release record described below.
   An `approved` decision is required before tagging.
8. Tag the merge commit and push the tag — this triggers the **Publish**
   workflow:

   ```bash
   tag="v$(node -p "require('./package.json').version")"
   git tag "$tag"
   git push origin "$tag"
   ```

9. Confirm: the **Publish** workflow is green, `npm view pi-flows version` shows
   the new version, and `pi install npm:pi-flows` resolves it.

## Release evidence and manifest

The release owner prepares a minimized `pi-flows.release-evidence.v1` JSON
attestation. It names the eval run, evaluated time, every subject and judge model,
the exact evaluated Git commit, the topology and budgets used, the suite and case
ids, the grader and version, and all six hard-blocker results. Each hard blocker
must be `status:"passed"` and carry at least one non-empty attributable string
reference:

- `unauthorizedIrreversibleActions`
- `approvalBypass`
- `secretOrPersonalDataLeakage`
- `corruptedSharedState`
- `rollbackFailure`
- `requiredTraceLoss`

Missing evidence is a failure, not a warning. The command also blocks a dirty
tree, version disagreement, any failed/excluded/unverified trial, incomplete
runtime traces, incomplete or blocking calibration, a critical dimension without
authority, a declared suite that differs from the measured reliability cases, or
a promoted regression absent from the reliability artifact. The supplied runtime
trace path must equal `reliability.runtimeTraceFile`; every trial's exact
trace/root-span link and run/case/trial attributes must resolve in that file.
The read-back also applies the strict trace-tree gate to declared/observed span
counts, failed exports, malformed or duplicate rows, parentage, timing, and
dependency links.
The reliability artifact records the actual subject models, per-case topology
and budget configuration, environment, repository hashes, and clean-tree state
at evaluation time. Release evals isolate discovery to the package-owned prompts
whose hashes enter the manifest. The release command requires the current
checkout and every operator-declared model/topology/budget/suite/grader field to
match that recorded provenance exactly; these fields are not trusted as
standalone assertions. Calibration artifacts retain their blocking decision and
issues, require a complete self-verifying calibration key, all versioned splits,
coverage/statistics/review evidence, and the release-critical `criterion`
dimension. The release command recomputes the calibration gate from that
evidence and requires its key, gate, and artifact hash to match the reliability
run; a copied or skeletal nonblocking assertion cannot approve. A current,
complete recalibration may record that the prior key was unknown or stale; the
gate reads the newly computed evidence rather than treating old drift as current
failure.

```json
{
  "schemaVersion": "pi-flows.release-evidence.v1",
  "runId": "release-0.4.0",
  "codeCommit": "0123456789abcdef0123456789abcdef01234567",
  "evaluatedAt": "2026-07-28T12:00:00Z",
  "models": {
    "subjects": ["provider/subject-version"],
    "judge": "provider/judge-version"
  },
  "topology": {
    "arm": "flows",
    "cases": {
      "release-case": { "mode": "evaluate", "paramsDigest": "<sha256>" }
    }
  },
  "budgets": {
    "subjectTrials": 5,
    "defaultMaxCostUsd": 1,
    "defaultTimeoutMs": 120000,
    "armTimeoutMs": null,
    "cases": {
      "release-case": {
        "maxCostUsd": 1,
        "maxTokens": null,
        "maxGeneratedTokens": null,
        "caseTimeoutMs": 120000,
        "effectiveTimeoutMs": 120000
      }
    }
  },
  "suite": { "name": "release", "caseIds": ["release-case"] },
  "grader": { "name": "thulr", "version": "0.3.0" },
  "hardBlockers": {
    "unauthorizedIrreversibleActions": { "status": "passed", "evidence": ["check:irreversible-actions"] },
    "approvalBypass": { "status": "passed", "evidence": ["check:approval-receipts"] },
    "secretOrPersonalDataLeakage": { "status": "passed", "evidence": ["check:privacy"] },
    "corruptedSharedState": { "status": "passed", "evidence": ["check:residual-state"] },
    "rollbackFailure": { "status": "passed", "evidence": ["check:rollback"] },
    "requiredTraceLoss": { "status": "passed", "evidence": ["check:strict-trace"] }
  }
}
```

Copy `models`, `topology`, `budgets`, `suite`, and `grader` from the reliability
artifact's `evaluation` object, then add the independently owned hard-blocker
references. Any edit or substitution blocks release.

The release record requires the same operator-controlled
`PI_FLOWS_EVAL_ATTESTATION_KEY` that authenticated the reliability run. Keep it
in the release secret store, never in an artifact or the repository.

```bash
npm run eval:release -- \
  --evidence=/secure/release-evidence.json \
  --reliability=.thulr/runs/release.reliability.json \
  --calibration=.thulr/runs/release.calibration.json \
  --runtime-trace=.thulr/runs/release.runtime.jsonl \
  --failure-ledger=/secure/pi-flows-failures.jsonl \
  --out=/secure/releases/pi-flows-<version>.release.json
```

The resulting `pi-flows.release-manifest.v1` pins:

- the evaluation-time Git commit and clean-tree status; package, extension,
  lockfile, and package manager versions, cross-checked against the release
  checkout;
- per-agent and aggregate prompt hashes, the TypeBox tool-schema hash, and
  topology, harness, and suite hashes;
- subject/judge model ids, topology, budgets, safe environment identity, suite,
  harness, grader, and calibration versions;
- hashes of the reliability, calibration, runtime-trace, and required canonical
  production-failure ledger artifacts (use an empty file when no failures have
  been imported). Its hash, head, imported-case bindings, and promoted ids must
  match the ledger used during evaluation. Runtime-trace and ledger hashes must
  also equal the exact bytes their validators read; and
- the complete hard-blocker decision plus a digest of the manifest itself.

Store the record and its referenced artifacts together in access-controlled,
append-only release evidence storage. They are generated evaluation artifacts
and must not be committed or packaged.

## Evidence ownership and lifecycle

Evidence has three layers; none substitutes for another:

1. **Runtime evidence** is emitted by each flow and attributes dispatch,
   handoffs, approvals, state, policy, and outcomes for that exact run.
2. **Pre-production evidence** repeats the release suite on the candidate commit,
   judges outcomes, verifies trace completeness, checks calibration authority,
   and exercises every promoted production regression.
3. **Production evidence** is monitoring and incident evidence from the deployed
   version. It can trigger rollback and seed a minimized capability case, but it
   cannot retroactively make a missing pre-production check pass.

Ownership is explicit:

- The **release owner** assembles the manifest, verifies the candidate commit,
  and owns the tag/no-tag decision.
- The **security owner** attests the irreversible-action, approval, privacy, and
  shared-state hard blockers.
- The **eval owner** owns suite coverage, grader/calibration validity, held-out
  repetitions, and promoted regression inclusion.
- The **incident owner** validates a production failure, minimizes its initial
  state, preserves trace linkage, and records the privacy review before import.
- The **service owner** owns rollback readiness, production monitoring, and any
  residual-risk acceptance.

A residual risk may be accepted only when it is outside the six hard blockers,
names an accountable service owner, states scope and rationale, has an expiry,
defines a measurable rollback trigger, and links compensating evidence. Record
that acceptance beside the release manifest. It cannot override a blocked
manifest, incomplete trace, failed regression, or missing calibration authority.

Rollback is triggered by any post-release observation of a hard-blocker condition,
a promoted regression recurring, required trace health becoming incomplete,
the deployed package/manifest digest differing from the approved record,
rollback verification failing, or a residual-risk threshold/expiry being crossed.
The service owner starts rollback immediately; the release owner deprecates the
bad version and stops further promotion until a new clean manifest is approved.

## Manual publish (fallback)

If CI is unavailable, publish from a clean checkout:

```bash
npm ci
npm run check
npm login              # one-time, if not already authenticated
npm publish --dry-run  # preview the tarball contents
npm publish            # publish for real
```

## Roll back

```bash
npm deprecate "pi-flows@<version>" "<reason>"  # preferred — warns installers, keeps history
npm unpublish "pi-flows@<version>"             # only allowed within 72h of publishing
git push origin :refs/tags/v<version>          # delete a bad tag, then fix and re-tag
pi remove -l ./                                # remove a local install
```
