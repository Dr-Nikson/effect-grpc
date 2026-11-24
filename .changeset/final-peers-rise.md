---
"@dr_nikson/effect-grpc": major
---

Require `effect` 3.22.5 or later, the last release of Effect 3 (#66)

**Breaking.** The peer range of `effect` is now `^3.22.5` (it was `^3.19.15`). Upgrade `effect` before you upgrade this library. The library API does not change. Its tests now run on `effect` 3.22.5, which is the version this range names.

Effect 3.22.4 changed how a cause serializes. `Cause.Fail` now appears under `error` instead of `failure` in `toJSON`, `JSON.stringify` and Node's inspection of a cause or an exit. If your code reads `failure` from a serialized cause, read `error` instead. The library itself never serializes a cause.
