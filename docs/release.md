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

4. Smoke the local package in pi:

   ```bash
   pi install -l ./
   ```

   ```text
   /reload
   /flows version
   Use flow with {"list":true}
   Use flow with {"showConfig":true}
   ```

5. Commit with a [Conventional Commit](../CONTRIBUTING.md#commit-messages), open
   a PR, and merge to `main`.
6. Tag the merge commit and push the tag — this triggers the **Publish**
   workflow:

   ```bash
   tag="v$(node -p "require('./package.json').version")"
   git tag "$tag"
   git push origin "$tag"
   ```

7. Confirm: the **Publish** workflow is green, `npm view pi-flows version` shows
   the new version, and `pi install npm:pi-flows` resolves it.

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
