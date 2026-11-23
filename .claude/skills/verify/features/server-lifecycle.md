# Server lifecycle

A user builds a server with `EffectGrpcServer.GrpcServerBuilder().withService(…).build()` and calls `run({ host, port })`. The server logs when it is ready, serves gRPC and Connect over cleartext HTTP/2, and shuts down gracefully on SIGTERM or Ctrl+C.

## Sub-features

- `srv-ready` logs `gRPC server listening on http://localhost:8000` and then answers RPCs.
- `srv-h2c` accepts only HTTP/2 with prior knowledge, and rejects HTTP/1.1 clients.
- `srv-unknown` answers an unknown method with HTTP 404 over Connect.
- `srv-shutdown` responds to SIGTERM: it logs `gRPC server is stopping...` and then `gRPC server stopped`, exits with code 0, and frees port 8000.
- `srv-hostile-authority` answers a request whose `:authority` is an unbracketed IPv6 literal with an error response, and keeps running.

## How to get to it (user POV)

- Run `cd packages/example && node dist/server.js`, as in the README's "Complete Example".
- Stop the server with Ctrl+C or SIGTERM.

## Driving it with control-example

Preconditions:

- `$C build` succeeded, and nothing listens on port 8000.

- **Launch.** Run `$C launch`. It prints `launched: pid=<pid> mode=documented listening on: ::1`. The evidence `server.log` has the ready line, and `01-readiness.txt` shows `http_status=200` with the greeting for `readiness-probe`.
- **Doctor.** Run `$C doctor`. Every line is OK, and port 8000 is reported as ours, listening on `::1`.
- **HTTP/1.1 rejected.** Run `$C call http1 GetGreeting`. The result is `exit_code=1`, `http_status=000` and `curl: (1) Received HTTP/0.9 when not allowed`. The log section shows `Received bad client magic byte string`. A second `$C doctor` still reports the instance alive, with one WARN for those error lines.
- **Unknown method.** Run `$C call connect Nope '{}'`. The result is `http_status=404` with an empty body.
- **Shutdown.** Run `$C stop`. The evidence shows `graceful=yes`, `exit_code=0`, an empty `port_8000_listeners_after=`, and both shutdown log lines.
- **Hostile authority.** Run this journey last, on its own instance: `$C launch`, then `$C hostile-authority`, then `$C cleanup`. Pass: `verdict=PASS` with a 4xx `http_status` and `server_alive_after=yes`.

## Gotchas

- `srv-hostile-authority` fails on the base recorded in SKILL.md, and the failure stops the server. The evidence shows `curl_exit_code=56`, `server_alive_after=no`, `server_exit_code=1` and `TypeError: Invalid URL` with base `http://::1:8000`. The throw starts in `@connectrpc/connect-node`'s `universalRequestFromNodeRequest`. The server passes that handler to `http2.createServer` without a guard, so one request from any client stops the process. Node's own HTTP/2 client sends this authority for `http://[::1]:<port>` URLs (see [effect-client.md](./effect-client.md)).
- Only one instance can run. `$C launch` refuses when anything listens on port 8000. Never stop someone else's process to make room.
- With the documented launch, the server binds only `::1` in this devcontainer, because `localhost` resolves to `::1` first. `curl` and `buf curl` still connect over `localhost`.
- The server logs every TCP connection, HTTP/2 session and stream. The helper hides those lines on the terminal and keeps them in evidence. They are not errors.
- If launch fails at once with `ERR_PACKAGE_PATH_NOT_EXPORTED … './RunnerStorage'`, the stale-peer problem in SKILL.md (Launch) is back.
