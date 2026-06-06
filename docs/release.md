# Release checklist

1. Update `CHANGELOG.md` under `Unreleased`.
2. Decide version bump and update `package.json`.
3. Move changelog notes into a dated version section.
4. Run:

   ```bash
   npm ci
   npm run check
   ```

5. Smoke the local package:

   ```bash
   pi install -l ./
   ```

   Then in pi:

   ```text
   /reload
   /flows version
   Use flow with {"list":true}
   Use flow with {"showConfig":true}
   ```

6. Verify package contents:

   ```bash
   npm run pack:dry-run
   ```

7. Publish to npm — this is what lists pi-flows in the [pi.dev gallery](https://pi.dev/packages):

   ```bash
   npm login              # one-time, if not already authenticated
   npm publish --dry-run  # preview the tarball contents
   npm publish            # publish for real
   ```

8. Tag the release and push it, so git-install users get the same version:

   ```bash
   git tag "v$(node -p "require('./package.json').version")"
   git push origin main --tags
   ```

9. Roll back if needed:

   ```bash
   npm unpublish pi-flows@<version>         # npm allows this only within 72h of publishing
   pi remove -l ./                          # remove a local install
   git push origin :refs/tags/v<version>    # delete a bad tag, then fix and re-tag
   ```
