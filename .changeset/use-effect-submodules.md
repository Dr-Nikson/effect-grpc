---
"@dr_nikson/effect-grpc": patch
---

Use Effect submodule imports instead of barrel imports in generated code

Generated code now imports from specific Effect submodules (e.g., `effect/Effect`, `effect/Context`) instead of the barrel import (`effect`). This improves tree-shaking and reduces bundle sizes.
