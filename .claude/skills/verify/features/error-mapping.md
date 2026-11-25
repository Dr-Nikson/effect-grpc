# Error mapping

A handler that fails with `GrpcException.create(code, message)` puts that status and message on the wire, over the gRPC, gRPC-web and Connect protocols, and the server keeps serving. Data that the handler attaches with `GrpcException.withData` travels with the status as one `google.protobuf.Value` detail, which clients print as JSON. A handler that dies with a defect answers `internal` with a fixed message, and a handler that runs past the client's deadline answers `deadline_exceeded`.

## Sub-features

- `err-grpc` returns code `failed_precondition`, message `Face the consequences!` and one `google.protobuf.Value` detail holding `{"name":"<name>","consequences":["no greeting"]}` for `FaceTheError` over gRPC.
- `err-grpc-web` returns the same code, message and detail over gRPC-web.
- `err-connect` returns HTTP 400 with the same code, message and detail in the Connect JSON body, where the detail's `debug` key holds the JSON.
- `err-handler` runs the handler. The server logs `faceTheError called, now you(<name>) will face the consequences!` and no line for the failure itself.
- `err-survives` keeps answering calls after the error.
- `err-defect` returns code `internal` and message `Internal server error` for `FaceTheDefect`, over gRPC and over Connect (HTTP 500). The defect's own text never reaches the client.
- `err-deadline` returns code `deadline_exceeded` for `GetGreetingSlowly` past a 200 ms deadline, over gRPC, gRPC-web and Connect (HTTP 504).

## How to get to it (user POV)

- Use the same clients as [unary-rpc.md](./unary-rpc.md), with the method `FaceTheError` or `FaceTheDefect`.
- For a deadline, a client sends `grpc-timeout` (gRPC and gRPC-web) or `connect-timeout-ms` (Connect) and calls `GetGreetingSlowly`, which answers after one second.
- From the generated Effect client: see `cli-error` in [effect-client.md](./effect-client.md).

## Driving it with control-example

Preconditions:

- `.claude/skills/verify/scripts/control-example launch` is running, and `.claude/skills/verify/scripts/control-example doctor` reports no FAIL.

- **gRPC error.** Run `.claude/skills/verify/scripts/control-example call grpc FaceTheError '{"name":"Ada"}'`. The result is `exit_code=72` and `grpc_status_code=9`. Stderr holds `"code": "failed_precondition"`, `"message": "Face the consequences!"` and one detail with `"type": "google.protobuf.Value"` whose `debug` is `{"consequences": ["no greeting"], "name": "Ada"}`. The server-log section has the `faceTheError called, now you(Ada)` line and nothing after it.
- **gRPC-web error.** Run `.claude/skills/verify/scripts/control-example call grpc-web FaceTheError '{"name":"Ada"}'`. The result is the same as the gRPC error, and the server-log line names `protocol: 'gRPC-web'`.
- **Connect error.** Run `.claude/skills/verify/scripts/control-example call connect FaceTheError '{"name":"Ada"}'`. The result is `exit_code=0` and `http_status=400`, with the body `{"code":"failed_precondition","message":"Face the consequences!","details":[{"type":"google.protobuf.Value","debug":{"name":"Ada","consequences":["no greeting"]},"value":"KjIKDQoEbmFtZRIFGgNBZGEKIQoMY29uc2VxdWVuY2VzEhEyDwoNGgtubyBncmVldGluZw"}]}`.
- **gRPC defect.** Run `.claude/skills/verify/scripts/control-example call grpc FaceTheDefect '{"name":"Ada"}'`. The result is `exit_code=104` and `grpc_status_code=13`, with `{"code": "internal", "message": "Internal server error"}` on stderr. Neither the response nor stderr contains `must never read`. The server-log section has the `faceTheDefect called, now you(Ada) will meet a bug!` line.
- **Connect defect.** Run `.claude/skills/verify/scripts/control-example call connect FaceTheDefect '{"name":"Ada"}'`. The result is `exit_code=0` and `http_status=500`, with the body `{"code":"internal","message":"Internal server error"}`.
- **Deadline.** Run `.claude/skills/verify/scripts/control-example deadline`. The result is `exit_code=0` and `verdict=PASS`, with one line per protocol: `grpc` and `grpc-web` with `"grpcStatus":4` and the message `the operation timed out`, and `connect` with `"httpStatus":504` and `"code":"deadline_exceeded"`. Each line's `ms` is close to 200. The server-log section has three `getGreetingSlowly called` lines.
- **Server survived.** Run `.claude/skills/verify/scripts/control-example call connect GetGreeting '{"name":"after-error"}'`. The result is `http_status=200` with the greeting. Then run `.claude/skills/verify/scripts/control-example doctor`, which reports the instance alive.
- **Proof.** Cite the `NN-grpc-FaceTheError.txt`, `NN-grpc-web-FaceTheError.txt`, `NN-connect-FaceTheError.txt`, `NN-grpc-FaceTheDefect.txt`, `NN-connect-FaceTheDefect.txt`, `NN-deadline.txt` and following `NN-connect-GetGreeting.txt` evidence files.

## Gotchas

- `buf curl` exits with 8 × the gRPC status code: `failed_precondition` (9) gives 72, `internal` (13) gives 104, and `unavailable` (14) gives 112. A non-zero exit is the expected result in this journey.
- Connect maps `failed_precondition` to HTTP 400, not 412, `internal` to 500 and `deadline_exceeded` to 504.
- A failed call leaves no log line of its own. Effect 3 logged `Fiber terminated with an unhandled error` at DEBUG for it, and Effect 4 does not log a failed fiber. A line with that text, or any ERROR line, in a server-log section is a regression. Confirm the server is up with `.claude/skills/verify/scripts/control-example doctor`.
- The generated Effect client gets this failure as a typed `GrpcException` with the code, the message and the data (see `cli-error` in [effect-client.md](./effect-client.md)).
- `buf curl` prints the detail's `debug` keys sorted for gRPC and gRPC-web and in the server's order for Connect. Compare the JSON, not the text.
- On a base without error data (issue #27), these calls carry no `details`, and the Connect body is `{"code":"failed_precondition","message":"Face the consequences!"}`.
- `buf curl` refuses a `grpc-timeout` header, and a client with its own timer, such as `buf curl --timeout` or the generated Effect client with `defaultTimeoutMs`, reports its own `deadline_exceeded` whatever the server sends. So `deadline` sends its calls from Node's HTTP/2 client, which keeps no timer, and each status it prints is the server's.
- On a base without the fix for issue #75, `deadline` prints `"grpcStatus":10` (`aborted`, `Request was canceled`) for gRPC and gRPC-web and `"httpStatus":409` with `"code":"aborted"` for Connect, and `verdict=FAIL`.
