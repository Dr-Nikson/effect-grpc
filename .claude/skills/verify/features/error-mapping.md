# Error mapping

A handler that fails with `GrpcException.create(code, message)` puts that status and message on the wire, over both the gRPC protocol and the Connect protocol, and the server keeps serving.

## Sub-features

- `err-grpc` returns code `failed_precondition` and message `Face the consequences!` for `FaceTheError` over gRPC.
- `err-connect` returns HTTP 400 with `{"code":"failed_precondition","message":"Face the consequences!"}` over Connect JSON.
- `err-handler` runs the handler. The server logs `faceTheError called, now you(<name>) will face the consequences!` and no line for the failure itself.
- `err-survives` keeps answering calls after the error.

## How to get to it (user POV)

- Use the same clients as [unary-rpc.md](./unary-rpc.md), with the method `FaceTheError`.
- From the generated Effect client: see `cli-error` in [effect-client.md](./effect-client.md).

## Driving it with control-example

Preconditions:

- `.claude/skills/verify/scripts/control-example launch` is running, and `.claude/skills/verify/scripts/control-example doctor` reports no FAIL.

- **gRPC error.** Run `.claude/skills/verify/scripts/control-example call grpc FaceTheError '{"name":"Ada"}'`. The result is `exit_code=72` and `grpc_status_code=9`, with `{"code": "failed_precondition", "message": "Face the consequences!"}` on stderr. The server-log section has the `faceTheError called, now you(Ada)` line and nothing after it.
- **Connect error.** Run `.claude/skills/verify/scripts/control-example call connect FaceTheError '{"name":"Ada"}'`. The result is `exit_code=0` and `http_status=400`, with the body `{"code":"failed_precondition","message":"Face the consequences!"}`.
- **Server survived.** Run `.claude/skills/verify/scripts/control-example call connect GetGreeting '{"name":"after-error"}'`. The result is `http_status=200` with the greeting. Then run `.claude/skills/verify/scripts/control-example doctor`, which reports the instance alive.
- **Proof.** Cite the `NN-grpc-FaceTheError.txt`, `NN-connect-FaceTheError.txt` and following `NN-connect-GetGreeting.txt` evidence files.

## Gotchas

- `buf curl` exits with 8 × the gRPC status code: `failed_precondition` (9) gives 72, and `unavailable` (14) gives 112. A non-zero exit is the expected result in this journey.
- Connect maps `failed_precondition` to HTTP 400, not 412.
- A failed call leaves no log line of its own. Effect 3 logged `Fiber terminated with an unhandled error` at DEBUG for it, and Effect 4 does not log a failed fiber. A line with that text, or any ERROR line, in a server-log section is a regression. Confirm the server is up with `.claude/skills/verify/scripts/control-example doctor`.
- The generated Effect client has no error channel (`Effect<Response>`), so this failure reaches the caller as a defect, not a typed failure (see `cli-error` in [effect-client.md](./effect-client.md)).
