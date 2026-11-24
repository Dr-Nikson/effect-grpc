---
---

Harden the snapshot and release workflows (#62). Only owners, members and collaborators can request a snapshot, tags are validated before the `npm-publish` approval, fork heads are refused, snapshots version in pre mode as `0.0.0-<tag>-<commit>`, the release jobs run only for pushes to `master` in this repository, and an empty changeset no longer stalls publishing.
