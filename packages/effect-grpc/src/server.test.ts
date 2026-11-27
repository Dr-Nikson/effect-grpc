// packages/effect-grpc/src/server.test.ts
import {
  Array as Arr,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  MutableRef,
  Scheduler,
  Scope,
} from "effect";
import net from "node:net";

import type { HandlerContext } from "@connectrpc/connect";
import { createContextKey } from "@connectrpc/connect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it, vi } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import {
  TestServer,
  greet,
  greeter,
  helloWorld,
  helloWorldClient,
  helloWorldServer,
  testServer,
} from "./testing/harness.js";

class ServerLogs extends Context.Tag("ServerLogs")<
  ServerLogs,
  MutableRef.MutableRef<ReadonlyArray<string>>
>() {}

const textOf = (message: unknown): string =>
  (Arr.isArray(message) ? message : [message]).map(String).join(" ");

const capturingLogs = Layer.unwrapEffect(
  Effect.sync(() => {
    const lines = MutableRef.make<ReadonlyArray<string>>([]);
    const logger = Logger.make(({ message }) => {
      MutableRef.update(lines, Arr.append(textOf(message)));
    });
    return Layer.merge(
      Logger.replace(Logger.defaultLogger, logger),
      Layer.succeed(ServerLogs, lines),
    );
  }),
);

const loggedLines = Effect.map(ServerLogs, MutableRef.get);

/**
 * Vitest keeps its workers alive through an uncaught exception.
 */
const recordUncaughtExceptions = Effect.acquireRelease(
  Effect.sync(() => {
    const errors: Array<string> = [];
    const record = (error: unknown) => {
      errors.push(String(error));
    };
    process.on("uncaughtException", record);
    return { errors, record };
  }),
  ({ record }) => Effect.sync(() => process.off("uncaughtException", record)),
).pipe(Effect.map(({ errors }) => errors));

const afterQueuedNodeEvents = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(resolve)),
);

const spyOnConsole = Effect.acquireRelease(
  Effect.sync(() =>
    (["debug", "error", "info", "log", "warn"] as const).map((method) => vi.spyOn(console, method)),
  ),
  (spies) => Effect.sync(() => spies.forEach((spy) => spy.mockRestore())),
);

const sendHttp1Request = (port: number) =>
  Effect.async<void>((resume) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    });
    socket.on("error", () => {});
    socket.once("close", () => resume(Effect.void));
    socket.resume();
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeout("2 seconds"));

const visits = createContextKey(0, { description: "the calls that saw these context values" });

// The handler reads a key that nothing sets and then sets it, so its reply shows whether the
// values were empty and whether an earlier call left anything in them.
const countVisits = (_request: unknown, { values }: HandlerContext) =>
  Effect.sync(() => {
    const seen = values.get(visits);
    values.set(visits, seen + 1);
    return { greeting: String(seen) };
  });

const visitCountingServer = testServer(
  Effect.map(effectProto.HelloWorldAPIServiceTag, (service) =>
    EffectGrpcServer.GrpcServerBuilder()
      .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
      .withService(service)
      .build(),
  ),
).pipe(
  Layer.provide(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, {
      getGreeting: countVisits,
      faceTheError: countVisits,
    }),
  ),
);

describe("GrpcServer.listen", () => {
  it.scopedLive(
    "binds a free port for port 0, reports it, and serves the generated client there",
    () =>
      Effect.gen(function* () {
        const address = yield* TestServer;

        expect(address.port).toBeGreaterThan(0);
        expect(address).toEqual({
          host: "127.0.0.1",
          port: address.port,
          url: `http://127.0.0.1:${address.port}`,
        });
        expect((yield* greet("Ada")).greeting).toBe("Hello, Ada!");
      }).pipe(Effect.provide(helloWorld())),
  );

  it.scopedLive(
    "stops when its scope closes, logs that it stops, frees its port, and a server on that port then serves",
    () =>
      Effect.gen(function* () {
        const first = yield* Effect.tap(TestServer, () => greet("Ada")).pipe(
          Effect.provide(helloWorld()),
        );

        expect(yield* loggedLines).toEqual(
          expect.arrayContaining(["gRPC server is stopping...", "gRPC server stopped"]),
        );
        const again = yield* greet("Ada").pipe(
          Effect.provide(helloWorld({ host: "127.0.0.1", port: first.port })),
        );
        expect(again.greeting, "a server on the freed port").toBe("Hello, Ada!");
      }).pipe(Effect.provide(capturingLogs)),
  );

  it.scopedLive("names the bound url in its ready line, with brackets around an IPv6 address", () =>
    Effect.gen(function* () {
      const ipv4 = yield* TestServer;
      const ipv6 = yield* TestServer.pipe(
        Effect.provide(helloWorldServer({ host: "::1", port: 0 })),
      );
      const lines = yield* loggedLines;

      expect(lines).toContain(`gRPC server listening on http://127.0.0.1:${ipv4.port}`);
      expect(lines).toContain(`gRPC server listening on http://[::1]:${ipv6.port}`);
      expect(ipv6).toEqual({ host: "::1", port: ipv6.port, url: `http://[::1]:${ipv6.port}` });
    }).pipe(Effect.provide(helloWorldServer()), Effect.provide(capturingLogs)),
  );

  it.scopedLive(
    "fails with AddressInUse within a second when the port is taken, logs no server line for it, and the first server keeps serving",
    () =>
      Effect.gen(function* () {
        const first = yield* TestServer;

        const error = yield* Effect.flip(
          Layer.build(helloWorldServer({ host: "127.0.0.1", port: first.port })),
        ).pipe(Effect.timeout("1 second"));

        expect(error).toBeInstanceOf(EffectGrpcServer.GrpcServerBindError);
        expect(error).toMatchObject({
          reason: { _tag: "AddressInUse" },
          host: "127.0.0.1",
          port: first.port,
          cause: { code: "EADDRINUSE" },
        });
        const messageStart = `gRPC server could not listen on 127.0.0.1:${first.port} (AddressInUse): `;
        expect(error.message.startsWith(messageStart), error.message).toBe(true);
        expect((yield* loggedLines).filter((line) => line.startsWith("gRPC server"))).toEqual([
          `gRPC server listening on http://127.0.0.1:${first.port}`,
        ]);
        expect((yield* greet("Ada")).greeting).toBe("Hello, Ada!");
      }).pipe(Effect.provide(helloWorld()), Effect.provide(capturingLogs)),
  );

  it.scopedLive.each([
    {
      reason: "InvalidPort",
      at: "a port above 65535",
      host: "127.0.0.1",
      port: 65536,
      code: "ERR_SOCKET_BAD_PORT",
    },
    {
      reason: "Other",
      at: "an address this host does not have",
      host: "192.0.2.1",
      port: 0,
      code: "EADDRNOTAVAIL",
    },
  ])(
    "fails with $reason for $at, with the $code error that Node reported as the cause",
    ({ reason, host, port, code }) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(Layer.build(helloWorldServer({ host, port })));

        expect(error).toMatchObject({ reason: { _tag: reason }, host, port, cause: { code } });
      }),
  );

  it.scopedLive(
    "keeps the process up when a failing sibling layer interrupts a listen on a taken port",
    () =>
      Effect.gen(function* () {
        const uncaught = yield* recordUncaughtExceptions;
        const first = yield* TestServer;

        // With an empty host, Node binds inside listen() and reports the failure on its next tick.
        const error = yield* Effect.flip(
          Layer.launch(
            Layer.mergeAll(
              helloWorldServer({ host: "", port: first.port }),
              Layer.effectDiscard(Effect.fail("a sibling layer failed")),
            ),
          ),
        );
        yield* afterQueuedNodeEvents;

        expect(error).toBe("a sibling layer failed");
        expect(uncaught.join("\n")).toBe("");
      }).pipe(Effect.provide(helloWorldServer({ host: "", port: 0 }))),
  );

  it.scopedLive(
    "keeps the process up wherever an interrupt lands in a listen on a taken port",
    () =>
      Effect.gen(function* () {
        const uncaught = yield* recordUncaughtExceptions;
        const first = yield* TestServer;
        // Fiber steps on Node's tick queue can run between a failed bind and Node's report of it.
        const onNodeTicks = Scheduler.make((task) => process.nextTick(task));
        const interruptAfter = (steps: number) =>
          Effect.gen(function* () {
            const startup = yield* Effect.fork(
              Effect.flip(
                Effect.scoped(
                  Layer.build(helloWorldServer({ host: "127.0.0.1", port: first.port })),
                ),
              ),
            );
            for (let step = 0; step < steps; step++) yield* Effect.yieldNow();
            return yield* Fiber.interrupt(startup);
          }).pipe(Effect.withScheduler(onNodeTicks));

        let steps = 0;
        let exit = yield* interruptAfter(steps);
        while (Exit.isFailure(exit) && steps < 32) exit = yield* interruptAfter(++steps);
        yield* afterQueuedNodeEvents;

        expect(uncaught.join("\n")).toBe("");
        expect(
          Exit.isSuccess(exit) && exit.value,
          "a listen that failed on its own",
        ).toBeInstanceOf(EffectGrpcServer.GrpcServerBindError);
      }).pipe(Effect.provide(helloWorldServer())),
  );

  // A Layer builds in a scope of its own, so only a direct listen runs in a scope that already
  // closed.
  it.scopedLive(
    "keeps the process up when a listen on a taken port runs in a scope that already closed",
    () =>
      Effect.gen(function* () {
        const uncaught = yield* recordUncaughtExceptions;
        const first = yield* TestServer;
        const server = EffectGrpcServer.GrpcServerBuilder()
          .withService(yield* effectProto.HelloWorldAPIServiceTag)
          .build();
        const closed = yield* Scope.make();
        yield* Scope.close(closed, Exit.void);

        yield* Effect.exit(
          server.listen({ host: "127.0.0.1", port: first.port }).pipe(Scope.extend(closed)),
        );
        yield* afterQueuedNodeEvents;

        expect(uncaught.join("\n")).toBe("");
      }).pipe(
        Effect.provide(helloWorldServer()),
        Effect.provide(
          effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, greeter),
        ),
      ),
  );
});

describe("GrpcServer while it serves", () => {
  it.live("hands each handler its own, empty context values", () =>
    Effect.gen(function* () {
      const first = yield* greet("Ada");
      const second = yield* greet("Ada");

      expect([first.greeting, second.greeting]).toEqual(["0", "0"]);
    }).pipe(Effect.provide(helloWorldClient.pipe(Layer.provideMerge(visitCountingServer)))),
  );

  it.scopedLive(
    "writes nothing to the console for a call, a rejected HTTP/1.1 client, a closed connection or a shutdown",
    () =>
      Effect.gen(function* () {
        const consoleCalls = yield* spyOnConsole;

        const reply = yield* Effect.gen(function* () {
          yield* sendHttp1Request((yield* TestServer).port);
          return yield* greet("Ada");
        }).pipe(Effect.provide(helloWorld()));

        expect(reply.greeting).toBe("Hello, Ada!");
        expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
      }).pipe(Effect.provide(capturingLogs)),
  );
});
