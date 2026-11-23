# Error mapping

A handler that fails with `GrpcException.create(code, message)` puts that status and message on the wire, over both the gRPC protocol and the Connect protocol, and the server keeps serving.

## Sub-features

- `err-grpc` returns code `failed_precondition` and message `Face the consequences!` for `FaceTheError` over gRPC.
- `err-connect` returns HTTP 400 with `{"code":"failed_precondition","message":"Face the consequences!"}` over Connect JSON.
- `err-handler` runs the handler and logs the exception. The server logs `faceTheError called, now you(<name>) will face the consequences!`, followed by the `GrpcException` at DEBUG.
- `err-survives` keeps answering calls after the error.

## How to get to it (user POV)

- Use the same clients as [unary-rpc.md](./unary-rpc.md), with the method `FaceTheError`.
- From the generated Effect client: see `cli-error` in [effect-client.md](./effect-client.md).

## Driving it with control-example

Preconditions:

- `$C launch` is running, and `$C doctor` reports no FAIL.

- **gRPC error.** Run `$C call grpc FaceTheError '{"name":"Ada"}'`. The result is `exit_code=72` and `grpc_status_code=9`, with `{"code": "failed_precondition", "message": "Face the consequences!"}` on stderr. The server-log section has the `faceTheError called, now you(Ada)` line.
- **Connect error.** Run `$C call connect FaceTheError '{"name":"Ada"}'`. The result is `exit_code=0` and `http_status=400`, with the body `{"code":"failed_precondition","message":"Face the consequences!"}`.
- **Server survived.** Run `$C call connect GetGreeting '{"name":"after-error"}'`. The result is `http_status=200` with the greeting. Then run `$C doctor`, which reports the instance alive.
- **Proof.** Cite the `NN-grpc-FaceTheError.txt`, `NN-connect-FaceTheError.txt` and following `NN-connect-GetGreeting.txt` evidence files.

## Gotchas

- `buf curl` exits with 8 × the gRPC status code: `failed_precondition` (9) gives 72, and `unavailable` (14) gives 112. A non-zero exit is the expected result in this journey.
- Connect maps `failed_precondition` to HTTP 400, not 412.
- The DEBUG line `Fiber terminated with an unhandled error` is the normal log for a typed failure, not a crash. Confirm with `$C doctor`.
- The generated Effect client has no error channel (`Effect<Response>`), so this failure reaches the caller as a defect, not a typed failure (see `cli-error` in [effect-client.md](./effect-client.md)).
