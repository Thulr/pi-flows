# Release checklist

Releases publish to npm from CI. A pushed `vX.Y.Z` tag runs
[`.github/workflows/publish.yml`](../../.github/workflows/publish.yml), which runs
`npm run check` and then `npm publish` (with provenance). The npm publish is
what lists pi-flows in the [pi.dev gallery](https://pi.dev/packages).

**One-time setup:** configure npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)
for the package. No token or secret is required. On npmjs.com, open the **pi-flows**
package → **Settings → Trusted Publisher → GitHub Actions**. Then enter:

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
   `extensions/pi-flows/types.ts`. If the tag does not match `package.json`,
   the publish workflow fails.
3. Make sure that the checks pass locally:

   ```bash
   npm ci
   npm run check
   ```

4. Run the pre-production release evaluation with complete runtime evidence.
   If a controlled production-failure ledger exists, include it:

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

   The release suite pass-gates behavior cases and every imported production
   regression. Hard headroom cases remain score-tracked by the regular internal
   eval suite. Expected partial scores are not shown as failed verified
   outcomes in the release manifest.

5. Smoke the local package in pi:

   ```bash
   pi install -l ..
   ```

   ```text
   /reload
   /flows version
   Use flow with {"list":true}
   Use flow with {"showConfig":true}
   ```

6. Commit with a [Conventional Commit](../../CONTRIBUTING.md#commit-messages), open
   a PR, and merge to `main`.
7. Check out the clean merge commit. Run the release evaluation and decision
   against that exact commit in one command. An `approved` decision is
   required before you tag:

   ```bash
   npm run eval:release -- --run --run-id="release-<version>" --attest-hard-blockers
   ```

   `--run` generates a single-use attestation token, hands it to the evaluation
   it starts, and throws it away. As a result, the artifacts it decides from
   can come only from that run. It writes them under `.thulr/runs/<run-id>.*`
   and derives the evidence object from the provenance of the reliability
   artifact. Pass `--attest-hard-blockers` only after the six hard blockers
   below are attested. Without the flag, the decision blocks as `not-attested`.
   See [Release evidence and manifest](#release-evidence-and-manifest) for the
   artifact-based mode and the full list of what the gate checks.
8. Tag the merge commit and push the tag. This push triggers the **Publish**
   workflow:

   ```bash
   tag="v$(node -p "require('./package.json').version")"
   git tag "$tag"
   git push origin "$tag"
   ```

9. Make sure that the **Publish** workflow is green, that `npm view pi-flows version`
   shows the new version, and that `pi install npm:pi-flows` resolves it.

## Release evidence and manifest

`eval:release` has two modes. `--run` (step 7 above) runs the evaluation and
decides from it in one command. It derives the evidence object from the
provenance record of the reliability artifact. The default mode decides from
artifacts already on disk and requires an operator-written evidence file. That
mode reads its attestation key from `PI_FLOWS_EVAL_ATTESTATION_KEY`, which
exists for tests and for a new decision on a run whose token you still hold.

Derived evidence is not a weaker check. The gate cross-checks every provenance
field — `models`, `topology`, `budgets`, `suite`, `grader` — against that same
reliability record. Hand-transcribed fields can only introduce a mismatch,
never add assurance. The hard blockers are the one part that no artifact can
supply, and they stay an explicit operator assertion. `--run` records
`not-attested` unless you pass `--attest-hard-blockers`.

The release owner prepares a minimized `pi-flows.release-evidence.v1` JSON
attestation. It names:

- the eval run and the evaluated time
- every subject and judge model
- the exact evaluated Git commit
- the topology and budgets used
- the suite and case ids
- the grader and its version
- all six hard-blocker results

Each hard blocker must be `status:"passed"` and must carry at least one
non-empty attributable string reference:

- `unauthorizedIrreversibleActions`
- `approvalBypass`
- `secretOrPersonalDataLeakage`
- `corruptedSharedState`
- `rollbackFailure`
- `requiredTraceLoss`

Missing evidence is a failure, not a warning. The command also blocks on:

- a dirty tree
- version disagreement
- any failed, excluded, or unverified trial
- incomplete runtime traces
- incomplete or blocking calibration
- a critical dimension without authority
- a declared suite that differs from the measured reliability cases
- a promoted regression that is absent from the reliability artifact

The supplied runtime trace path must equal `reliability.runtimeTraceFile`. The
exact trace and root-span link of every trial, and its run/case/trial
attributes, must resolve in that file. The read-back also applies the strict
trace-tree gate to declared and observed span counts, failed exports,
malformed or duplicate rows, parentage, timing, and dependency links.

The reliability artifact records the actual subject models, the per-case
topology and budget configuration, the environment, the repository hashes, and
the clean-tree state at evaluation time. Release evals isolate discovery to
the package-owned prompts whose hashes enter the manifest. The release command
requires the current checkout, and every operator-declared model, topology,
budget, suite, and grader field, to match that recorded provenance exactly.
These fields are not trusted as standalone assertions.

Calibration artifacts keep their blocking decision and issues. They require a
complete self-verifying calibration key, all versioned splits, coverage,
statistics, and review evidence, and the release-critical `criterion`
dimension. The release command recomputes the calibration gate from that
evidence. It requires the key, the gate, and the artifact hash to match the
reliability run — a copied or skeletal nonblocking assertion cannot approve. A
current, complete recalibration can record that the prior key was unknown or
stale. The gate then reads the newly computed evidence, and does not treat old
drift as a current failure.

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
artifact's `evaluation` object. Then add the independently owned hard-blocker
references. Any edit or substitution blocks the release.

In the artifact-based mode, the release record requires the same
operator-controlled `PI_FLOWS_EVAL_ATTESTATION_KEY` that authenticated the
reliability run. Keep it in the release secret store, never in an artifact or
the repository. `--run` needs no such secret: its token is generated per
invocation and never leaves the process tree.

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

- the evaluation-time Git commit and the clean-tree status
- the package, extension, lockfile, and package manager versions, cross-checked
  against the release checkout
- per-agent and aggregate prompt hashes, the TypeBox tool-schema hash, and
  topology, harness, and suite hashes
- subject/judge model ids, topology, budgets, safe environment identity, suite,
  harness, grader, and calibration versions
- hashes of the reliability, calibration, runtime-trace, and required canonical
  production-failure ledger artifacts (if no failures were imported, use an
  empty file). The ledger's hash, head, imported-case bindings, and promoted
  ids must match the ledger used during evaluation. Runtime-trace and ledger
  hashes must also equal the exact bytes that their validators read
- the complete hard-blocker decision plus a digest of the manifest itself

Store the record and its referenced artifacts together in access-controlled,
append-only release evidence storage. They are generated evaluation artifacts
and must not be committed or packaged.

## Evidence ownership and lifecycle

Evidence has three layers. No layer substitutes for another:

1. **Runtime evidence** comes from each flow. It attributes dispatch,
   handoffs, approvals, state, policy, and outcomes for that exact run.
2. **Pre-production evidence** repeats the release suite on the candidate
   commit. It judges outcomes, makes sure that traces are complete and that
   calibration has authority, and exercises every promoted production
   regression.
3. **Production evidence** is monitoring and incident evidence from the
   deployed version. It can trigger rollback and seed a minimized capability
   case, but it cannot retroactively make a missing pre-production check pass.

Ownership is explicit:

- The **release owner** assembles the manifest, makes sure that the candidate
  commit is the evaluated one, and owns the tag/no-tag decision.
- The **security owner** attests the irreversible-action, approval, privacy, and
  shared-state hard blockers.
- The **eval owner** owns suite coverage, grader/calibration validity, held-out
  repetitions, and promoted regression inclusion.
- The **incident owner** validates a production failure, minimizes its initial
  state, preserves trace linkage, and records the privacy review before import.
- The **service owner** owns rollback readiness, production monitoring, and any
  residual-risk acceptance.

A residual risk can be accepted only when it:

- is outside the six hard blockers
- names an accountable service owner
- states its scope and rationale
- has an expiry
- defines a measurable rollback trigger
- links compensating evidence

Record that acceptance beside the release manifest. The acceptance cannot
override a blocked manifest, an incomplete trace, a failed regression, or
missing calibration authority.

Any of these post-release observations triggers rollback:

- a hard-blocker condition
- a promoted regression that recurs
- required trace health that becomes incomplete
- a deployed package or manifest digest that differs from the approved record
- a rollback check that fails
- a residual-risk threshold or expiry that is crossed

The service owner starts the rollback immediately. The release owner
deprecates the bad version and stops further promotion until a new clean
manifest is approved.

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
