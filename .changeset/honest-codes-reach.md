---
"@dr_nikson/effect-grpc": patch
---

Send the right gRPC status for deadlines, cancels and dying finalizers, give each handler its HandlerContext, and name the call's protocol in the server's logs and spans (#75)

What a client of the server sees, compared with 3.0.0-alpha.5:

- A call whose deadline passes while its handler waits gets `DEADLINE_EXCEEDED` with the message `the operation timed out`, which is HTTP 504 on Connect. The same holds when the handler waits in `Effect.all`, `Effect.forEach` or `Effect.race`, and when one of its finalizers interrupts or dies. Each of these calls got `INTERNAL` with joined messages, such as `Unknown error; Request was canceled` repeated.
- The generated client enforces a deadline with its own timer only when the deadline comes from `defaultTimeoutMs`. Its caller now gets `DEADLINE_EXCEEDED` whether that timer fires first or the server's answer arrives first. A caller whose server answered first got `INTERNAL`.
- A client that cancels a call stops the handler as before, and the client reads nothing more from the stream. The status the server hands Connect for the call is now `CANCELLED`, also when a finalizer dies.
- A handler that fails with a `GrpcException` and also has a finalizer that dies sends the exception's code, message and data. It sent `INTERNAL`, with the exception's message followed by `; Internal server error`.
- A defect next to a dying finalizer sends `INTERNAL` with `Internal server error` once, where it joined two messages.
- A cause that holds two or more typed failures sends the first one's code, message and data. It sent `INTERNAL` with the messages joined, such as `first | second` for failures combined with `Cause.parallel`.
- Unchanged: a defect on its own, including one that is a `GrpcException` such as `Effect.orDie` makes, sends `INTERNAL` with `Internal server error`, and a handler that interrupts itself with nothing else failing sends `ABORTED`.

What a handler sees: on a server with no context transformer, each handler gets the call's Connect `HandlerContext`, and so does the first transformer as its current context. They got `undefined`, so a handler typed `HandlerContext` under the generated default tag, whose context type is `any`, died when it read it. `GrpcServerBuilder()` still starts at the type `unknown`.

What the server's telemetry says. This change leaves client spans as they were.

- The `protocol` log annotation names the protocol of the call: `gRPC`, `gRPC-web` or `Connect`. It said `gRPC` for every call.
- The server span has the span kind `SERVER` and the client's attribute names: `rpc.system` (`grpc`, or `connect_rpc` for a Connect call), `rpc.service` and `rpc.method`, next to `protocol`. The `method` attribute is gone, so a dashboard that reads it reads `rpc.service` and `rpc.method` now. Span names do not change.

Known limitations: a deadline interrupts a handler only while the handler waits on something asynchronous, such as a promise or a timer. A handler that runs synchronous code past its deadline and then finishes answers normally, even after `Effect.yieldNow`, and so does a handler that starts after its deadline and finishes without waiting. A cause of two or more defects whose first defect is a `GrpcException` sends that exception's code, message and data, because Effect 4 gives a typed failure whose finalizer died the same shape.
