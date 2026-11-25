---
---

Harden the snapshot and release workflows (#62). Only owners, members and collaborators can request a snapshot, tags are validated before the `npm-publish` approval, and fork heads are refused. A snapshot cannot take the `latest`, `alpha`, `beta`, `rc`, `effect-v3`, or `effect-v4` tag. In pre mode, a snapshot version is `<version>-0.<tag>.<commit>`, which sorts below every alpha, beta, and rc of that version. The release jobs run only for pushes to `master` in this repository, and a changeset with blank frontmatter no longer stalls publishing.
