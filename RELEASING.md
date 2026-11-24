# Release Process

This document describes how to release new versions of `@dr_nikson/effect-grpc` using changesets.

## Overview

This project uses [Changesets](https://github.com/changesets/changesets) to manage versioning and publishing. The workflow is semi-automated:
- Developers create changeset files during development
- CI automatically creates/updates a "Version Packages" PR
- Maintainers review and merge the PR to publish

## Development Workflow

### 1. Making Changes

When you make changes that should be included in a release, create a changeset:

```bash
pnpm changeset
```

This will prompt you to:
1. Select which packages changed (only `@dr_nikson/effect-grpc` is published)
2. Choose the version bump type:
   - **patch** (0.1.0 → 0.1.1) - Bug fixes, documentation updates
   - **minor** (0.1.0 → 0.2.0) - New features, backwards compatible
   - **major** (0.1.0 → 1.0.0) - Breaking changes
3. Write a summary (this becomes the changelog entry)

**Example:**
```bash
$ pnpm changeset
🦋  Which packages would you like to include?
› ◉ @dr_nikson/effect-grpc

🦋  What kind of change is this for @dr_nikson/effect-grpc?
  ● minor

🦋  Please enter a summary:
│ Add support for streaming RPCs with backpressure handling
```

This creates a file in `.changeset/` directory (e.g., `.changeset/brave-tigers-smile.md`).

### 2. Editing Changeset Files

You can manually edit the generated changeset file to add more context:

```md
---
"@dr_nikson/effect-grpc": minor
---

Add support for streaming RPCs with backpressure handling

This introduces three new stream types:
- `ClientStream` for client-side streaming
- `ServerStream` for server-side streaming
- `BidirectionalStream` for full-duplex streaming

All streams properly handle backpressure through Effect's Stream API.
```

### 3. Committing Changes

Commit the changeset file along with your code changes:

```bash
git add .changeset/brave-tigers-smile.md
git commit -m "feat: add streaming RPC support"
```

### 4. Creating a Pull Request

Create a PR as usual. The changeset file will be reviewed along with your code.

## Release Workflow (Maintainers Only)

### Automated Process

1. **After PR Merge**: When a PR with changesets is merged to `master`, GitHub Actions automatically:
   - Detects the changeset files
   - Opens/updates a PR titled **"chore: version packages"**
   - This PR contains:
     - Updated `package.json` versions
     - Updated `CHANGELOG.md` files
     - Removed changeset files

2. **Review Version PR**: Review the "Version Packages" PR:
   - Check version bumps are correct
   - Review generated changelog
   - Edit changelog if needed (you can pull the branch and edit manually)

3. **Publish**: Merge the "Version Packages" PR:
   - GitHub Actions automatically publishes to npm
   - Creates Git tags (e.g., `@dr_nikson/effect-grpc@0.2.0`)
   - Creates GitHub releases with changelog

### Move `latest` after the first 4.x publish

The repository is in pre mode with the tag `alpha` (see `.changeset/pre.json`), so `changeset publish` publishes each version under `alpha` and does not move `latest`. `latest` points to `3.0.0-alpha.5`, the Effect 3 build, until someone moves it. The install line in `README.md` names the package without a version, so npm resolves the version that `latest` points to.

After the release workflow publishes `4.0.0-alpha.0`, move `latest` to it:

```bash
npm dist-tag add @dr_nikson/effect-grpc@4.0.0-alpha.0 latest
```

Run the command with an npm account that can publish the package. Later 4.x alphas also publish under `alpha`, so `latest` stays on `4.0.0-alpha.0` until someone moves it again.

The release workflow does not run `npm dist-tag`, so this step is manual. For CI to move a tag with trusted publishing, the package's trusted publisher settings on npmjs.com need **Allow npm dist-tag**, which is off by default, and the job needs npm 11.21.0 or later on npm 11, or 12.2.0 or later on npm 12.

### Manual Release (if needed)

If you need to release manually:

```bash
# 1. Ensure you're on master and up to date
git checkout master
git pull

# 2. Update versions and changelogs
pnpm changeset:version

# 3. Review changes
git diff

# 4. Commit version changes
git add .
git commit -m "chore: version packages"

# 5. Build and publish
pnpm release

# 6. Push changes and tags
git push --follow-tags
```

## Beta/Pre-release Workflow

For testing changes before stable release, use pre-release mode.

### 1. Enter Pre-release Mode

```bash
# Enter beta mode
pnpm changeset:pre:enter beta

# Commit the pre-release state
git add .changeset/pre.json
git commit -m "chore: enter beta pre-release mode"
git push
```

### 2. Create Changesets and Release Beta Versions

```bash
# Create changesets as normal
pnpm changeset

# Commit and push
git commit -m "feat: new beta feature"
git push
```

After merge, the "Version Packages" PR will create versions like:
- `0.2.0-beta.0`
- `0.2.0-beta.1`
- etc.

Users can install beta versions:
```bash
pnpm add @dr_nikson/effect-grpc@beta
```

### 3. Exit Pre-release Mode

When ready for stable release:

```bash
# Exit pre-release mode
pnpm changeset:pre:exit

# Commit the state
git add .changeset/pre.json
git commit -m "chore: exit beta pre-release mode"
git push
```

The next "Version Packages" PR will create the stable version (e.g., `0.2.0`).

## Snapshot Releases (Testing Unreleased Changes)

For testing changes in consuming projects before official release.

A snapshot version has the form `<version>-0.<tag>.<commit sha>`, for example `3.0.0-0.pr-123.<commit sha>`. The `<version>` part is the version that the pending changesets would release outside pre mode, such as `3.0.0` while the package is at `3.0.0-alpha.5`. The `0` sorts a snapshot below every `alpha`, `beta`, and `rc` of that version, so a range such as `^3.0.0-alpha.5` does not match a snapshot from this workflow. A range that starts at `-0`, such as `^3.0.0-0`, does match it. Two older snapshots from an earlier version of this workflow, `3.0.0-mvp-87283f517fd15c8199f5ba251bf74e2503cd0baf` and `3.0.0-mvp-e2b78b1c4be4bb339577d68dfce008ef1b56218c`, do match `^3.0.0-alpha.5`. Install a snapshot by its tag or by its exact version:

```bash
pnpm add @dr_nikson/effect-grpc@pr-123
```

### PR Snapshots

An owner, member or collaborator of the repository comments on a pull request. The command is the first line of the comment:

- `/snapshot` publishes under the tag `pr-<number>`.
- `/snapshot <tag>` publishes under `<tag>`.

The Snapshot Release workflow then:

1. Ignores the comment when the account is not an owner, member or collaborator.
2. Refuses a tag that is not 1 to 32 lowercase letters, digits and single hyphens starting with a letter. It also refuses the release channel tags `latest`, `alpha`, `beta`, `rc`, `effect-v3`, and `effect-v4`, because a snapshot must not move a channel. It refuses every tag that npm reads as a version range, such as `x`, `v1`, or `vv10`, because npm refuses to publish under a range tag.
3. Refuses a pull request whose head lives in a fork.
4. Requires a successful Typescript CI push run for the head commit, with its build artifact.
5. Waits for approval of the `npm-publish` environment, publishes, and replies on the pull request. If the snapshot version does not end in `-0.<tag>.<commit sha>`, the version step fails and nothing is published. A branch whose `.changeset/config.json` lacks the snapshot settings fails at that step after the approval, so merge `master` into the branch first.

### Manual Snapshot from a Branch

Run **Actions → Snapshot Release → Run workflow**, pick the branch, and enter a tag. The same tag rule and CI check apply. The workflow and its scripts come from the branch that you pick, so a branch from before the tag rule and the version check runs the old ones.

### Local Snapshot

To preview the version of a snapshot, work in a scratch clone and never commit the result. `changeset version --snapshot` refuses to run in pre mode, so leave pre mode first. Set `GITHUB_TOKEN` for the changelog generator:

```bash
pnpm install --frozen-lockfile
pnpm changeset pre exit
pnpm changeset version --snapshot pr-123
```

`packages/effect-grpc/package.json` then holds a version such as `3.0.0-0.pr-123.<commit sha>`. Publish through the Snapshot Release workflow. The package sets `provenance: true`. npm refuses to generate provenance outside GitHub Actions and GitLab CI, so a publish from your machine fails.

## Package Configuration

### What Gets Published

Only `@dr_nikson/effect-grpc` is published to npm. The `example` package is ignored (configured in `.changeset/config.json`).

Published files (from `package.json` `files` field):
- `dist/` - Compiled TypeScript output
- `bin/` - CLI executables (protoc-gen-effect)

### Publishing Configuration

The package is published with:
- **Public access** - Anyone can install from npm
- **Provenance** - npm package provenance for security/supply chain verification
- **Node.js 22.19+** - Minimum supported version

## Scripts Reference

```bash
# Create a changeset
pnpm changeset

# Update versions and changelogs (automated in CI)
pnpm changeset:version

# Publish to npm (automated in CI)
pnpm changeset:publish

# Enter pre-release mode
pnpm changeset:pre:enter <tag>  # e.g., beta, rc, alpha

# Exit pre-release mode
pnpm changeset:pre:exit

# Full release with validation (manual use)
pnpm release
```

## Troubleshooting

### "No changesets found"

If CI complains about missing changesets:
- Run `pnpm changeset` to create one
- Or add `[skip ci]` to commit message if change doesn't need release

### Version PR not created

Check:
1. Changeset files exist in `.changeset/` directory
2. Changeset files were merged to `master` branch
3. GitHub Actions workflow ran successfully
4. `NPM_TOKEN` secret is configured

### Publishing fails

Ensure:
1. `NPM_TOKEN` secret is set in GitHub repository settings
2. Token has publish permissions for `@dr_nikson` scope
3. You're logged into npm with correct account

### Pre-release mode stuck

If you can't exit pre-release mode:
```bash
# Manually remove pre-release state
rm .changeset/pre.json
git add .changeset/pre.json
git commit -m "chore: force exit pre-release mode"
```

## Resources

- [Changesets Documentation](https://github.com/changesets/changesets)
- [Semantic Versioning](https://semver.org/)
- [Effect-TS Release Process](https://github.com/Effect-TS/effect) (similar workflow)