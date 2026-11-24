---
"@dr_nikson/effect-grpc": major
---

Replace `GrpcServer.run` with `GrpcServer.listen`, which returns the address the server bound, fails when the server cannot listen, and stops when it is interrupted during startup (#57)

**Breaking.** `run` is gone, so every call to it fails to compile. `run` never returned: it told its caller nothing about the address it bound, waited forever when the port was taken, and could not be interrupted, so Ctrl+C did not stop the process. `listen` succeeds with a `GrpcServerAddress` (`host`, `port` and `url`) once the server listens, and the server serves until the scope that `listen` runs in closes. A program that only serves keeps the scope open after `listen`:

```ts
yield* server.listen({ host: "127.0.0.1", port: 8000 });
return yield* Effect.never;
```

A test that forked `run` and slept can call `listen` on port 0 and dial `address.url`.

**Breaking.** `listen` fails with `GrpcServerBindError` when the server cannot listen. Its `reason._tag` is `"AddressInUse"` (EADDRINUSE), `"PermissionDenied"` (EACCES or EPERM), `"InvalidPort"` (a port outside 0-65535) or `"Other"`, and `cause` holds the error Node reported. `reason` is an object with a `_tag`, so Effect 4's `Effect.catchReason` can match it.

Port 0 works. The OS picks a free port, `listen` returns it, and the ready line names it, as in `gRPC server listening on http://127.0.0.1:41234`. The ready line puts brackets around an IPv6 address, as in `http://[::1]:41234`.

Interrupting `listen` while the server starts, for example while a host name lookup hangs, ends the attempt, and the port is not bound later.
