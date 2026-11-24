// packages/effect-grpc/src/server.test.ts
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  LogLevel,
  Logger,
  Scheduler,
  Scope,
} from "effect";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { create, createFileRegistry } from "@bufbuild/protobuf";
import { serviceDesc } from "@bufbuild/protobuf/codegenv2";
import {
  EmptySchema,
  FileDescriptorProtoSchema,
  file_google_protobuf_empty,
} from "@bufbuild/protobuf/wkt";
import type { ContextValues } from "@connectrpc/connect";
import { createClient, createContextKey } from "@connectrpc/connect";
import { Http2SessionManager, createGrpcTransport } from "@connectrpc/connect-node";

import * as Server from "./server.js";

const registry = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: "effect_grpc_test/ping.proto",
    package: "effect_grpc_test",
    dependency: ["google/protobuf/empty.proto"],
    syntax: "proto3",
    service: [
      {
        name: "PingService",
        method: [
          {
            name: "Ping",
            inputType: ".google.protobuf.Empty",
            outputType: ".google.protobuf.Empty",
          },
        ],
      },
    ],
  }),
  (name) => (name === "google/protobuf/empty.proto" ? file_google_protobuf_empty : undefined),
);
const pingFile = registry.getFile("effect_grpc_test/ping.proto");
if (pingFile === undefined) throw new Error("the test descriptor for PingService did not register");

const PingService = serviceDesc<{
  ping: { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
}>(pingFile, 0);

const contextValuesSeen: Array<ContextValues> = [];

const server = Server.GrpcServerBuilder()
  .withService(
    Server.GrpcService(
      "effect_grpc_test.PingService",
      PingService,
    )((executor) => ({
      ping: (request, context) => {
        contextValuesSeen.push(context.values);
        return executor.unary("effect_grpc_test.PingService/Ping", request, context, () =>
          Effect.succeed({}),
        );
      },
    })),
  )
  .build();

const ping = (address: Server.GrpcServerAddress) =>
  Effect.acquireUseRelease(
    Effect.sync(() => new Http2SessionManager(address.url)),
    (sessionManager) =>
      Effect.promise(() =>
        createClient(
          PingService,
          createGrpcTransport({ baseUrl: address.url, sessionManager }),
        ).ping({}),
      ),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

const acceptsConnections = (port: number) =>
  Effect.async<boolean>((resume) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", () => resume(Effect.succeed(false)));
  });

const freePort = Effect.async<number>((resume) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = address !== null && typeof address === "object" ? address.port : 0;
    probe.close(() => resume(Effect.succeed(port)));
  });
});

const captureLogs = () => {
  const messages: Array<string> = [];
  const errors: Array<{ message: string; cause: string }> = [];
  const logger = Logger.make(({ message, logLevel, cause }) => {
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    messages.push(text);
    if (logLevel === LogLevel.Error) errors.push({ message: text, cause: Cause.pretty(cause) });
  });
  return { messages, errors, layer: Logger.replace(Logger.defaultLogger, logger) };
};

/**
 * A failed listen's socket handle closes on a later turn of the event loop and points at its server
 * until then, so the loop turns before the heap is read.
 */
const heapUsedAfterGc = Effect.gen(function* () {
  const { gc } = globalThis;
  if (gc === undefined) {
    return yield* Effect.dieMessage("the tests need --expose-gc, which vitest.config.ts passes");
  }
  yield* Effect.sleep("20 millis");
  gc();
  gc();
  return process.memoryUsage().heapUsed;
});

const connectStatus = (address: Server.GrpcServerAddress) =>
  Effect.async<number>((resume) => {
    const session = http2.connect(address.url);
    session.on("error", () => {});
    const request = session.request({
      ":method": "CONNECT",
      ":authority": `${address.host}:${address.port}`,
    });
    request.on("error", () => {});
    request.on("response", (headers) => {
      request.close();
      session.close();
      resume(Effect.succeed(Number(headers[":status"])));
    });
    return Effect.sync(() => session.destroy());
  }).pipe(Effect.timeout("2 seconds"));

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

const lowPortsArePrivileged = (() => {
  try {
    const start = readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8");
    return process.getuid?.() !== 0 && Number(start) > 1;
  } catch {
    return false;
  }
})();

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<dns.LookupAddress>,
  family?: number,
) => void;

/**
 * Holds the next `dns.lookup` call. Node 24's `listen` passes `{ all: true }` and reads an array of
 * addresses, while earlier Node 22 releases pass only a callback that reads one address.
 */
const holdNextLookup = Effect.gen(function* () {
  const held = yield* Deferred.make<() => void>();
  vi.spyOn(dns, "lookup").mockImplementationOnce((...args: Array<unknown>) => {
    const callback = args[args.length - 1] as LookupCallback;
    const options = args.length > 2 ? (args[1] as dns.LookupOptions) : {};
    const answer = () =>
      options.all === true ?
        callback(null, [{ address: "127.0.0.1", family: 4 }])
      : callback(null, "127.0.0.1", 4);
    Deferred.unsafeDone(held, Effect.succeed(answer));
  });
  return Deferred.await(held);
});

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GrpcServer.listen", () => {
  it("returns the address it bound on port 0, and the server answers there", () =>
    Effect.gen(function* () {
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });

      expect(address.host).toBe("127.0.0.1");
      expect(address.port).toBeGreaterThan(0);
      expect(address.url).toBe(`http://127.0.0.1:${address.port}`);
      const reply = yield* ping(address);
      expect(reply.$typeName).toBe("google.protobuf.Empty");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("serves until its scope closes, then stops and frees the port", () =>
    Effect.gen(function* () {
      const { messages, layer } = captureLogs();

      const address = yield* Effect.scoped(
        Effect.tap(server.listen({ host: "127.0.0.1", port: 0 }), ping),
      ).pipe(Effect.provide(layer));

      expect(yield* acceptsConnections(address.port)).toBe(false);
      expect(messages).toEqual(
        expect.arrayContaining(["gRPC server is stopping...", "gRPC server stopped"]),
      );
    }).pipe(Effect.runPromise));

  it("names the bound port in the ready line, with brackets around an IPv6 address", () =>
    Effect.gen(function* () {
      const { messages, layer } = captureLogs();

      const ipv4 = yield* server.listen({ host: "127.0.0.1", port: 0 }).pipe(Effect.provide(layer));
      const ipv6 = yield* server.listen({ host: "::1", port: 0 }).pipe(Effect.provide(layer));

      expect(ipv6).toMatchObject({ host: "::1", url: `http://[::1]:${ipv6.port}` });
      expect(messages).toContain(`gRPC server listening on http://127.0.0.1:${ipv4.port}`);
      expect(messages).toContain(`gRPC server listening on http://[::1]:${ipv6.port}`);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("fails within one second when the port is taken, and the first server keeps serving", () =>
    Effect.gen(function* () {
      const { errors, layer } = captureLogs();
      const first = yield* server.listen({ host: "127.0.0.1", port: 0 });

      const startedAt = Date.now();
      const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: first.port })).pipe(
        Effect.provide(layer),
      );
      const elapsed = Date.now() - startedAt;

      expect(errors).toEqual([]);
      expect(error).toBeInstanceOf(Server.GrpcServerBindError);
      expect(error).toMatchObject({
        _tag: "@dr_nikson/effect-grpc/server/GrpcServerBindError",
        reason: { _tag: "AddressInUse" },
        host: "127.0.0.1",
        port: first.port,
      });
      expect(error.message).toContain("EADDRINUSE");
      expect(elapsed).toBeLessThan(1000);
      const reply = yield* ping(first);
      expect(reply.$typeName).toBe("google.protobuf.Empty");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("keeps nothing from a failed attempt in the caller's scope, so a retry loop holds no memory", () =>
    Effect.gen(function* () {
      const taken = yield* server.listen({ host: "127.0.0.1", port: 0 });
      const serverErrorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const scope = yield* Scope.make();

      yield* Effect.flip(server.listen({ host: "127.0.0.1", port: taken.port })).pipe(
        Scope.extend(scope),
        Effect.replicateEffect(500, { discard: true }),
      );
      // A logged Node error keeps its server alive until its stack is read, and the spy keeps it.
      serverErrorLog.mockClear();
      const heldWhileOpen = yield* heapUsedAfterGc;
      yield* Scope.close(scope, Exit.void);
      const releasedOnClose = heldWhileOpen - (yield* heapUsedAfterGc);

      expect(releasedOnClose).toBeLessThan(2_000_000);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("fails with PermissionDenied when listen reports EACCES", () =>
    Effect.gen(function* () {
      const denied = Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:80"), {
        code: "EACCES",
        errno: -13,
        syscall: "listen",
        address: "127.0.0.1",
        port: 80,
      });
      vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (this: net.Server) {
        process.nextTick(() => this.emit("error", denied));
        return this;
      });

      const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: 80 }));

      expect(error).toMatchObject({
        reason: { _tag: "PermissionDenied" },
        host: "127.0.0.1",
        port: 80,
      });
      expect(error.cause).toBe(denied);
      expect(error.message).toContain("EACCES");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("reads the code of an error from another realm, as Jest and Vitest's VM pools report it", () =>
    Effect.gen(function* () {
      const inUse = Object.assign(
        vm.runInNewContext(`new Error("listen EADDRINUSE: address already in use 127.0.0.1:8000")`),
        { code: "EADDRINUSE", errno: -98, syscall: "listen", address: "127.0.0.1", port: 8000 },
      );
      vi.spyOn(net.Server.prototype, "listen").mockImplementationOnce(function (this: net.Server) {
        process.nextTick(() => this.emit("error", inUse));
        return this;
      });

      const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: 8000 }));

      expect(inUse).not.toBeInstanceOf(Error);
      expect(error.reason).toEqual({ _tag: "AddressInUse" });
      expect(error.message).toBe(
        "gRPC server could not listen on 127.0.0.1:8000 (AddressInUse): listen EADDRINUSE: address already in use 127.0.0.1:8000",
      );
    }).pipe(Effect.scoped, Effect.runPromise));

  it.skipIf(!lowPortsArePrivileged)(
    "fails with PermissionDenied when the kernel refuses a privileged port",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: 1 }));

        expect(error.reason).toEqual({ _tag: "PermissionDenied" });
        expect(error.message).toContain("EACCES");
      }).pipe(Effect.scoped, Effect.runPromise),
  );

  it("fails with InvalidPort when the port is out of range", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: 65536 }));

      expect(error).toMatchObject({ reason: { _tag: "InvalidPort" }, port: 65536 });
      expect(error.cause).toMatchObject({ name: "RangeError", code: "ERR_SOCKET_BAD_PORT" });
    }).pipe(Effect.scoped, Effect.runPromise));

  it("ends startup when interrupted during a host lookup that never returns, and binds nothing later", () =>
    Effect.gen(function* () {
      const port = yield* freePort;
      const lookupHeld = yield* holdNextLookup;

      const startup = yield* Effect.fork(server.listen({ host: "grpc-server.test", port }));
      const answerLookup = yield* lookupHeld;
      const exit = yield* Fiber.interrupt(startup);

      expect(Exit.isInterrupted(exit)).toBe(true);
      answerLookup();
      expect(yield* acceptsConnections(port)).toBe(false);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("ends startup when its scope closes during a host lookup, and logs no ready or shutdown line", () =>
    Effect.gen(function* () {
      const { messages, layer } = captureLogs();
      const port = yield* freePort;
      const lookupHeld = yield* holdNextLookup;
      const scope = yield* Scope.make();

      const startup = yield* Effect.forkDaemon(
        server
          .listen({ host: "grpc-server.test", port })
          .pipe(Scope.extend(scope), Effect.provide(layer)),
      );
      const answerLookup = yield* lookupHeld;
      yield* Scope.close(scope, Exit.void);
      const exit = yield* Fiber.await(startup);

      expect(Exit.isInterrupted(exit)).toBe(true);
      answerLookup();
      expect(yield* acceptsConnections(port)).toBe(false);
      expect(messages.filter((message) => message.startsWith("gRPC server"))).toEqual([]);
    }).pipe(Effect.runPromise));

  it("keeps the process up when a failing sibling layer interrupts a listen on a taken port", () =>
    Effect.gen(function* () {
      const uncaught = yield* recordUncaughtExceptions;
      const first = yield* server.listen({ host: "", port: 0 });

      // With an empty host, Node binds inside listen() and reports the failure on its next tick.
      const error = yield* Effect.flip(
        Layer.launch(
          Layer.mergeAll(
            Layer.scopedDiscard(server.listen({ host: "", port: first.port })),
            Layer.effectDiscard(Effect.fail("a sibling layer failed")),
          ),
        ),
      );
      yield* afterQueuedNodeEvents;

      expect(error).toBe("a sibling layer failed");
      expect(uncaught.join("\n")).toBe("");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("keeps the process up wherever an interrupt lands in a listen on a taken port", () =>
    Effect.gen(function* () {
      const uncaught = yield* recordUncaughtExceptions;
      const first = yield* server.listen({ host: "127.0.0.1", port: 0 });
      // Fiber steps on Node's tick queue can run between a failed bind and Node's report of it.
      const onNodeTicks = Scheduler.make((task) => process.nextTick(task));
      const interruptAfter = (steps: number) =>
        Effect.gen(function* () {
          const startup = yield* Effect.fork(
            Effect.flip(Effect.scoped(server.listen({ host: "127.0.0.1", port: first.port }))),
          );
          for (let step = 0; step < steps; step++) yield* Effect.yieldNow();
          return yield* Fiber.interrupt(startup);
        }).pipe(Effect.withScheduler(onNodeTicks));

      let steps = 0;
      let exit = yield* interruptAfter(steps);
      while (Exit.isFailure(exit) && steps < 32) exit = yield* interruptAfter(++steps);
      yield* afterQueuedNodeEvents;

      expect(uncaught.join("\n")).toBe("");
      expect(Exit.isSuccess(exit) && exit.value, "a listen that failed on its own").toBeInstanceOf(
        Server.GrpcServerBindError,
      );
    }).pipe(Effect.scoped, Effect.runPromise));

  it("keeps the process up when a listen on a taken port runs in a scope that already closed", () =>
    Effect.gen(function* () {
      const uncaught = yield* recordUncaughtExceptions;
      const first = yield* server.listen({ host: "127.0.0.1", port: 0 });
      const closed = yield* Scope.make();
      yield* Scope.close(closed, Exit.void);

      yield* Effect.exit(
        server.listen({ host: "127.0.0.1", port: first.port }).pipe(Scope.extend(closed)),
      );
      yield* afterQueuedNodeEvents;

      expect(uncaught.join("\n")).toBe("");
    }).pipe(Effect.scoped, Effect.runPromise));
});

describe("GrpcServer while it serves", () => {
  it("answers an HTTP/2 CONNECT request with 405 instead of leaving its stream open", () =>
    Effect.gen(function* () {
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });

      expect(yield* connectStatus(address)).toBe(405);
      const reply = yield* ping(address);
      expect(reply.$typeName).toBe("google.protobuf.Empty");
    }).pipe(Effect.scoped, Effect.runPromise));

  it("hands each handler its own, empty context values", () =>
    Effect.gen(function* () {
      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
      contextValuesSeen.length = 0;
      yield* ping(address);
      yield* ping(address);

      const unset = createContextKey("no default replaced", { description: "a key nothing sets" });
      expect(contextValuesSeen).toHaveLength(2);
      expect(contextValuesSeen[0]).not.toBe(contextValuesSeen[1]);
      expect(contextValuesSeen.map((values) => values.get(unset))).toEqual([
        "no default replaced",
        "no default replaced",
      ]);
    }).pipe(Effect.scoped, Effect.runPromise));

  it("writes nothing to the console for a call, a rejected HTTP/1.1 client, a closed connection or a shutdown", () =>
    Effect.gen(function* () {
      const consoleCalls = (["debug", "error", "info", "log", "warn"] as const).map((method) =>
        vi.spyOn(console, method),
      );
      const { layer } = captureLogs();

      const reply = yield* Effect.gen(function* () {
        const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
        yield* sendHttp1Request(address.port);
        return yield* ping(address);
      }).pipe(Effect.scoped, Effect.provide(layer));

      expect(reply.$typeName).toBe("google.protobuf.Empty");
      expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
    }).pipe(Effect.runPromise));

  it("keeps serving and reports through the Effect logger an error the listening server emits", () =>
    Effect.gen(function* () {
      const created = vi.spyOn(http2, "createServer");
      const { errors, layer } = captureLogs();
      const address = yield* server
        .listen({ host: "127.0.0.1", port: 0 })
        .pipe(Effect.provide(layer));
      const listening = created.mock.results[0]?.value as http2.Http2Server;
      const emfile = Object.assign(new Error("accept EMFILE: too many open files"), {
        code: "EMFILE",
        errno: -24,
        syscall: "accept",
      });

      expect(() => listening.emit("error", emfile)).not.toThrow();

      expect(errors).toEqual([
        { message: "gRPC server error", cause: expect.stringContaining("accept EMFILE") },
      ]);
      const reply = yield* ping(address);
      expect(reply.$typeName).toBe("google.protobuf.Empty");
    }).pipe(Effect.scoped, Effect.runPromise));
});
