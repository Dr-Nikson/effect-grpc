# Changesets: Non-Interactive Usage for AI Agents

This document explains how to create changesets programmatically without using the interactive CLI.

## Why Non-Interactive?

The `changeset add` command requires interactive prompts and does not support non-interactive mode. To create changesets programmatically, you must manually write the changeset files.

## Changeset File Format

Changesets are markdown files stored in `.changeset/` with YAML frontmatter:

```markdown
---
"@dr_nikson/effect-grpc": patch
---

Fix duplicate suffix in generated service names
```

**Structure:**
- **Frontmatter**: Package name(s) mapped to bump type (`major`, `minor`, `patch`)
- **Body**: Changelog description in markdown

**Multiple packages:**
```markdown
---
"@dr_nikson/effect-grpc": minor
"@dr_nikson/some-other-package": patch
---

Add feature X with related utility updates
```

## File Naming

Use lowercase words separated by hyphens: `{adjective}-{noun}-{verb}.md`

Examples: `sharp-pots-ring.md`, `spicy-rivers-chew.md`, `calm-doors-swim.md`

Any unique name works. Keep it short and lowercase.

## Creating a Changeset

1. **Determine the package name** - Check `packages/*/package.json` for the `name` field
2. **Determine bump type**:
   - `major` - Breaking changes (API changes, removed features)
   - `minor` - New features (backwards compatible)
   - `patch` - Bug fixes, docs, refactoring
3. **Write a clear description** - Explain what changed and why
4. **Create the file** in `.changeset/` directory

**Example:**
```
File: .changeset/fix-naming-bug.md

---
"@dr_nikson/effect-grpc": patch
---

Fix duplicate suffix in generated service names when proto service already ends with "Service"
```

## Project-Specific Rules

**Packages that need changesets:**
- `@dr_nikson/effect-grpc` - The main library

**Packages excluded from versioning** (no changesets needed):
- `@dr_nikson/effect-grpc-example`
- `@dr_nikson/effect-grpc-e2e-tests`

## Writing Good Descriptions

**Do:**
- Explain what the change does
- Mention breaking changes explicitly
- Reference issue numbers when applicable

**Don't:**
- Write vague descriptions like "fix bug" or "update code"
- Include implementation details irrelevant to users

**Good:**
```markdown
Fix duplicate suffix in generated service names (#30)

Services ending with "Service" no longer produce names like "HelloWorldServiceService".
```

**Bad:**
```markdown
Fix bug
```

## When to Create Changesets

**Important:** Create the changeset as part of the final commit for a feature or fix. The changeset file should be committed together with the code changes.

Create a changeset when:
- Fixing a bug in `@dr_nikson/effect-grpc`
- Adding a new feature
- Making breaking changes
- Changing public API behavior

Skip changesets for:
- Changes only to example or e2e-tests packages
- Internal refactoring with no user-facing impact
- Documentation-only changes in non-published files
