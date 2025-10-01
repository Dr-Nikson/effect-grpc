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

For testing changes in consuming projects before official release:

### Manual Snapshot

```bash
# Create a snapshot version
pnpm changeset version --snapshot pr-123

# This creates versions like: 0.0.0-pr-123-20250930123456

# Publish with snapshot tag
pnpm changeset publish --tag snapshot
```

Users can test the snapshot:
```bash
pnpm add @dr_nikson/effect-grpc@snapshot
```

### Automated PR Snapshots

Add a `snapshot` label to any PR to trigger automatic snapshot publishing:
1. Label the PR with `snapshot`
2. GitHub Actions automatically publishes a snapshot version
3. Use the snapshot version for testing

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
- **Node.js 22+** - Minimum supported version

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