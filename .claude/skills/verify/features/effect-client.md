# Effect client

A user calls the server through the generated client. They provide `helloWorldAPIClientLiveLayer(tag)` with a `HelloWorldAPIConfigTag` base URL and `EffectGrpcClient.liveGrpcClientRuntimeLayer()`, then `yield* client.getGreeting(…)`.

## Sub-features

- `cli-example` is the README example client (`node dist/client.js`). It builds its client on a typed tag from `makeHelloWorldAPIClientTag`, logs the greeting, then fails on `FaceTheError` with the `GrpcException` that the handler sent, code `failed_precondition`.
- `cli-localhost` is the README pairing: a client with base URL `http://127.0.0.1:<port>` reaches a server started with `host: "127.0.0.1"` on that port. The README uses port 8000. The ID keeps its name from when that pairing used `localhost`, because issue #60 and the verification lanes look it up by that name.
- `cli-default-tag` is a client built on the default `HelloWorldAPIClientTag`. It gets the greeting over gRPC.
- `cli-error` is the delivery of `FaceTheError` to the caller as a typed failure in Effect's error channel: a `GrpcException` with code 9 (`failed_precondition`), the message `Face the consequences!` and the handler's data `{"name":<name>,"consequences":["no greeting"]}`. It is never a defect.
- `cli-ipv6` is a client on the default tag with base URL `http://[::1]:<port>`, against a server bound to `::1`. It gets the greeting, although Node's HTTP/2 client sends the call's authority as `::1:<port>`, without brackets.

## How to get to it (user POV)

- Start the server, then run `node dist/client.js` from `packages/example` in a second terminal, as the README does. Both sides use `127.0.0.1:8000`, or the port in `EFFECT_GRPC_EXAMPLE_PORT`. A server started with `EFFECT_GRPC_EXAMPLE_PORT=0` binds a port the OS picks, so give the client the port from the server's ready line. `control-example client` passes the bound port.
- Write a client from the generated JSDoc's first example: `helloWorldAPIClientLiveLayer(HelloWorldAPIClientTag)`.
- For IPv6, start the server with `EFFECT_GRPC_EXAMPLE_HOST=::1` and give the client `http://[::1]:<port>`.

## Driving it with control-example

Preconditions:

- The first four journeys run on one plain launch: `.claude/skills/verify/scripts/control-example launch`. `cli-ipv6` needs its own launch on `::1`.

- **Example client.** Run `.claude/skills/verify/scripts/control-example client`. Pass: stdout shows `Got some response from gRPC: Hey there! Your name is Meowucher, right?`, then an ERROR line `@dr_nikson/effect-grpc/grpcException/GrpcException: Face the consequences!` whose `[cause]` is `ConnectError: [failed_precondition] Face the consequences!`, and the exit code is 1. The server-log section has one `getGreeting called` line and one `faceTheError called` line.
- **README pairing and default tag.** Run `.claude/skills/verify/scripts/control-example probe getGreeting Ada`. The probe dials the instance's URL, `http://127.0.0.1:<port>` on the port the server bound. Pass: the last stdout line is `{"url":"http://127.0.0.1:<port>","method":"getGreeting","ok":true,"response":{…"greeting":"Hey there! Your name is Ada, right?"}}`, and the server-log section has the handler line. One pass proves both `cli-localhost` and `cli-default-tag`.
- **Default tag, error.** Run `.claude/skills/verify/scripts/control-example probe faceTheError Ada`. The result is exit code 1, with the last line `{"url":"http://127.0.0.1:<port>","method":"faceTheError","ok":false,"kind":"failure","tag":"@dr_nikson/effect-grpc/grpcException/GrpcException","code":9,"message":"Face the consequences!","data":{"name":"Ada","consequences":["no greeting"]},"error":"[9] Face the consequences!"}`. The server-log section has the `faceTheError called` line.
- **IPv6 literal.** Run `.claude/skills/verify/scripts/control-example launch --host ::1`, then `.claude/skills/verify/scripts/control-example probe getGreeting Ada`, then `.claude/skills/verify/scripts/control-example cleanup`. Pass: the last stdout line is `{"url":"http://[::1]:<port>","method":"getGreeting","ok":true,"response":{…"greeting":"Hey there! Your name is Ada, right?"}}`, and the server-log section has the handler line.

## Gotchas

- On a base without the fix for issue #55, `cli-example` stops before any network call with `TypeError: effectProto.HelloWorldAPIClientTag is not a function`, and the server-log section stays empty (see `gen-typed-tags` in [codegen.md](./codegen.md)).
- On a base without the fix for issue #61, `cli-ipv6` stops the server: the probe gets `[aborted] read ECONNRESET`, and the server log shows `TypeError: Invalid URL` with base `http://::1:<port>` (see `srv-hostile-authority` in [server-lifecycle.md](./server-lifecycle.md)).
- The probe imports the compiled `packages/example/dist/generated` module and the built library. After you change client code, run `.claude/skills/verify/scripts/control-example build`. `.claude/skills/verify/scripts/control-example doctor` reports a stale `dist/`.
- The result is always the last stdout line of the probe.
- On a base without typed client failures (issue #27), `cli-error` prints `"kind":"defect"` with `"error":"ConnectError: [failed_precondition] Face the consequences!"` and no `data`, and `cli-example` logs that `ConnectError` as its failure.
- The generated client speaks gRPC only. To see the data over gRPC-web and Connect, use `call grpc-web` and `call connect` in [error-mapping.md](./error-mapping.md).
