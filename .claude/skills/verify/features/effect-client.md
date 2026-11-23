# Effect client

A user calls the server through the generated client. They provide `helloWorldAPIClientLiveLayer(tag)` with a `HelloWorldAPIConfigTag` base URL and `EffectGrpcClient.liveGrpcClientRuntimeLayer()`, then `yield* client.getGreeting(…)`.

## Sub-features

- `cli-example` is the README example client (`node dist/client.js`). It logs the greeting, then fails on `FaceTheError` with `failed_precondition`.
- `cli-localhost` is a client with base URL `http://localhost:8000` that reaches a server started with `host: "localhost"`, the pairing the README shows.
- `cli-default-tag` is a client built on the default `HelloWorldAPIClientTag`. It gets the greeting over gRPC.
- `cli-error` is the delivery of `FaceTheError` to the caller as `ConnectError: [failed_precondition] Face the consequences!`, as a defect.

## How to get to it (user POV)

- Start the server, then run `cd packages/example && node dist/client.js` in a second terminal, as the README does.
- Write a client from the generated JSDoc's first example: `helloWorldAPIClientLiveLayer(HelloWorldAPIClientTag)`.

## Driving it with control-example

Preconditions:

- `cli-example` and `cli-localhost` need the documented launch, `$C launch`.
- `cli-default-tag` and `cli-error` need `$C launch --ipv4first`. Run `$C stop` between the two launches.

- **Example client.** Run `$C client`. Pass: stdout shows `Got some response from gRPC: Hey there! Your name is Meowucher, right?`, then the `failed_precondition` failure, and the exit code is 1. The server-log section has one `getGreeting called` line and one `faceTheError called` line.
- **README pairing.** With the documented launch, run `$C probe getGreeting Ada`. Pass: the last stdout line is `{"ok":true,…,"greeting":"Hey there! Your name is Ada, right?"}`, and the server-log section has the handler line.
- **Default tag, success.** With `--ipv4first`, run `$C probe getGreeting Ada`. The evidence starts with the `--ipv4first` NOTE. The last stdout line is `{"ok":true,"response":{…"greeting":"Hey there! Your name is Ada, right?"}}`, and the server-log section has the handler line.
- **Default tag, error.** With `--ipv4first`, run `$C probe faceTheError Ada`. The result is exit code 1, with the last line `{"ok":false,"kind":"defect","code":9,"error":"ConnectError: [failed_precondition] Face the consequences!"}`. The server-log section has the `faceTheError called` line.

## Gotchas

- `cli-example` fails on the base recorded in SKILL.md before any network call. It stops with `TypeError: effectProto.HelloWorldAPIClientTag is not a function`, because `client.ts` calls the typed-tag factory (see `gen-typed-tags` in [codegen.md](./codegen.md)). The server-log section stays empty.
- `cli-localhost` fails in this devcontainer. The probe reports `{"ok":false,"kind":"defect","code":14,"error":"ConnectError: [unavailable] connect ECONNREFUSED 127.0.0.1:8000"}` while `$C doctor` shows the server on `::1`. Plain Node gives the same refusal for `http2.connect("http://localhost:<port>")` against a server listening on `localhost`. The same symptom, `ECONNREFUSED 127.0.0.1:3000`, fails 6 of 7 tests in `packages/e2e-tests` on an untouched HEAD here. Your change did not cause it.
- `--ipv4first` sets `NODE_OPTIONS=--dns-result-order=ipv4first` on the server only, so it binds `127.0.0.1` and the client journeys can run. A pass under it proves the client code path and the error delivery. It does not prove `cli-localhost`.
- Never point the probe at `http://[::1]:8000`. Node's client then sends the authority `::1:8000`, and the server stops (see `srv-hostile-authority` in [server-lifecycle.md](./server-lifecycle.md)).
- The probe imports the compiled `packages/example/dist/generated` module and the built library. After you change client code, run `$C build`. `$C doctor` reports a stale `dist/`.
- The probe prints the library's `ManagedSessionManager is being released...` log before its result. The result is always the last stdout line.
