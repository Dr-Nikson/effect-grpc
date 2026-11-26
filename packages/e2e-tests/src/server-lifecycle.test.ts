// packages/e2e-tests/src/server-lifecycle.test.ts
import { Effect, Layer, Logger } from "effect";
import { readFileSync } from "node:fs";

import { Code } from "@connectrpc/connect";
import { EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import { TestServer, effectProto, testClient, testServer } from "./test-fixtures.js";

const service = effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, {
  getGreeting: ({ name }) => Effect.succeed({ greeting: `Hello, ${name}!` }),
  faceTheError: () => Effect.fail(GrpcException.create(Code.FailedPrecondition, "not called")),
});

const greet = (name: string) =>
  Effect.flatMap(effectProto.HelloWorldAPIClientTag, (client) => client.getGreeting({ name }, {}));

const failedToBind = (listen: { readonly host: string; readonly port: number }) =>
  Effect.flip(Layer.build(testServer(listen)));

const textOf = (message: unknown): string =>
  (Array.isArray(message) ? message : [message]).map(String).join(" ");

const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    lines.push(textOf(message));
  });
  return { lines, layer: Logger.replace(Logger.defaultLogger, logger) };
};

const lowPortsArePrivileged = (() => {
  try {
    const start = readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8");
    return process.getuid?.() !== 0 && Number(start) > 1;
  } catch {
    return false;
  }
})();

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
      }).pipe(
        Effect.provide(testClient),
        Effect.provide(testServer({ host: "127.0.0.1", port: 0 })),
        Effect.provide(service),
      ),
  );

  it.scopedLive("stops when its scope closes, logs that it stops, and frees its port", () => {
    const { lines, layer } = captureLogs();

    return Effect.gen(function* () {
      const first = yield* Effect.tap(TestServer, () => greet("Ada")).pipe(
        Effect.provide(testClient),
        Effect.provide(testServer({ host: "127.0.0.1", port: 0 })),
      );

      expect(lines).toEqual(
        expect.arrayContaining(["gRPC server is stopping...", "gRPC server stopped"]),
      );
      const again = yield* greet("Ada").pipe(
        Effect.provide(testClient),
        Effect.provide(testServer({ host: "127.0.0.1", port: first.port })),
      );
      expect(again.greeting, "a server on the freed port").toBe("Hello, Ada!");
    }).pipe(Effect.provide(layer), Effect.provide(service));
  });

  // No client call over ::1: on this branch the generated client's IPv6 authority stops the process.
  it.scopedLive(
    "names the bound url in its ready line, with brackets around an IPv6 address",
    () => {
      const { lines, layer } = captureLogs();

      return Effect.gen(function* () {
        const ipv4 = yield* TestServer;
        const ipv6 = yield* TestServer.pipe(Effect.provide(testServer({ host: "::1", port: 0 })));

        expect(lines).toContain(`gRPC server listening on http://127.0.0.1:${ipv4.port}`);
        expect(lines).toContain(`gRPC server listening on http://[::1]:${ipv6.port}`);
        expect(ipv6).toEqual({ host: "::1", port: ipv6.port, url: `http://[::1]:${ipv6.port}` });
      }).pipe(
        Effect.provide(testServer({ host: "127.0.0.1", port: 0 })),
        Effect.provide(layer),
        Effect.provide(service),
      );
    },
  );

  it.scopedLive(
    "fails with AddressInUse within a second when the port is taken, logs no server line for it, and the first server keeps serving",
    () => {
      const { lines, layer } = captureLogs();

      return Effect.gen(function* () {
        const first = yield* TestServer;

        const error = yield* failedToBind({ host: "127.0.0.1", port: first.port }).pipe(
          Effect.timeout("1 second"),
        );

        expect(error).toBeInstanceOf(EffectGrpcServer.GrpcServerBindError);
        expect(error).toMatchObject({
          reason: { _tag: "AddressInUse" },
          host: "127.0.0.1",
          port: first.port,
          cause: { code: "EADDRINUSE" },
        });
        const messageStart = `gRPC server could not listen on 127.0.0.1:${first.port} (AddressInUse): `;
        expect(error.message.startsWith(messageStart), error.message).toBe(true);
        expect(lines.filter((line) => line.startsWith("gRPC server"))).toEqual([
          `gRPC server listening on http://127.0.0.1:${first.port}`,
        ]);
        const reply = yield* greet("Ada").pipe(Effect.provide(testClient));
        expect(reply.greeting).toBe("Hello, Ada!");
      }).pipe(
        Effect.provide(testServer({ host: "127.0.0.1", port: 0 })),
        Effect.provide(layer),
        Effect.provide(service),
      );
    },
  );

  it.scopedLive.skipIf(!lowPortsArePrivileged)(
    "fails with PermissionDenied when the OS refuses a privileged port (needs a host where port 1 is privileged)",
    () =>
      Effect.gen(function* () {
        const error = yield* failedToBind({ host: "127.0.0.1", port: 1 });

        expect(error).toMatchObject({
          reason: { _tag: "PermissionDenied" },
          host: "127.0.0.1",
          port: 1,
          cause: { code: "EACCES" },
        });
      }).pipe(Effect.provide(service)),
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
      at: "an address that this host does not have",
      host: "192.0.2.1",
      port: 0,
      code: "EADDRNOTAVAIL",
    },
  ])(
    "fails with $reason for $at, with the $code error that Node reported as the cause",
    ({ reason, host, port, code }) =>
      Effect.gen(function* () {
        const error = yield* failedToBind({ host, port });

        expect(error).toMatchObject({ reason: { _tag: reason }, host, port, cause: { code } });
      }).pipe(Effect.provide(service)),
  );
});
