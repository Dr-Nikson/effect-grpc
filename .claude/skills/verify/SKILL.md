---
name: verify
description: Prove an effect-grpc change works by driving the example gRPC server in packages/example the way a library user does. Covers protoc-gen-effect codegen, launching the server, unary calls over gRPC (buf curl) and Connect (curl), the generated Effect client, and graceful shutdown, and captures evidence for each step. Use after changing packages/effect-grpc (server, client, codegen plugin) or packages/example, before you say the change works.
---

# Verify effect-grpc through the example server

effect-grpc is a library, so "the app" is what a user builds with it. `packages/example` is that app:

- `buf generate` runs `protoc-gen-effect` over `proto/com/example/v1/hello_world_api.proto`.
- `src/server.ts` serves `com.example.v1.HelloWorldAPI` (`GetGreeting`, `FaceTheError`) on `localhost:8000`.
- `src/client.ts` calls the server through the generated Effect client.

This skill drives all three surfaces with `scripts/control-example` and records proof.

Read [features/README.md](features/README.md) before you drive anything. It lists the journeys, their pass conditions, and the journeys that fail on the current base.

Run every command from the repo root:

```sh
C=.claude/skills/verify/scripts/control-example
```

## Launch

1. Build from whatever the tree holds now: `$C build`. It runs `pnpm install --frozen-lockfile`, then `pnpm -r run build`, which takes about 5 s warm. The build compiles the library, regenerates both packages' bindings, and compiles the example.
2. Start the server: `$C launch`. Launch refuses to start in three cases:
   - something already listens on port 8000;
   - a compiled output is older than its source;
   - this skill's previous instance is still alive.
3. Launch returns only once the server is usable. It waits for three things:
   - the log line `gRPC server listening on http://localhost:8000`;
   - port 8000 owned by the server pid;
   - one Connect `GetGreeting` call (name `readiness-probe`) that returns HTTP 200.

   Then it prints the pid, the bound address, and the run directory.
4. `$C launch --ipv4first` starts the same server with `NODE_OPTIONS=--dns-result-order=ipv4first`, so `localhost` binds `127.0.0.1`. Use it only for Effect-client journeys (see [effect-client.md](features/effect-client.md)). A pass under this mode never proves the README pairing.

Tear down with `$C stop` or `$C cleanup`:

- `stop` sends SIGTERM and records the shutdown.
- `cleanup` stops the instance if it is still running, drops the instance state, and keeps the evidence.

The server is stateless, so there is no data to seed.

If the server exits during startup with `ERR_PACKAGE_PATH_NOT_EXPORTED … './RunnerStorage'`, the lockfile resolves stale peers of `@effect/platform-node` (`@effect/cluster` older than 0.56). The commented pins in the `pnpm-workspace.yaml` catalog fix that.

## Doctor

`$C doctor` checks whether this instance is worth driving. It sends no RPC. It checks that:

- the recorded pid is alive and still has the start time recorded at launch, so the pid was not recycled;
- the process runs `node dist/server.js` with cwd `packages/example`;
- this instance's log has the ready line;
- every listener on port 8000 belongs to that pid. Doctor also reports the bound address, which is `::1` with the documented launch in this devcontainer;
- no compiled output is older than its source. It compares the library's `src/**/*.ts`, `src/server.ts` and `src/client.ts` with their outputs, and the proto and `protocGenPlugin.ts` with the generated code.

It prints WARN when HEAD moved since launch or when the log has error lines.

Run doctor first whenever anything looks off. If doctor reports FAIL on a stale build, rebuild and relaunch: a pass against stale `dist/` proves only the old code.

## Drive

| Command | What it runs | Stable handle |
| --- | --- | --- |
| `$C call grpc <Method> [json]` | `buf curl --protocol grpc --http2-prior-knowledge --schema packages/example/proto` | exit 0, or 8 × the gRPC status code (72 means `failed_precondition`) |
| `$C call connect <Method> [json]` | `curl --http2-prior-knowledge` with Connect JSON | `http_status=` 200, 400 or 404, plus the JSON body |
| `$C call http1 <Method> [json]` | the same curl request without HTTP/2 | rejected: `Received HTTP/0.9 when not allowed` |
| `$C client` | the README client, `node dist/client.js` | stdout, stderr and exit code |
| `$C probe <getGreeting\|faceTheError> [name] [url]` | the generated Effect client on its default tag ([effect-client-probe.mjs](scripts/effect-client-probe.mjs)) | last stdout line: `{"ok":…,"response":…}` or `{"ok":false,"kind":…,"error":…}` |
| `$C codegen` | `pnpm -r run build`, then lists the generated files, their exports, and the `typeof` of the tag factories | export names; `typeof … = function` |
| `$C hostile-authority` | one Connect request with `Host: ::1:8000` | `verdict=PASS` when the server survives |

`<Method>` is a proto method name on the route `/com.example.v1.HelloWorldAPI/<Method>`. `[json]` defaults to `{"name":"verify"}`.

The handler's log line is the server-side proof. For example, a `GetGreeting` call logs `getGreeting called, this is really cool!` with `method: com.example.v1.HelloWorldAPI/GetGreeting`.

## Evidence

Each run writes to `${EGV_ROOT:-${XDG_STATE_HOME:-~/.local/state}/effect-grpc-verify}/runs/<run-id>/evidence/`. `$C evidence` prints that path. Runs accumulate there until you delete them. The directory holds:

- `run.txt`: run id, start time, git HEAD, and the number of changed paths.
- `server.log`: all server output, with one `=== launch mode=… git=…` banner per instance.
- `NN-<slug>.txt`, one file per action. Each file has the exact command, the exit code, the HTTP or gRPC status, the response, stderr, and the server log lines written during that action. The action and its server-side effect stay together in one file.

Proof standards:

- **Drive the real user path.** Use an independent gRPC or Connect client against the real server, or the generated client against it. Do not use test-only endpoints, and do not call handlers directly.
- **Capture the action and the state it produced.** Keep the response and the handler log line from the same call. A 200 without the handler line proves nothing about the handler.
- **Check side effects.**
  - For codegen: the generated files and exports on disk, and the compiled output.
  - For shutdown: the exit code and the freed port.
- **No mocks.** The only boundary here is the network, and both sides of it are real.
- **Record the launch mode** with any client proof.

## Cleanup

`$C cleanup` does three things:

- stops the instance this run started;
- removes `runs/<run-id>/state/`;
- clears the current-run pointer.

The evidence stays where it was.

- Cleanup signals only the pid it launched, after it checks that pid's start time. Never `pkill node` and never kill by port, because another agent or the user may own port 8000.
- After a failed attempt, run `$C cleanup` before you retry, so no instance holds the port.
- A crashed instance needs no signal. `stop` and `cleanup` detect that it is gone and still clear the state.

## Known failures on this base

These failures were recorded on 2026-11-23 at 61c6828 plus the `@effect/platform-node` peer pins in `pnpm-workspace.yaml`, in this devcontainer (Node 24, where `localhost` resolves to `::1` first). Without those pins, the example does not start at all. Their journeys keep the correct expected result. Do not edit a journey to match a bug.

- **Generated typed-tag factories are not callable** (`typeof … = object`). Because of this, the README client exits with `TypeError: effectProto.HelloWorldAPIClientTag is not a function`. See [codegen.md](features/codegen.md) and [effect-client.md](features/effect-client.md).
- **With the documented launch, the Effect client cannot reach the server.** The client fails with `ECONNREFUSED 127.0.0.1:8000` while the server listens on `::1`. The same symptom fails 6 of 7 `packages/e2e-tests` tests here on an untouched HEAD. See [effect-client.md](features/effect-client.md).
- **One request with an unbracketed IPv6 `:authority` stops the server** with `TypeError: Invalid URL`. See [server-lifecycle.md](features/server-lifecycle.md).

## Helpers

- `scripts/control-example` runs every command above. `$C help` prints its usage. Set `EGV_ROOT` to move runs somewhere else.
- `scripts/effect-client-probe.mjs` runs through `$C probe`. `$C probe` feeds the file to `node --input-type=module` from `packages/example`, so its imports resolve there. It reads the env vars `PROBE_URL`, `PROBE_METHOD` and `PROBE_NAME`.
