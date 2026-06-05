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

7. Tag the release and push it. Users install via `pi install git:github.com/Thulr/pi-flows`, so the tag is the release:

   ```bash
   git tag "v$(node -p "require('./package.json').version")"
   git push origin main --tags
   ```

8. Roll back if needed:

   ```bash
   pi remove -l ./                          # remove a local install
   git push origin :refs/tags/v<version>    # delete a bad tag, then fix and re-tag
   ```
