// packages/e2e-tests/src/server-lifecycle.test.ts
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Scope } from "effect";
import { readFileSync } from "node:fs";
import net from "node:net";
import { vi } from "vitest";

import { Code } from "@connectrpc/connect";
import { EffectGrpcServer, GrpcException } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as raw from "./raw-unary.js";
import type { GetGreetingRequest } from "./generated/com/example/v1/hello_world_api_pb.js";
import { clientLayer, effectProto, greet, serverFor } from "./test-fixtures.js";

const greeter: effectProto.HelloWorldAPIService = {
  getGreeting: ({ name }) => Effect.succeed({ greeting: `Hello, ${name}!` }),
  faceTheError: () => Effect.fail(GrpcException.create(Code.FailedPrecondition, "not called")),
};

const signalThenWait = (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)));

const heldUntil =
  (started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) =>
  ({ name }: GetGreetingRequest) =>
    signalThenWait(started, release).pipe(Effect.as({ greeting: `Hello, ${name}!` }));

const textOf = (message: unknown): string =>
  (Array.isArray(message) ? message : [message]).map(String).join(" ");

const captureLogs = () => {
  const lines: Array<string> = [];
  const errors: Array<string> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    lines.push(textOf(message));
    if (logLevel === "Error") errors.push(textOf(message));
  });
  return { lines, errors, layer: Logger.layer([logger]) };
};

/**
 * A scope that the test's scope closes too, so a server in it stops even when an assertion fails
 * before the test closes it.
 */
const childScope = Effect.flatMap(Effect.scope, (scope) => Scope.fork(scope, "sequential"));

const lowPortsArePrivileged = (() => {
  try {
    const start = readFileSync("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8");
    return process.getuid?.() !== 0 && Number(start) > 1;
  } catch {
    return false;
  }
})();

const tcpClientThatSendsNothing = (address: EffectGrpcServer.GrpcServerAddress) =>
  Effect.acquireRelease(
    Effect.callback<net.Socket>((resume) => {
      const socket = net.connect(address.port, address.host).on("error", () => {});
      socket.once("connect", () => resume(Effect.succeed(socket.resume())));
    }),
    (socket) => Effect.sync(() => socket.destroy()),
  );

const sendHttp1Request = (address: EffectGrpcServer.GrpcServerAddress) =>
  Effect.callback<void>((resume) => {
    const socket = net.connect(address.port, address.host, () => {
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
    });
    socket.on("error", () => {});
    socket.once("close", () => resume(Effect.void));
    socket.resume();
    return Effect.sync(() => socket.destroy());
  }).pipe(Effect.timeout("2 seconds"));

describe("GrpcServer.listen", () => {
  it.live("binds a free port for port 0, reports it, and serves the generated client there", () =>
    Effect.gen(function* () {
      const server = yield* serverFor(greeter);

      const address = yield* server.listen({ host: "127.0.0.1", port: 0 });

      expect(address.port).toBeGreaterThan(0);
      expect(address).toEqual({
        host: "127.0.0.1",
        port: address.port,
        url: `http://127.0.0.1:${address.port}`,
      });
      expect((yield* greet(address, "Ada")).greeting).toBe("Hello, Ada!");
    }),
  );

  it.live("names the bound address in its ready line, with brackets around an IPv6 address", () =>
    Effect.gen(function* () {
      const { lines, layer } = captureLogs();
      const server = yield* serverFor(greeter);

      const ipv4 = yield* server.listen({ host: "127.0.0.1", port: 0 }).pipe(Effect.provide(layer));
      const ipv6 = yield* server.listen({ host: "::1", port: 0 }).pipe(Effect.provide(layer));

      expect(lines).toContain(`gRPC server listening on http://127.0.0.1:${ipv4.port}`);
      expect(lines).toContain(`gRPC server listening on http://[::1]:${ipv6.port}`);
      expect(ipv6.url).toBe(`http://[::1]:${ipv6.port}`);
      expect((yield* greet(ipv6, "Ada")).greeting).toBe("Hello, Ada!");
    }),
  );

  it.live(
    "fails with AddressInUse within a second when the port is taken, logs no error, and the first server keeps serving",
    () =>
      Effect.gen(function* () {
        const { errors, layer } = captureLogs();
        const server = yield* serverFor(greeter);
        const first = yield* server.listen({ host: "127.0.0.1", port: 0 });

        const error = yield* server
          .listen({ host: "127.0.0.1", port: first.port })
          .pipe(Effect.flip, Effect.timeout("1 second"), Effect.provide(layer));

        expect(error).toBeInstanceOf(EffectGrpcServer.GrpcServerBindError);
        expect(error).toMatchObject({
          reason: { _tag: "AddressInUse" },
          host: "127.0.0.1",
          port: first.port,
        });
        expect(errors).toEqual([]);
        expect((yield* greet(first, "Ada")).greeting).toBe("Hello, Ada!");
      }),
  );

  it.live.each([
    { reason: "InvalidPort", at: "a port above 65535", host: "127.0.0.1", port: 65536 },
    { reason: "Other", at: "an address that this host does not have", host: "192.0.2.1", port: 0 },
  ])("fails with $reason for $at", ({ reason, host, port }) =>
    Effect.gen(function* () {
      const server = yield* serverFor(greeter);

      const error = yield* Effect.flip(server.listen({ host, port }));

      expect(error).toMatchObject({ reason: { _tag: reason }, host, port });
    }),
  );

  it.live.skipIf(!lowPortsArePrivileged)(
    "fails with PermissionDenied when the OS refuses a privileged port (needs a host where port 1 is privileged)",
    () =>
      Effect.gen(function* () {
        const server = yield* serverFor(greeter);

        const error = yield* Effect.flip(server.listen({ host: "127.0.0.1", port: 1 }));

        expect(error).toMatchObject({ reason: { _tag: "PermissionDenied" }, port: 1 });
      }),
  );

  it.live("stops when its scope closes, logs that it stops, and frees its port", () =>
    Effect.gen(function* () {
      const { lines, layer } = captureLogs();
      const server = yield* serverFor(greeter);

      const first = yield* Effect.scoped(
        Effect.tap(server.listen({ host: "127.0.0.1", port: 0 }), (address) =>
          greet(address, "Ada"),
        ),
      ).pipe(Effect.provide(layer));

      expect(lines).toEqual(
        expect.arrayContaining(["gRPC server is stopping...", "gRPC server stopped"]),
      );
      const again = yield* server.listen({ host: "127.0.0.1", port: first.port });
      expect((yield* greet(again, "Ada")).greeting, "a server on the freed port").toBe(
        "Hello, Ada!",
      );
    }),
  );

  it.live("writes nothing to the console for a call, an HTTP/1.1 client, and a shutdown", () =>
    Effect.gen(function* () {
      const consoleCalls = yield* Effect.acquireRelease(
        Effect.sync(() =>
          (["debug", "error", "info", "log", "warn"] as const).map((method) =>
            vi.spyOn(console, method),
          ),
        ),
        (spies) => Effect.sync(() => spies.forEach((spy) => spy.mockRestore())),
      );

      yield* Effect.gen(function* () {
        const server = yield* serverFor(greeter);
        const address = yield* server.listen({ host: "127.0.0.1", port: 0 });
        yield* sendHttp1Request(address);
        yield* greet(address, "Ada");
      }).pipe(Effect.scoped, Effect.provide(captureLogs().layer));

      expect(consoleCalls.flatMap((spy) => spy.mock.calls)).toEqual([]);
    }),
  );
});

const idleClients = [
  {
    client: "the generated client",
    connect: (address: EffectGrpcServer.GrpcServerAddress) =>
      Effect.gen(function* () {
        const services = yield* Layer.build(clientLayer(address));
        const client = Context.get(services, effectProto.HelloWorldAPIClientTag);
        yield* client.getGreeting({ name: "Ada" }, {});
      }),
  },
  { client: "a TCP client that sends nothing", connect: tcpClientThatSendsNothing },
];

class Greetings extends Context.Service<
  Greetings,
  { readonly greetingFor: (name: string) => Effect.Effect<string> }
>()("e2e/Greetings") {}

describe("GrpcServer at shutdown", () => {
  it.live.each(idleClients)(
    "stops within a second while $client stays connected and idle",
    ({ connect }) =>
      Effect.gen(function* () {
        const serverScope = yield* childScope;
        const server = yield* serverFor(greeter);
        const address = yield* server
          .listen({ host: "127.0.0.1", port: 0 })
          .pipe(Scope.provide(serverScope));
        yield* connect(address);

        const stopping = yield* Effect.forkDetach(Scope.close(serverScope, Exit.void));
        const stopped = yield* Fiber.await(stopping).pipe(Effect.timeoutOption("1 second"));

        expect(Option.isSome(stopped), "the server stopped within one second").toBe(true);
      }),
  );

  it.live(
    "tells a client whose call runs to send no new calls, lets the call finish, and stops when it ends",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const goaway = yield* Deferred.make<void>();
        const serverScope = yield* childScope;
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        const server = yield* serverFor({ ...greeter, getGreeting: heldUntil(started, release) });
        const address = yield* server
          .listen({ host: "127.0.0.1", port: 0 })
          .pipe(Scope.provide(serverScope));
        const session = yield* raw.connect(address.url);
        session.once("goaway", () => Deferred.doneUnsafe(goaway, Effect.void));

        const call = yield* Effect.forkChild(
          raw.getGreeting(session, "grpc", new URL(address.url).host, "Ada"),
        );
        yield* Deferred.await(started);
        const stopping = yield* Effect.forkDetach(Scope.close(serverScope, Exit.void));
        const toldToStop = yield* Deferred.await(goaway).pipe(Effect.timeoutOption("1 second"));
        const nextCall = yield* Effect.flip(greet(address, "Bob"));
        yield* Deferred.succeed(release, undefined);
        const reply = yield* Fiber.join(call);
        const stopped = yield* Fiber.await(stopping).pipe(Effect.timeoutOption("1 second"));

        expect(Option.isSome(toldToStop), "the client got GOAWAY while its call ran").toBe(true);
        expect(nextCall.code, "a call after the shutdown began").toBe(Code.Unavailable);
        expect(reply.greeting, "the call in flight").toBe("Hello, Ada!");
        expect(Option.isSome(stopped), "the server stopped once the call ended").toBe(true);
      }),
  );

  it.live("stops, as a launched layer, before it releases the layer that its handler uses", () =>
    Effect.gen(function* () {
      const events: Array<string> = [];
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stopping = yield* Deferred.make<void>();
      const bound = yield* Deferred.make<EffectGrpcServer.GrpcServerAddress>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));

      const greetingsLayer = Layer.effect(
        Greetings,
        Effect.acquireRelease(
          Effect.sync(() => ({ open: true })),
          (store) =>
            Effect.sync(() => {
              store.open = false;
              events.push("the greetings store closed");
            }),
        ).pipe(
          Effect.map((store) =>
            Greetings.of({
              greetingFor: (name) =>
                Effect.sync(() => (store.open ? `Hello, ${name}!` : "the store is closed")),
            }),
          ),
        ),
      );
      const serviceLayer = Layer.unwrap(
        Effect.gen(function* () {
          const greetings = yield* Greetings;
          return effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, {
            ...greeter,
            getGreeting: ({ name }) =>
              signalThenWait(started, release).pipe(
                Effect.andThen(greetings.greetingFor(name)),
                Effect.map((greeting) => ({ greeting })),
              ),
          });
        }),
      );
      const serverLayer = Layer.effectDiscard(
        Effect.gen(function* () {
          const service = yield* effectProto.HelloWorldAPIServiceTag;
          const server = EffectGrpcServer.GrpcServerBuilder().withService(service).build();
          yield* Deferred.succeed(bound, yield* server.listen({ host: "127.0.0.1", port: 0 }));
        }),
      );
      const stopLines = Logger.layer([
        Logger.make(({ message }) => {
          if (textOf(message) === "gRPC server is stopping...") {
            Deferred.doneUnsafe(stopping, Effect.void);
          }
          if (textOf(message) === "gRPC server stopped") events.push("gRPC server stopped");
        }),
      ]);

      const launched = yield* Effect.forkChild(
        Layer.launch(
          serverLayer.pipe(Layer.provide(serviceLayer.pipe(Layer.provide(greetingsLayer)))),
        ).pipe(Effect.provide(stopLines)),
      );
      const call = yield* Effect.forkChild(greet(yield* Deferred.await(bound), "Ada"));
      yield* Deferred.await(started);
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(launched));
      yield* Deferred.await(stopping);
      yield* Deferred.succeed(release, undefined);

      expect((yield* Fiber.join(call)).greeting, "the call in flight read an open store").toBe(
        "Hello, Ada!",
      );
      yield* Fiber.join(interrupting);
      expect(events).toEqual(["gRPC server stopped", "the greetings store closed"]);
    }),
  );
});
