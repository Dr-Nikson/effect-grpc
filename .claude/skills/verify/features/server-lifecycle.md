# Server lifecycle

A user builds a server with `EffectGrpcServer.GrpcServerBuilder().withService(…).build()` and calls `listen({ host, port })`, which returns the address the server bound. The server logs when it is ready, serves gRPC and Connect over cleartext HTTP/2, survives hostile requests, fails fast when its port is taken, and shuts down gracefully on SIGTERM or Ctrl+C.

## Sub-features

- `srv-ready` logs `gRPC server listening on http://<host>:<port>` with the port it bound, which for port 0 is the port the OS picked, and brackets an IPv6 host, as in `http://[::1]:<port>`. Then it answers RPCs on that port.
- `srv-taken-port` exits within a few seconds when its port is taken, with an error that names `EADDRINUSE` and the reason `AddressInUse`, and the server that holds the port keeps serving.
- `srv-h2c` accepts only HTTP/2 with prior knowledge, and rejects HTTP/1.1 clients.
- `srv-unknown` answers an unknown method with HTTP 404 over Connect.
- `srv-shutdown` responds to SIGTERM: it logs `gRPC server is stopping...` and then `gRPC server stopped`, exits with code 0, and frees its port.
- `srv-hostile-authority` serves a request whose `:authority` is an IPv6 address and a port without brackets, the form Node's HTTP/2 client sends for `http://[::1]:<port>`. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`, and it keeps running after every case, including a 10 KiB authority.
- `srv-message-limit` serves a request message of exactly 4 MiB, answers a larger one with `RESOURCE_EXHAUSTED`, and keeps running. Once it has answered, it resets the rest of that upload with `NO_ERROR`, so a client that keeps sending stops, and shutdown does not wait for it.

## How to get to it (user POV)

- Run `node dist/server.js` from `packages/example`, as in the README's "Complete Example". It listens on `127.0.0.1:8000`. `EFFECT_GRPC_EXAMPLE_HOST=::1` binds `::1` instead, and `EFFECT_GRPC_EXAMPLE_PORT` sets the port. `EFFECT_GRPC_EXAMPLE_PORT=0` lets the OS pick the port, and the ready line names it.
- Stop the server with Ctrl+C or SIGTERM.

## Driving it with control-example

Preconditions:

- `.claude/skills/verify/scripts/control-example build` succeeded.

- **Launch.** Run `.claude/skills/verify/scripts/control-example launch`. It prints `launched: pid=<pid> port=<port> listening on: 127.0.0.1`, where `<port>` is the port the OS picked. The evidence `server.log` has the ready line `gRPC server listening on http://127.0.0.1:<port>` with the same port, and `01-readiness.txt` shows `port=<port>`, `http_status=200`, the greeting for `readiness-probe`, and its `getGreeting called` handler line.
- **Doctor.** Run `.claude/skills/verify/scripts/control-example doctor`. Every line is OK, and the port is reported as ours, listening on `127.0.0.1`.
- **HTTP/1.1 rejected.** Run `.claude/skills/verify/scripts/control-example call http1 GetGreeting`. The result is `exit_code=1`, `http_status=000` and `curl: (1) Received HTTP/0.9 when not allowed`. The log section shows `Received bad client magic byte string`. A second doctor still reports the instance alive, with one WARN for those error lines.
- **Unknown method.** Run `.claude/skills/verify/scripts/control-example call connect Nope '{}'`. The result is `http_status=404` with an empty body.
- **Message limit.** Run `.claude/skills/verify/scripts/control-example message-limit`. It sends the messages in `packages/e2e-tests/src/fixtures/hostile-requests.json` with Node's HTTP/2 client, each oversized message on a connection of its own. Pass: `verdict=PASS`, `server_alive_after=yes`, and a last check line of `{"verdict":"PASS","checks":8,"failed":0}`. The check lines show a 4 MiB message served, a 4 MiB + 1 byte message answered with `"grpcStatus":"8"`, a 5 MiB message answered with `"grpcStatus":"8"` over gRPC and with `"httpStatus":429` and `"connectCode":"resource_exhausted"` over Connect, the same two 5 MiB answers to a client that keeps sending, each followed by the server's reset, shown as `"closedByServer":true` and `"rstCode":0`, and a normal call over each protocol afterwards.
- **Taken port.** Run `.claude/skills/verify/scripts/control-example taken-port`. It starts a second `node dist/server.js` on the instance's host and port. Pass: `verdict=PASS`, a non-zero `second_exit_code` other than 124 or 137, `second_elapsed_ms` under 5000, stderr or stdout naming `EADDRINUSE` and `AddressInUse`, `instance_alive_after=yes`, and a `taken-port-after` call with `http_status=200`.
- **Shutdown.** Run `.claude/skills/verify/scripts/control-example stop`. The evidence shows `graceful=yes`, `exit_code=0`, `port=<port>`, an empty `port_listeners_after=`, and both shutdown log lines.
- **Hostile authority.** Run this journey last, on its own instance: `.claude/skills/verify/scripts/control-example launch`, then `.claude/skills/verify/scripts/control-example hostile-authority`, then `.claude/skills/verify/scripts/control-example cleanup`. The command sends every authority case in the fixture over gRPC and over Connect, with a normal call over each protocol after each case. Pass: `verdict=PASS`, `server_alive_after=yes`, and a last check line of `{"verdict":"PASS",…,"failed":0}`. A rejected case shows `"httpStatus":200`, `"headersEndedStream":true` and `"grpcStatus":"3"` over gRPC, and `"httpStatus":400` with `"connectCode":"invalid_argument"` over Connect.
- **Hostile authority on IPv6.** Run the same three commands with `launch --host ::1`. The ready line is `gRPC server listening on http://[::1]:<port>`. The normal calls then dial `http://[::1]:<port>` with Node's default authority, which is `::1:<port>` without brackets. The pass condition is the same.

## Gotchas

- An empty authority never reaches the server. Node's HTTP/2 layer resets that stream with `PROTOCOL_ERROR` (RST_STREAM code 1) before the request listener runs, so the journey checks the reset and the next call, not a gRPC status.
- On a base without the fix for issue #61, `hostile-authority` stops the server at its first case. The evidence shows `server_alive_after=no`, `server_exit_code=1` and `TypeError: Invalid URL` with base `http://::1:50051`.
- The server stops reading a message it refuses and resets the rest of the upload. A Node client without nodejs/node#67113 and nodejs/node#67114, such as Node 24.22.3 in this devcontainer, keeps counting that unsent rest against its 10 MB `maxSessionMemory`, and can no longer use its connection once the count passes the limit. On one connection, the third oversized message of `message-limit` and every later call get `"rstCode":11`. That is why `message-limit` sends each oversized message on a connection of its own.
- Each checkout runs one instance. `launch` lets the OS pick a free port. With `--port`, it refuses when anything listens on that port. Never stop someone else's process to make room. Launch without `--port` instead.
- On a base without the fix for issue #57, the second server in `taken-port` never gives up on the taken port. It logs `Server error Error: listen EADDRINUSE` and keeps running until `timeout` stops it, so the evidence shows `second_exit_code=124` or `137` and `verdict=FAIL`.
- The example binds `127.0.0.1` unless it was launched with `--host ::1`. Direct clients dial the address that the instance reports.
- The server logs every TCP connection, HTTP/2 session and stream. The helper hides those lines on the terminal and keeps them in evidence. They are not errors.
- If launch fails at once with `ERR_PACKAGE_PATH_NOT_EXPORTED … './RunnerStorage'`, the stale-peer problem in SKILL.md (Launch) is back.
