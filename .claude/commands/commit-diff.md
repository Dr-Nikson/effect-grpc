---
description: Run checks (lint, codestyle, build) and commit changes with meaningful message
allowed-tools: Bash(pnpm run codestyle:fix), Bash(pnpm run lint), Bash(pnpm -r run build), Bash(git status), Bash(git diff:*), Bash(git log:*), Bash(git add:*), Bash(git commit:*)
---

Please follow this workflow to commit the current changes:

1. Run all quality checks in sequence:
   - `pnpm run codestyle:fix` - Auto-fix code formatting
   - `pnpm run lint` - Check for linting errors
   - `pnpm -r run build` - Build all packages

2. If all checks pass:
   - Review the staged and unstaged changes using `git status` and `git diff`
   - Review recent commit messages using `git log --oneline -5` to understand the commit style
   - Generate a short, meaningful commit message that:
     - Starts with a lowercase verb (add, fix, update, refactor, etc.)
     - Summarizes the changes concisely
     - Follows the existing commit message style in this repository
   - Stage all changes with `git add .`


3. If any check fails:
   - Report which check failed and why
   - Do NOT commit
   - Provide guidance on how to fix the issues

IMPORTANT: Do not push to remote. Only commit locally.
