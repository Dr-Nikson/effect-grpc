// packages/effect-grpc/src/server.test.ts
import { Deferred, Effect, Exit, Fiber, Logger, Scope } from "effect";
import dns from "node:dns";
import { readFileSync } from "node:fs";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { create, createFileRegistry } from "@bufbuild/protobuf";
import { serviceDesc } from "@bufbuild/protobuf/codegenv2";
import {
  EmptySchema,
  FileDescriptorProtoSchema,
  file_google_protobuf_empty,
} from "@bufbuild/protobuf/wkt";
import { createClient } from "@connectrpc/connect";
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

const server = Server.GrpcServerBuilder()
  .withService(
    Server.GrpcService(
      "effect_grpc_test.PingService",
      PingService,
    )((executor) => ({
      ping: (request, context) =>
        executor.unary("effect_grpc_test.PingService/Ping", request, context, () =>
          Effect.succeed({}),
        ),
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
  const logger = Logger.make(({ message }) => {
    messages.push((Array.isArray(message) ? message : [message]).map(String).join(" "));
  });
  return { messages, layer: Logger.replace(Logger.defaultLogger, logger) };
};

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
      const first = yield* server.listen({ host: "127.0.0.1", port: 0 });

      const startedAt = Date.now();
      const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: first.port }));
      const elapsed = Date.now() - startedAt;

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
      expect(error.cause).toBeInstanceOf(RangeError);
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
});
