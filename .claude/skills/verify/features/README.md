# effect-grpc verification map

This directory is the maintained source for verifying effect-grpc's user-facing behavior through `packages/example`. Read this index before you drive the server, then use the matching feature file as the recipe.

## Baseline preconditions

- Run each command as one call to `.claude/skills/verify/scripts/control-example` in the checkout under test, as [SKILL.md](../SKILL.md) describes. The commands below are written as run from that checkout's root.
- `.claude/skills/verify/scripts/control-example build` succeeded on the tree under test.
- Each checkout runs one instance. `launch` lets the OS pick a free port unless `--port` pins one, so another checkout can run its own instance at the same time.
- `.claude/skills/verify/scripts/control-example launch` started the instance, and `.claude/skills/verify/scripts/control-example doctor` reports no FAIL.
- Drive only the instance this checkout's script started. The script refuses a `--port` or `--root` that points anywhere else.

## Driving conventions

- Server journeys use independent clients: `call grpc` (`buf curl`, gRPC protocol) and `call connect` (`curl`, Connect JSON over HTTP/2).
- Name methods by their proto names on `/com.example.v1.HelloWorldAPI/<Method>`: `GetGreeting` and `FaceTheError`.
- Dial an IPv6 literal URL (`http://[::1]:<port>`) only against an instance launched with `--host ::1`.
- Hostile inputs come only from `packages/e2e-tests/src/fixtures/hostile-requests.json`, through the `hostile-authority` and `message-limit` commands. Never put them on a command line. The `connect-method` command sends a plain CONNECT request and uses no fixture case.
- Run the hostile-authority journey last, on its own instance.
- Treat every command as literal, and keep JSON payloads quoted as shown.

## Proof and skip reporting

- Capture the user action and the state it produced. The helper writes the client's response and the server log lines from the same action into one evidence file. Cite that file.
- Record the port with every client proof. Each evidence file's first line carries it.
- Report an unreachable journey with the command you ran and the precondition that was missing.
- Do not report a skipped entry point as verified through a different one.
- A journey that fails on the current base keeps its correct pass condition until the bug is fixed. Report it as failing, with its Gotcha.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph that describes the user-visible behavior. Four H2 sections follow, in this order:

1. `Sub-features` lists short IDs, with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-example` starts with `Preconditions:`. Its labeled bullets pair each user action with an exact command and an observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run, including journeys that fail on the current base.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Code generation](./codegen.md) covers `protoc-gen-effect` output: files, export names, the no-duplicate-suffix rule, compilation, and the default and typed tags.
- [Server lifecycle](./server-lifecycle.md) covers startup, readiness, HTTP/2-only transport, unknown methods, CONNECT requests, graceful shutdown, hostile `:authority` values, and the 4 MiB message limit.
- [Unary RPC](./unary-rpc.md) covers `GetGreeting` over gRPC and Connect, with the handler's server-side effect.
- [Error mapping](./error-mapping.md) covers `GrpcException` to gRPC status and Connect HTTP status, and keeping the server up afterwards.
- [Effect client](./effect-client.md) covers the README example client and the generated client on its default tag, including how errors reach the caller and a call to an IPv6 literal address.

## Not mapped yet

- Distributed tracing (W3C `traceparent` to a server span). The example configures no OpenTelemetry exporter, so a user sees nothing to check. Only `packages/e2e-tests/src/tracing.test.ts` covers it.
- Context transformers (`withContextTransformer`), request headers and metadata transformers, compression, and timeouts. The example does not use them.
