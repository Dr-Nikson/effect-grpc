---
name: verify
description: Prove an effect-grpc change works by driving the example gRPC server in packages/example the way a library user does. Covers protoc-gen-effect codegen, launching the server, unary calls over gRPC (buf curl) and Connect (curl), the generated Effect client, and graceful shutdown, and captures evidence for each step. Use after changing packages/effect-grpc (server, client, codegen plugin) or packages/example, before you say the change works.
---

# Verify effect-grpc through the example server

effect-grpc is a library, so "the app" is what a user builds with it. `packages/example` is that app:

- `buf generate` runs `protoc-gen-effect` over `proto/com/example/v1/hello_world_api.proto`.
- `src/server.ts` serves `com.example.v1.HelloWorldAPI` (`GetGreeting`, `FaceTheError`) on `127.0.0.1:8000`. `EFFECT_GRPC_EXAMPLE_HOST` and `EFFECT_GRPC_EXAMPLE_PORT` change the address and the port.
- `src/client.ts` calls the server through the generated Effect client, on the same address.

This skill drives all three surfaces with `scripts/control-example` and records proof.

Read [features/README.md](features/README.md) before you drive anything. It lists the journeys, their pass conditions, and the journeys that fail on the current base.

## Run each step as one command

Each step is one call to `.claude/skills/verify/scripts/control-example` in the checkout you verify, written as run from that checkout's root. If your shell starts somewhere else, put the checkout's absolute path in front of `.claude` and pass the same path as `--root`. A call that lands in another checkout's copy of the script then refuses and names the script to run. With no flags, the script drives its own checkout on port 8000.

To see every command and option, run:

```sh
.claude/skills/verify/scripts/control-example help
```

## Run beside other instances

Each checkout runs at most one instance, and each instance has its own run state and evidence. Instances in different checkouts run at the same time on different ports. Give `launch` a free port with `--port`:

```sh
.claude/skills/verify/scripts/control-example launch --port 8001 --root .
```

To serve IPv6, give `launch` the `::1` address as well, as in `.claude/skills/verify/scripts/control-example launch --port 8001 --host ::1 --root .`. The instance then binds `::1`, and every client command dials `http://[::1]:8001`.

Later commands read the port and the address from the checkout's run, so they need no flag. On any later command, `--port`, `--host` and `--root` are checks. The command refuses, exits 2 and changes nothing when `--port` differs from the instance's port, `--host` differs from its address, or `--root` names another checkout. `cleanup` in one checkout stops only that checkout's server.

A lane whose shell starts outside its worktree writes the worktree's absolute path in both places, as in `/dr_nikson/effect-grpc/.worktrees/p02-live2/.claude/skills/verify/scripts/control-example launch --port 8122 --root /dr_nikson/effect-grpc/.worktrees/p02-live2`.

## Launch

1. Build from whatever the tree holds now:

   ```sh
   .claude/skills/verify/scripts/control-example build
   ```

   It runs `pnpm install --frozen-lockfile`, then `pnpm -r run build`, which takes about 5 s warm. The build compiles the library, regenerates both packages' bindings, and compiles the example.
2. Start the server:

   ```sh
   .claude/skills/verify/scripts/control-example launch
   ```

   Launch refuses to start in three cases:
   - something already listens on its port;
   - a compiled output is older than its source;
   - this checkout's previous instance is still alive.
3. Launch returns only once the server is usable. It waits for three things:
   - the log line `gRPC server listening on http://<address>:<port>`, where the address is `127.0.0.1`, or `::1` for an IPv6 launch;
   - the port owned by the server pid;
   - one Connect `GetGreeting` call (name `readiness-probe`) that returns HTTP 200 with the greeting, answered by this instance's handler.

   Then it prints the pid, the port, the bound address, the checkout and the run directory.

At port 8000 and address `127.0.0.1`, the script starts the example with neither `EFFECT_GRPC_EXAMPLE_PORT` nor `EFFECT_GRPC_EXAMPLE_HOST`, as a user does. For any other value, it sets that variable.

Tear down with `stop` or `cleanup`:

- `stop` sends SIGTERM and records the shutdown.
- `cleanup` stops the instance if it is still running, drops the instance state, and keeps the evidence.

The server is stateless, so there is no data to seed.

If the server exits during startup with `ERR_PACKAGE_PATH_NOT_EXPORTED … './RunnerStorage'`, the lockfile resolves stale peers of `@effect/platform-node` (`@effect/cluster` older than 0.56). The commented pins in the `pnpm-workspace.yaml` catalog fix that.

## Doctor

```sh
.claude/skills/verify/scripts/control-example doctor
```

Doctor checks whether this checkout's instance is worth driving. It sends no RPC. It checks that:

- the recorded pid is alive and still has the start time recorded at launch, so the pid was not recycled;
- the process runs `node dist/server.js` with cwd `packages/example` in this checkout;
- this instance's log has the ready line for its address and port;
- every listener on the port belongs to that pid. Doctor also reports the bound address, `127.0.0.1` or `::1`;
- no compiled output is older than its source. It compares the library's `src/**/*.ts`, the example's `src/server.ts`, `src/client.ts` and `src/address.ts` with their outputs, and the proto and `protocGenPlugin.ts` with the generated code.

It prints WARN when HEAD moved since launch or when the log has error lines.

Run doctor first whenever anything looks off. If doctor reports FAIL on a stale build, rebuild and relaunch: a pass against stale `dist/` proves only the old code.

## Drive

| Command | What it runs | Stable handle |
| --- | --- | --- |
| `.claude/skills/verify/scripts/control-example call grpc GetGreeting '{"name":"Ada"}'` | `buf curl --protocol grpc --http2-prior-knowledge --schema packages/example/proto` | exit 0, or 8 × the gRPC status code (72 means `failed_precondition`) |
| `.claude/skills/verify/scripts/control-example call connect GetGreeting '{"name":"Ada"}'` | `curl --http2-prior-knowledge` with Connect JSON | `http_status=` 200, 400 or 404, plus the JSON body |
| `.claude/skills/verify/scripts/control-example call http1 GetGreeting` | the same curl request without HTTP/2 | rejected: `Received HTTP/0.9 when not allowed` |
| `.claude/skills/verify/scripts/control-example client` | the README client, `node dist/client.js` | stdout, stderr and exit code |
| `.claude/skills/verify/scripts/control-example probe getGreeting Ada` | the generated Effect client on its default tag ([effect-client-probe.mjs](scripts/effect-client-probe.mjs)), against the instance's URL | last stdout line: `{"ok":…,"response":…}` or `{"ok":false,"kind":…,"error":…}` |
| `.claude/skills/verify/scripts/control-example codegen` | `pnpm -r run build`, then lists the generated files, their exports, and the `typeof` of the tag factories | export names; `typeof … = function` |
| `.claude/skills/verify/scripts/control-example hostile-authority` | the authority cases in `packages/e2e-tests/src/fixtures/hostile-requests.json`, over gRPC and Connect, through [hostile-requests.mjs](scripts/hostile-requests.mjs) | `verdict=PASS` when every check passes and the server survives |
| `.claude/skills/verify/scripts/control-example message-limit` | messages of 4 MiB, 4 MiB + 1 byte and 5 MiB from the same fixture, each oversized message on a connection of its own | `verdict=PASS` when every check passes and the server survives |

`call` takes a protocol (`grpc`, `connect` or `http1`), a proto method name on the route `/com.example.v1.HelloWorldAPI/<Method>`, and an optional JSON request that defaults to `{"name":"verify"}`. `probe` takes `getGreeting` or `faceTheError` and an optional name.

The handler's log line is the server-side proof. For example, a `GetGreeting` call logs `getGreeting called, this is really cool!` with `method: com.example.v1.HelloWorldAPI/GetGreeting`.

## Evidence

Each run writes to `${EGV_ROOT:-${XDG_STATE_HOME:-~/.local/state}/effect-grpc-verify}/runs/<run-id>/evidence/`. To print that path, run:

```sh
.claude/skills/verify/scripts/control-example evidence
```

`cleanup` prints the same path. Runs accumulate there until you delete them, so the evidence outlives the checkout. The checkout's pointer to its current run lives in its git dir, at `<git dir>/effect-grpc-verify/current`. The evidence directory holds:

- `run.txt`: run id, start time, the checkout, the path of the script that ran, the full git HEAD, and the number of changed paths.
- `server.log`: all server output, with one `=== launch host=… port=… root=… at … git=…` banner per instance.
- `NN-<slug>.txt`, one file per action. Each file has the exact command, the port, the exit code, the HTTP or gRPC status, the response, stderr, and the server log lines written during that action. The action and its server-side effect stay together in one file.

Proof standards:

- **Drive the real user path.** Use an independent gRPC or Connect client against the real server, or the generated client against it. Do not use test-only endpoints, and do not call handlers directly.
- **Capture the action and the state it produced.** Keep the response and the handler log line from the same call. A 200 without the handler line proves nothing about the handler.
- **Check side effects.**
  - For codegen: the generated files and exports on disk, and the compiled output.
  - For shutdown: the exit code and the freed port.
- **No mocks.** The only boundary here is the network, and both sides of it are real.

## Cleanup

```sh
.claude/skills/verify/scripts/control-example cleanup
```

Cleanup does three things:

- stops the instance this checkout started;
- removes `runs/<run-id>/state/`;
- clears this checkout's run pointer.

The evidence stays where it was.

- Cleanup signals only the pid it launched, after it checks that pid's start time. Never `pkill node` and never kill by port, because another agent, another checkout or the user may own the port.
- After a failed attempt, run cleanup before you retry, so no instance holds the port.
- A crashed instance needs no signal. `stop` and `cleanup` detect that it is gone and still clear the state.

## Known failures on this base

This failure was recorded on 2026-11-24 on branch `v4/p02-authority-guard-size-cap` (PR #84, on top of PR #83), in this devcontainer (Node 24, where `localhost` resolves to `::1` first). Its journeys keep the correct expected result. Do not edit a journey to match a bug.

- **Generated typed-tag factories are not callable** (`typeof … = object`). Because of this, the README client exits with `TypeError: effectProto.HelloWorldAPIClientTag is not a function` before it dials the server. See [codegen.md](features/codegen.md) and [effect-client.md](features/effect-client.md).

## Helpers

- `scripts/control-example` runs every command above. Its `help` command prints the usage.
- `scripts/hostile-requests.mjs` runs through `hostile-authority` and `message-limit`. Those commands feed the file to `node --input-type=module` from `packages/e2e-tests`, so its imports resolve there. It reads the env vars `HOSTILE_URL`, `HOSTILE_FIXTURES` and `HOSTILE_MODE`, sends the fixture's authority and message-limit cases with Node's HTTP/2 client, and prints one JSON line per check and a verdict line last.
- `scripts/effect-client-probe.mjs` runs through `probe`. `probe` feeds the file to `node --input-type=module` from `packages/example`, so its imports resolve there. It reads the env vars `PROBE_URL`, `PROBE_METHOD` and `PROBE_NAME`, and refuses to run without `PROBE_URL`.
