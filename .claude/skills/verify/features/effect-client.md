# Effect client

A user calls the server through the generated client. They provide `helloWorldAPIClientLiveLayer(tag)` with a `HelloWorldAPIConfigTag` base URL and `EffectGrpcClient.liveGrpcClientRuntimeLayer()`, then `yield* client.getGreeting(…)`.

## Sub-features

- `cli-example` is the README example client (`node dist/client.js`). It logs the greeting, then fails on `FaceTheError` with `failed_precondition`.
- `cli-localhost` is the README pairing: a client with base URL `http://127.0.0.1:8000` reaches a server started with `host: "127.0.0.1"` and port 8000. The ID dates from when that pairing used `localhost`.
- `cli-default-tag` is a client built on the default `HelloWorldAPIClientTag`. It gets the greeting over gRPC.
- `cli-error` is the delivery of `FaceTheError` to the caller as `ConnectError: [failed_precondition] Face the consequences!`, as a defect.

## How to get to it (user POV)

- Start the server, then run `node dist/client.js` from `packages/example` in a second terminal, as the README does. Both sides use `127.0.0.1:8000`, or the port in `EFFECT_GRPC_EXAMPLE_PORT`.
- Write a client from the generated JSDoc's first example: `helloWorldAPIClientLiveLayer(HelloWorldAPIClientTag)`.

## Driving it with control-example

Preconditions:

- All four journeys run on one plain launch: `.claude/skills/verify/scripts/control-example launch`.

- **Example client.** Run `.claude/skills/verify/scripts/control-example client`. Pass: stdout shows `Got some response from gRPC: Hey there! Your name is Meowucher, right?`, then the `failed_precondition` failure, and the exit code is 1. The server-log section has one `getGreeting called` line and one `faceTheError called` line.
- **README pairing and default tag.** Run `.claude/skills/verify/scripts/control-example probe getGreeting Ada`. The probe dials the instance's URL, which at port 8000 is the README's `http://127.0.0.1:8000`. Pass: the last stdout line is `{"url":"http://127.0.0.1:<port>","method":"getGreeting","ok":true,"response":{…"greeting":"Hey there! Your name is Ada, right?"}}`, and the server-log section has the handler line. One pass proves both `cli-localhost` and `cli-default-tag`.
- **Default tag, error.** Run `.claude/skills/verify/scripts/control-example probe faceTheError Ada`. The result is exit code 1, with the last line `{"url":"http://127.0.0.1:<port>","method":"faceTheError","ok":false,"kind":"defect","code":9,"error":"ConnectError: [failed_precondition] Face the consequences!"}`. The server-log section has the `faceTheError called` line.

## Gotchas

- `cli-example` fails on the base recorded in SKILL.md before any network call. It stops with `TypeError: effectProto.HelloWorldAPIClientTag is not a function`, because `client.ts` calls the typed-tag factory (see `gen-typed-tags` in [codegen.md](./codegen.md)). The server-log section stays empty.
- Never dial `http://[::1]:<port>` from a client. Node's client then sends the authority `::1:<port>`, and the server stops (see `srv-hostile-authority` in [server-lifecycle.md](./server-lifecycle.md)).
- After each probe, the server log shows `ERR_HTTP2_SESSION_ERROR: Session closed with error code 8` when the probe's HTTP/2 session closes, and a later doctor WARNs about those lines. The parent revision logs them too, and they break no pass condition.
- The probe imports the compiled `packages/example/dist/generated` module and the built library. After you change client code, run `.claude/skills/verify/scripts/control-example build`. `.claude/skills/verify/scripts/control-example doctor` reports a stale `dist/`.
- The probe prints the library's `ManagedSessionManager is being released...` log before its result. The result is always the last stdout line.
