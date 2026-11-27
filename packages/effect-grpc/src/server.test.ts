// packages/effect-grpc/src/server.test.ts
import { Array as Arr, Context, Effect, Layer, Logger, Ref } from "effect";

import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import { TestServer, greet, helloWorld, helloWorldServer } from "./testing/harness.js";

class ServerLogs extends Context.Tag("ServerLogs")<ServerLogs, Ref.Ref<ReadonlyArray<string>>>() {}

const textOf = (message: unknown): string =>
  (Arr.isArray(message) ? message : [message]).map(String).join(" ");

const capturingLogs = Layer.unwrapEffect(
  Effect.gen(function* () {
    const lines = yield* Ref.make<ReadonlyArray<string>>([]);
    const logger = Logger.make(({ message }) =>
      Effect.runSync(Ref.update(lines, Arr.append(textOf(message)))),
    );
    return Layer.merge(
      Logger.replace(Logger.defaultLogger, logger),
      Layer.succeed(ServerLogs, lines),
    );
  }),
);

const loggedLines = Effect.flatMap(ServerLogs, Ref.get);

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
      at: "an address that this host does not have",
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
});
