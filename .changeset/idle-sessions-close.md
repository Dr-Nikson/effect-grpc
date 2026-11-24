---
"@dr_nikson/effect-grpc": patch
---

Stop the server in bounded time on Node 22 while clients keep idle connections open, and show a wiring that stops it before the layers that its handlers use (#101)

When the scope that `listen` runs in closes, the server sends each client an HTTP/2 GOAWAY, lets the calls in flight finish, and closes each connection once its calls end, an idle one at once. Node 24 already did this. On Node 22, the supported floor, the server waited for every client to disconnect. A client that kept its connection open, as the generated client and connect-node clients do, kept the shutdown from finishing, and the server kept serving new calls on that connection after the shutdown began. Both versions now behave the same.

The README Quick Start and the example now run the server as a layer, `Layer.effectDiscard` over `listen`, under `Layer.launch`. Effect then releases the layers that the handlers use only after the server stops. A program written as `Effect.provide(program, layer).pipe(Effect.scoped)` releases those layers first, so a call in flight at Ctrl+C or SIGTERM runs against closed resources. To get the right order, use `Layer.launch`, as the Quick Start now shows, or `program.pipe(Effect.scoped, Effect.provide(layer))`.

Known limitations, on every Node version: a call whose handler never finishes, and a client that never reads from its connection, still keep the shutdown from finishing (#73). Another known limitation: a call that reaches the server just after the server sent its GOAWAY gets `INTERNAL` on a connect-node client instead of `UNAVAILABLE`. Such a call leaves the client before the GOAWAY arrives, so the window is about one round trip per shutdown. The handler never ran, so a retry is safe. Node 24 behaved this way before this change.
