// packages/effect-grpc/src/server.requests.test.ts
import { Cause, Effect, ExecutionStrategy, Exit, Layer, Option, Scope } from "effect";

import type { HandlerContext } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import { EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as namingProto from "./generated/com/example/v1/naming_test_service_effect.js";
import {
  TestServer,
  clientTo,
  connectErrorOf,
  freePort,
  greet,
  greeter,
  helloWorldClient,
  testServer,
} from "./testing/harness.js";
import type { Listen } from "./testing/harness.js";
import { rawClient, send } from "./testing/rawHttp2.js";

const MiB = 1024 * 1024;

// A handler sees the host that the server read from the request, so echoing it shows how the
// server read an authority.
const echo: effectProto.HelloWorldAPIService<HandlerContext> = {
  getGreeting: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
  faceTheError: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
};

const echoServer = (listen?: Listen, options?: EffectGrpcServer.GrpcServerOptions) =>
  testServer(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, echo),
    Effect.map(effectProto.HelloWorldAPIServiceTag, (service) =>
      EffectGrpcServer.GrpcServerBuilder()
        .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
        .withService(service)
        .build(options),
    ),
    listen,
  );

const echoing = (listen?: Listen, options?: EffectGrpcServer.GrpcServerOptions) =>
  Layer.mergeAll(helloWorldClient, rawClient).pipe(Layer.provideMerge(echoServer(listen, options)));

const hostOfServer = Effect.map(TestServer, ({ url }) => new URL(url).host);

interface AuthorityCase {
  readonly name: string;
  readonly authority: string;
  readonly header?: ":authority" | "host";
  /** The host that a handler sees, or none when the server refuses the authority. */
  readonly host: Option.Option<string>;
}

const authorities: ReadonlyArray<AuthorityCase> = [
  {
    name: "serves the authority that Node's HTTP/2 client sends for http://[::1]:50051",
    authority: "::1:50051",
    host: Option.some("[::1]:50051"),
  },
  {
    name: "serves an unbracketed IPv6 authority whose port is also a valid IPv6 group",
    authority: "::1:8080",
    host: Option.some("[::1]:8080"),
  },
  {
    name: "serves an unbracketed global IPv6 authority",
    authority: "2001:db8::1:8443",
    host: Option.some("[2001:db8::1]:8443"),
  },
  {
    name: "serves a bracketed IPv6 authority",
    authority: "[::1]:50051",
    host: Option.some("[::1]:50051"),
  },
  {
    name: "serves a host name authority",
    authority: "localhost:50051",
    host: Option.some("localhost:50051"),
  },
  {
    name: "serves a 10 KiB host name",
    authority: "a".repeat(10 * 1024),
    host: Option.some("a".repeat(10 * 1024)),
  },
  {
    name: "serves an authority that arrives in the host header",
    authority: "::1:50051",
    header: "host",
    host: Option.some("[::1]:50051"),
  },
  { name: "refuses an out-of-range port", authority: "localhost:99999", host: Option.none() },
  { name: "refuses a non-numeric port", authority: "localhost:abc", host: Option.none() },
  { name: "refuses an unclosed IPv6 bracket", authority: "[::1", host: Option.none() },
  {
    name: "refuses an unbracketed IPv6 address with no port",
    authority: "::1",
    host: Option.none(),
  },
  {
    name: "refuses an unbracketed IPv6 address with a zone ID",
    authority: "fe80::1%eth0:8080",
    host: Option.none(),
  },
  {
    name: "refuses a 10 KiB run of digits",
    authority: "1".repeat(10 * 1024),
    host: Option.none(),
  },
  {
    name: "refuses a malformed authority that arrives in the host header",
    authority: "localhost:99999",
    header: "host",
    host: Option.none(),
  },
];

const servedAs = (host: string) => ({ greeting: Option.some(host) });
const refusedOverGrpc = {
  httpStatus: Option.some(200),
  status: Option.some(String(Code.InvalidArgument)),
};
const refusedOverConnect = {
  httpStatus: Option.some(400),
  status: Option.some("invalid_argument"),
};

// A request message of this many bytes holds a name of this many bytes less than that, because a
// tag byte and a four-byte length precede the name. That holds for messages from 2 MiB to 256 MiB.
const nameFor = (messageBytes: number): string => "x".repeat(messageBytes - 5);

const limitsMessagesTo = (limit: number) =>
  Effect.gen(function* () {
    const host = yield* hostOfServer;
    const atLimit = yield* greet(nameFor(limit));
    const overLimit = yield* connectErrorOf(greet(nameFor(limit + 1)));
    const next = yield* greet("next");

    expect({
      atLimit: atLimit.greeting,
      overLimit: Option.map(overLimit, ({ code }) => code),
      next: next.greeting,
    }).toEqual({ atLimit: host, overLimit: Option.some(Code.ResourceExhausted), next: host });
  });

const namingClient = clientTo(
  namingProto.NamingTestServiceConfigTag,
  namingProto.namingTestServiceClientLiveLayer(namingProto.NamingTestServiceClientTag),
);

const helloWorldAndNaming = testServer(
  Layer.mergeAll(
    effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, greeter),
    namingProto.namingTestServiceLiveLayer(namingProto.NamingTestServiceTag, {
      echo: ({ message }) => Effect.succeed({ message: `echo ${message}` }),
    }),
  ),
  Effect.gen(function* () {
    return EffectGrpcServer.GrpcServerBuilder()
      .withService(yield* effectProto.HelloWorldAPIServiceTag)
      .withService(yield* namingProto.NamingTestServiceTag)
      .build();
  }),
);

// Vitest cuts a `$name` in a title at 40 characters, which would make two of these rows read alike.
describe("a request authority over gRPC, gRPC-web and Connect", () => {
  authorities.forEach(({ name, authority, header, host }) =>
    it.live(`${name}, and the generated client is served afterwards`, () =>
      Effect.gen(function* () {
        const replies = yield* Effect.all({
          grpc: send({ protocol: "grpc", authority, header }),
          "grpc-web": send({ protocol: "grpc-web", authority, header }),
          connect: send({ protocol: "connect", authority, header }),
        });

        expect(replies).toMatchObject(
          Option.match(host, {
            onSome: (host) => ({
              grpc: servedAs(host),
              "grpc-web": servedAs(host),
              connect: servedAs(host),
            }),
            onNone: () => ({
              grpc: refusedOverGrpc,
              "grpc-web": refusedOverGrpc,
              connect: refusedOverConnect,
            }),
          }),
        );
        expect((yield* greet("next")).greeting).toBe(yield* hostOfServer);
      }).pipe(Effect.provide(echoing())),
    ),
  );
});

describe("the generated client", () => {
  it.live("is served at an IPv6 literal address", () =>
    Effect.gen(function* () {
      const { port } = yield* TestServer;

      expect((yield* greet("Ada")).greeting).toBe(`[::1]:${port}`);
    }).pipe(Effect.provide(echoing({ host: "::1", port: 0 }))),
  );
});

describe("the request message limit", () => {
  it.live(
    "serves a message of exactly 4 MiB and refuses one byte more with RESOURCE_EXHAUSTED",
    () => limitsMessagesTo(4 * MiB).pipe(Effect.provide(echoing())),
  );

  it.live("serves a message of exactly a readMaxBytes above 4 MiB and refuses one byte more", () =>
    limitsMessagesTo(5 * MiB).pipe(Effect.provide(echoing(freePort, { readMaxBytes: 5 * MiB }))),
  );

  it.scopedLive.each([Number.NaN, 0, -1, 1.5, 2 ** 32, Number.POSITIVE_INFINITY])(
    "fails to build a server whose readMaxBytes is %s",
    (readMaxBytes) =>
      Effect.gen(function* () {
        const cause = yield* Effect.flip(
          Effect.sandbox(Layer.build(echoServer(freePort, { readMaxBytes }))),
        );

        expect(Option.map(Cause.dieOption(cause), Cause.isIllegalArgumentException)).toEqual(
          Option.some(true),
        );
      }),
  );
});

describe("a server with two services", () => {
  it.live(
    "serves each service through its generated client, one of them named ...Service (#30)",
    () =>
      Effect.gen(function* () {
        const hello = yield* greet("Ada");
        const naming = yield* Effect.flatMap(namingProto.NamingTestServiceClientTag, (client) =>
          client.echo({ message: "Ada" }, {}),
        );

        expect({ hello: hello.greeting, naming: naming.message }).toEqual({
          hello: "Hello, Ada!",
          naming: "echo Ada",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(helloWorldClient, namingClient).pipe(
            Layer.provideMerge(helloWorldAndNaming),
          ),
        ),
      ),
  );
});

// closeUnreadRequest (server.internal.ts) exists because connect-node stops reading a request that
// it refuses, and Node keeps that stream until the request is read to the end, so a client that
// kept sending held up graceful shutdown. The operator kept the code on 2026-11-27 and asked for
// this one scoped test of it. It replaces the three timing-based checks that the 2026-11-25
// decision on #84 dropped.
describe("closing the server after it refused an oversized message", () => {
  it.scopedLive(
    "completes within 2 s while the generated client that sent it is still connected",
    () =>
      Effect.gen(function* () {
        const serverScope = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);
        const server = yield* Layer.buildWithScope(echoServer(), serverScope);
        const client = yield* Layer.build(helloWorldClient).pipe(Effect.provide(server));

        const refusal = yield* connectErrorOf(greet(nameFor(5 * MiB))).pipe(Effect.provide(client));
        expect(Option.map(refusal, ({ code }) => code)).toEqual(
          Option.some(Code.ResourceExhausted),
        );

        // The stop runs in an uninterruptible finalizer, so the deadline must not wait for it.
        const stopped = yield* Scope.close(serverScope, Exit.void).pipe(
          Effect.disconnect,
          Effect.timeoutOption("2 seconds"),
        );

        expect(Option.isSome(stopped), "the server stopped while its client stayed connected").toBe(
          true,
        );
      }),
  );
});
