---
"@dr_nikson/effect-grpc": patch
---

Use `Layer.scoped` instead of `Layer.effect` for client layers (#45)

Generated client layers now use `Layer.scoped` instead of `Layer.effect` for proper resource lifecycle management. This removes the `Scope.Scope` requirement from the layer's dependencies, as the scope is now automatically provided and tied to the layer's lifetime. This also fixes Effect LSP warning TS13.
