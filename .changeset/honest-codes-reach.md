---
"@dr_nikson/effect-grpc": patch
---

Send the right gRPC status for deadlines, cancels and dying finalizers, give each handler its HandlerContext, and name the call's protocol in the server's logs and spans (#75)

What a client of the server sees:

- A call whose deadline passes while its handler runs gets `DEADLINE_EXCEEDED` with the message `the operation timed out`. It got `ABORTED` with `Request was canceled`, which is HTTP 409 on Connect where it is now 504. A client that enforces the deadline with its own timer, as the generated client does, reports `DEADLINE_EXCEEDED` from that timer, as before.
- A client that cancels a call stops the handler as before. The status the server hands Connect for the call is now `CANCELLED`, not `ABORTED`. The client reads nothing more from the stream either way.
- A handler that fails with a `GrpcException` and also has a finalizer that dies sends the exception's code and message. It sent `INTERNAL` with `Internal server error; Internal server error`, because Effect 4 reports such a failure as a defect.
- A deadline or a cancel that interrupts a handler whose finalizer dies sends `DEADLINE_EXCEEDED` or `CANCELLED`. A defect next to a dying finalizer sends `INTERNAL` with `Internal server error` once. Both joined two messages before.
- A cause that holds two typed failures sends the first one's code and message. It sent `INTERNAL` with both messages joined by `; `.
- Unchanged: a defect, including one that is a `GrpcException` such as `Effect.orDie` makes, sends `INTERNAL` with `Internal server error`, and a handler that interrupts itself sends `ABORTED`.

What a handler sees: on a server with no context transformer, each handler gets the call's Connect `HandlerContext`, and so does the first transformer as its current context. They got `undefined`, so a handler typed `HandlerContext` under the generated default tag, whose context type is `any`, died when it read it. `GrpcServerBuilder()` still starts at the type `unknown`.

What the server's telemetry says. Client spans do not change.

- The `protocol` log annotation names the protocol of the call: `gRPC`, `gRPC-web` or `Connect`. It said `gRPC` for every call.
- The server span has the span kind `SERVER` and the client's attribute names: `rpc.system` (`grpc`, or `connect_rpc` for a Connect call), `rpc.service` and `rpc.method`, next to `protocol`. The `method` attribute is gone, so a dashboard that reads it reads `rpc.service` and `rpc.method` now. Span names do not change.

Known limitations: a handler that completes without yielding answers normally even when the call's deadline had already passed when it started, because Effect 4 reads the abort signal only after such a run. A defect that is a `GrpcException` next to a second defect sends that exception's status, because Effect 4 gives it the same shape as a typed failure whose finalizer died.
