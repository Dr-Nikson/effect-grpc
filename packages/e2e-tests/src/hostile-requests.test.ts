// packages/e2e-tests/src/hostile-requests.test.ts
import {
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schedule,
  Scope,
} from "effect";
import http2 from "node:http2";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { HandlerContext, ServiceImpl, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  Http2SessionManager,
  compressionGzip,
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from "@connectrpc/connect-node";
import { createWritableIterable } from "@connectrpc/connect/protocol";
import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as namingProto from "./generated/com/example/v1/naming_test_service_effect.js";
import * as raw from "./raw-unary.js";
import fixtures from "./fixtures/hostile-requests.json" with { type: "json" };
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import { NamingTestService } from "./generated/com/example/v1/naming_test_service_pb.js";
import { StreamingTestService } from "./generated/com/example/v1/streaming_test_service_pb.js";

type Repeated = { readonly repeat: string; readonly times: number };

const expand = ({ repeat, times }: Repeated): string => repeat.repeat(times);

const canListenOn = (host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host, port: 0 }, () => probe.close(() => resolve(true)));
  });

const ipv6LoopbackBinds = await canListenOn(fixtures.ipv6Loopback);
if (!ipv6LoopbackBinds) {
  console.warn(`The IPv6 cases did not run: this host cannot listen on ${fixtures.ipv6Loopback}.`);
}

const authorityEcho: effectProto.HelloWorldAPIService<HandlerContext> = {
  getGreeting: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
  faceTheError: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
};

const serve = (
  host: string,
  options?: EffectGrpcServer.GrpcServerOptions,
  service: effectProto.HelloWorldAPIService<HandlerContext> = authorityEcho,
) =>
  Effect.gen(function* () {
    const service = yield* effectProto.HelloWorldAPIServiceTag;
    const server = EffectGrpcServer.GrpcServerBuilder()
      .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
      .withService(service)
      .build(options);
    const { port } = yield* server.listen({ host, port: 0 });
    return port;
  }).pipe(
    Effect.provide(
      effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, service),
    ),
  );

const clientAt = (baseUrl: string) =>
  effectProto
    .helloWorldAPIClientLiveLayer(effectProto.HelloWorldAPIClientTag)
    .pipe(
      Layer.provide(
        Layer.succeed(
          effectProto.HelloWorldAPIConfigTag,
          EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL(baseUrl) }),
        ),
      ),
      Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
    );

const call = (
  session: http2.ClientHttp2Session,
  protocol: raw.Protocol,
  authority: string,
  name = "hostile",
  contentType?: string,
  authorityHeader?: ":authority" | "host",
) =>
  raw
    .getGreeting(session, protocol, authority, name, contentType, authorityHeader)
    .pipe(Effect.timeout("5 seconds"));

const expectServing = (session: http2.ClientHttp2Session, port: number) =>
  Effect.gen(function* () {
    for (const protocol of raw.protocols) {
      const reply = yield* call(session, protocol, `127.0.0.1:${port}`);
      expect(reply.greeting, `a normal call over ${protocol} afterwards`).toBe(`127.0.0.1:${port}`);
    }
  });

const connectMethodStatus = (session: http2.ClientHttp2Session, authority: string) =>
  Effect.callback<number>((resume) => {
    const request = session.request({ ":method": "CONNECT", ":authority": authority });
    request.on("error", () => {});
    request.once("response", (headers) => {
      request.close();
      resume(Effect.succeed(Number(headers[":status"])));
    });
    return Effect.sync(() => request.close(http2.constants.NGHTTP2_CANCEL));
  }).pipe(Effect.timeout("2 seconds"));

const sessionTo = (baseUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Http2SessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

const stallingProxy = (target: number) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly port: number;
      readonly reading: (on: boolean) => void;
      readonly close: () => void;
    }>((resume) => {
      const upstreams = new Set<net.Socket>();
      const proxy = net.createServer((client) => {
        const upstream = net.connect(target, "127.0.0.1");
        upstreams.add(upstream);
        client.on("data", (chunk) => upstream.write(chunk));
        upstream.on("data", (chunk) => client.write(chunk));
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("error", () => {});
        upstream.on("error", () => {});
      });
      proxy.listen(0, "127.0.0.1", () =>
        resume(
          Effect.succeed({
            port: (proxy.address() as net.AddressInfo).port,
            reading: (on) =>
              upstreams.forEach((upstream) => (on ? upstream.resume() : upstream.pause())),
            close: () => proxy.close(),
          }),
        ),
      );
    }),
    ({ close }) => Effect.sync(close),
  );

const expectInvalidAuthority = (
  session: http2.ClientHttp2Session,
  authority: string,
  name: string,
  authorityHeader: ":authority" | "host" = ":authority",
) =>
  Effect.gen(function* () {
    for (const contentType of fixtures.grpcContentTypes) {
      const grpc = yield* call(session, "grpc", authority, "hostile", contentType, authorityHeader);
      expect(
        {
          httpStatus: grpc.httpStatus,
          contentType: grpc.contentType,
          headersEndedStream: grpc.headersEndedStream,
          grpcStatus: grpc.grpcStatus,
        },
        `${name} over gRPC as ${contentType}`,
      ).toEqual({
        httpStatus: 200,
        contentType,
        headersEndedStream: true,
        grpcStatus: String(Code.InvalidArgument),
      });
    }

    const connect = yield* call(
      session,
      "connect",
      authority,
      "hostile",
      undefined,
      authorityHeader,
    );
    expect(
      { httpStatus: connect.httpStatus, connectCode: connect.connectCode },
      `${name} over Connect`,
    ).toEqual({ httpStatus: 400, connectCode: "invalid_argument" });
  });

const streamingTestService: ServiceImpl<typeof StreamingTestService> = {
  unary: (request) => ({ data: `unary ${request.data.length}` }),
  serverStream: async function* (request) {
    yield { data: `server ${request.data.length}` };
    yield { data: `server ${request.data.length}` };
  },
  clientStream: async (requests) => {
    let count = 0;
    let length = 0;
    for await (const request of requests) {
      count += 1;
      length += request.data.length;
    }
    return { data: `client ${count} ${length}` };
  },
  bidi: async function* (requests) {
    for await (const request of requests) yield { data: `bidi ${request.data.length}` };
  },
};

const serveStreaming = (implementation: ServiceImpl<typeof StreamingTestService>) =>
  Effect.gen(function* () {
    const service = EffectGrpcServer.GrpcService(
      "StreamingTestService",
      StreamingTestService,
    )(() => implementation);
    const server = EffectGrpcServer.GrpcServerBuilder().withService(service).build();
    const { port } = yield* server.listen({ host: "127.0.0.1", port: 0 });
    return port;
  });

type Chunk = { readonly data: string };

const overEachProtocol = <A>(baseUrl: string, run: (transport: Transport) => Effect.Effect<A>) =>
  Effect.gen(function* () {
    return {
      grpc: yield* run(createGrpcTransport({ baseUrl, sessionManager: yield* sessionTo(baseUrl) })),
      grpcWeb: yield* run(
        createGrpcWebTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
      ),
      connect: yield* run(
        createConnectTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
      ),
    };
  });

async function* paced(chunk: Chunk, messages: number, pauseMs: number): AsyncIterable<Chunk> {
  yield chunk;
  for (let sent = 1; sent < messages; sent += 1) {
    await sleep(pauseMs);
    yield chunk;
  }
}

describe("Hostile requests (issue #61)", () => {
  it.live("reads each served authority as the host the fixture names", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const { case: name, authority, urlHost } of fixtures.servedAuthorities) {
        for (const protocol of raw.protocols) {
          const reply = yield* call(session, protocol, authority);
          expect(reply.greeting, `${name} over ${protocol}`).toBe(urlHost);
        }
      }
      yield* expectServing(session, port);
    }),
  );

  it.live.skipIf(!ipv6LoopbackBinds)(
    "serves the generated client at an IPv6 literal address (needs an IPv6 loopback address)",
    () =>
      Effect.gen(function* () {
        const port = yield* serve(fixtures.ipv6Loopback);
        const literal = `[${fixtures.ipv6Loopback}]:${port}`;

        const greetings = yield* Effect.gen(function* () {
          const client = yield* effectProto.HelloWorldAPIClientTag;
          const first = yield* client.getGreeting({ name: "Ada" }, {});
          const second = yield* client.getGreeting({ name: "Ada" }, {});
          return [first.greeting, second.greeting];
        }).pipe(
          Effect.provide(clientAt(`http://${literal}`)),
          Effect.scoped,
          Effect.timeout("5 seconds"),
        );

        expect(greetings).toEqual([literal, literal]);
      }),
  );

  it.live("answers each rejected authority with INVALID_ARGUMENT and keeps serving", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const { case: name, authority } of fixtures.rejectedAuthorities) {
        yield* expectInvalidAuthority(session, authority, name);
        yield* expectServing(session, port);
      }
    }),
  );

  it.live("reads the authority from host when :authority is absent", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const { case: name, authority, urlHost } of fixtures.servedAuthorities) {
        for (const protocol of raw.protocols) {
          const reply = yield* call(session, protocol, authority, "hostile", undefined, "host");
          expect(reply.greeting, `${name} in host over ${protocol}`).toBe(urlHost);
        }
      }
      for (const { case: name, authority } of fixtures.rejectedAuthorities) {
        yield* expectInvalidAuthority(session, authority, `${name} in host`, "host");
        yield* expectServing(session, port);
      }
    }),
  );

  it.live("keeps serving after a 10 KiB authority", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const { case: name, authority, served } of fixtures.longAuthorities) {
        const value = expand(authority);
        if (served) {
          for (const protocol of raw.protocols) {
            const reply = yield* call(session, protocol, value);
            expect(reply.greeting, `${name} over ${protocol}`).toBe(value);
          }
        } else {
          yield* expectInvalidAuthority(session, value, name);
        }
        yield* expectServing(session, port);
      }
    }),
  );

  it.live("serves every service the server is built with", () =>
    Effect.gen(function* () {
      const server = EffectGrpcServer.GrpcServerBuilder()
        .withService(yield* effectProto.HelloWorldAPIServiceTag)
        .withService(yield* namingProto.NamingTestServiceTag)
        .build();
      const { port } = yield* server.listen({ host: "127.0.0.1", port: 0 });
      const baseUrl = `http://127.0.0.1:${port}`;
      const transport = createGrpcTransport({ baseUrl, sessionManager: yield* sessionTo(baseUrl) });

      const answers = yield* Effect.promise(async () => ({
        helloWorld: (await createClient(HelloWorldAPI, transport).getGreeting({ name: "Ada" }))
          .greeting,
        namingTest: (await createClient(NamingTestService, transport).echo({ message: "Ada" }))
          .message,
      }));
      expect(answers, "one call to each service on one connection").toEqual({
        helloWorld: "Hello, Ada",
        namingTest: "echo Ada",
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, {
            getGreeting: (request) => Effect.succeed({ greeting: `Hello, ${request.name}` }),
            faceTheError: (request) => Effect.succeed({ greeting: request.name }),
          }),
          namingProto.namingTestServiceLiveLayer(namingProto.NamingTestServiceTag, {
            echo: (request) => Effect.succeed({ message: `echo ${request.message}` }),
          }),
        ),
      ),
    ),
  );

  it.live("an empty authority is reset by HTTP/2 before the server sees it", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const protocol of raw.protocols) {
        const reply = yield* call(session, protocol, fixtures.emptyAuthority);
        expect(reply.rstCode, `empty authority over ${protocol}`).toBe(
          http2.constants.NGHTTP2_PROTOCOL_ERROR,
        );
        yield* expectServing(session, port);
      }
    }),
  );

  it.live("answers an HTTP/2 CONNECT request with 405 and keeps serving", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      expect(yield* connectMethodStatus(session, `127.0.0.1:${port}`)).toBe(405);
      yield* expectServing(session, port);
    }),
  );

  it.live("limits each request message to 4 MiB and keeps serving", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const baseUrl = `http://127.0.0.1:${port}`;
      const { limitBytes, nameAtLimit, nameJustOverLimit, nameOverLimit } = fixtures.messageLimit;
      expect(limitBytes).toBe(4 * 1024 * 1024);

      const generated = yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const atLimit = yield* client.getGreeting({ name: expand(nameAtLimit) }, {});
        const justOverLimit = yield* Effect.flip(
          client.getGreeting({ name: expand(nameJustOverLimit) }, {}),
        );
        const next = yield* client.getGreeting({ name: "next" }, {});
        return {
          atLimit: atLimit.greeting,
          justOverLimit: justOverLimit.code,
          next: next.greeting,
        };
      }).pipe(Effect.provide(clientAt(baseUrl)), Effect.scoped, Effect.timeout("10 seconds"));
      expect(generated, "the generated client over gRPC, at and 1 byte over the limit").toEqual({
        atLimit: `127.0.0.1:${port}`,
        justOverLimit: Code.ResourceExhausted,
        next: `127.0.0.1:${port}`,
      });

      const session = yield* raw.connect(baseUrl);
      const connect = yield* call(session, "connect", `127.0.0.1:${port}`, expand(nameOverLimit));
      expect(
        { httpStatus: connect.httpStatus, connectCode: connect.connectCode },
        "an oversized message over Connect",
      ).toEqual({ httpStatus: 429, connectCode: "resource_exhausted" });
      yield* expectServing(session, port);

      const gzip = createClient(
        HelloWorldAPI,
        createGrpcTransport({ baseUrl, sendCompression: compressionGzip, compressMinBytes: 1 }),
      );
      const compressed = yield* Effect.tryPromise({
        try: () => gzip.getGreeting({ name: expand(nameOverLimit) }),
        catch: (error) => ConnectError.from(error),
      }).pipe(Effect.flip, Effect.timeout("10 seconds"));
      expect(
        compressed.code,
        "a gzip-compressed oversized message, limited after decompression",
      ).toBe(Code.ResourceExhausted);
      yield* expectServing(session, port);
    }),
  );

  it.live("limits each request message to the readMaxBytes the server is built with", () =>
    Effect.gen(function* () {
      const { readMaxBytes, nameAtLimit, nameJustOverLimit } = fixtures.configuredMessageLimit;
      const port = yield* serve("127.0.0.1", { readMaxBytes });
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      const atLimit = yield* call(session, "grpc", `127.0.0.1:${port}`, expand(nameAtLimit));
      const justOverLimit = yield* call(
        session,
        "grpc",
        `127.0.0.1:${port}`,
        expand(nameJustOverLimit),
      );
      expect(
        { atLimit: atLimit.greeting, justOverLimit: justOverLimit.grpcStatus },
        `a server built with readMaxBytes ${readMaxBytes}, at and 1 byte over that limit`,
      ).toEqual({ atLimit: `127.0.0.1:${port}`, justOverLimit: String(Code.ResourceExhausted) });
      yield* expectServing(session, port);
    }),
  );

  it.live("refuses at build a readMaxBytes outside 1 to 4294967295", () =>
    Effect.gen(function* () {
      const { invalid, smallest, largest } = fixtures.readMaxBytesRange;
      const builder = EffectGrpcServer.GrpcServerBuilder().withService(
        yield* effectProto.HelloWorldAPIServiceTag,
      );
      const built = yield* Effect.forEach(invalid, (value) =>
        Effect.exit(Effect.sync(() => builder.build({ readMaxBytes: Number(value) }))).pipe(
          Effect.map(
            Exit.match({
              onFailure: (cause) =>
                Cause.isIllegalArgumentError(Cause.squash(cause)) ? "IllegalArgumentError" : (
                  String(Cause.squash(cause))
                ),
              onSuccess: () => "built",
            }),
          ),
        ),
      );
      expect(built, `build with readMaxBytes ${invalid.join(", ")}`).toEqual(
        invalid.map(() => "IllegalArgumentError"),
      );

      const servedBy = (readMaxBytes: number, names: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.gen(function* () {
            const port = yield* serve("127.0.0.1", { readMaxBytes });
            const session = yield* raw.connect(`http://127.0.0.1:${port}`);
            return yield* Effect.forEach(names, (name) =>
              call(session, "grpc", `127.0.0.1:${port}`, name).pipe(
                Effect.map((reply) =>
                  reply.greeting === `127.0.0.1:${port}` ? "served" : reply.grpcStatus,
                ),
              ),
            );
          }),
        );
      expect(
        yield* servedBy(smallest, ["", "a"]),
        `an empty and a 3-byte message to a server built with readMaxBytes ${smallest}`,
      ).toEqual(["served", String(Code.ResourceExhausted)]);
      expect(
        yield* servedBy(largest, [expand(fixtures.messageLimit.nameOverLimit)]),
        `a 5 MiB message to a server built with readMaxBytes ${largest}`,
      ).toEqual(["served"]);
    }).pipe(
      Effect.provide(
        effectProto.helloWorldAPIServiceLiveLayer(
          effectProto.HelloWorldAPIServiceTag,
          authorityEcho,
        ),
      ),
    ),
  );

  it.live("stops while clients that had a message refused keep their connections", () =>
    Effect.gen(function* () {
      const { stopDeadlineMs } = fixtures.refusedClientsConnected;
      const name = expand(fixtures.messageLimit.nameOverLimit);
      const serverScope = yield* Scope.fork(yield* Effect.scope, "sequential");
      const port = yield* serve("127.0.0.1").pipe(Scope.provide(serverScope));
      const baseUrl = `http://127.0.0.1:${port}`;

      const generated = Context.get(
        yield* Layer.build(clientAt(baseUrl)),
        effectProto.HelloWorldAPIClientTag,
      );
      const refusals = {
        generated: yield* generated
          .getGreeting({ name }, {})
          .pipe(Effect.match({ onFailure: ({ code }) => Code[code], onSuccess: () => "served" })),
        ...(yield* overEachProtocol(baseUrl, (transport) =>
          Effect.promise(() =>
            createClient(HelloWorldAPI, transport)
              .getGreeting({ name })
              .then(
                () => "served",
                (error) => Code[ConnectError.from(error).code],
              ),
          ),
        )),
      };
      // The server stops in an uninterruptible finalizer, so the deadline must not wait for it.
      const stopping = yield* Effect.forkDetach(Scope.close(serverScope, Exit.void));
      const stopped = yield* Fiber.join(stopping).pipe(
        Effect.timeoutOption(Duration.millis(stopDeadlineMs)),
      );

      expect(refusals, "each client's 5 MiB message").toEqual({
        generated: "ResourceExhausted",
        grpc: "ResourceExhausted",
        grpcWeb: "ResourceExhausted",
        connect: "ResourceExhausted",
      });
      expect(
        Option.isSome(stopped),
        `the server stopped within ${stopDeadlineMs} ms while every client kept its connection`,
      ).toBe(true);
    }),
  );

  it.live("closes a refused request that its client keeps sending", () =>
    Effect.gen(function* () {
      const { closeDeadlineMs } = fixtures.unfinishedUpload;
      const name = expand(fixtures.messageLimit.nameOverLimit);
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);
      const untilClosed = (protocol: raw.Protocol) =>
        raw.getGreetingUntilClosed(session, protocol, `127.0.0.1:${port}`, name).pipe(
          Effect.timeoutOption(Duration.millis(closeDeadlineMs)),
          Effect.map(
            Option.match({
              onNone: () => "the stream stayed open",
              onSome: ({ httpStatus, grpcStatus, connectCode, rstCode }) => ({
                httpStatus,
                grpcStatus,
                connectCode,
                rstCode,
              }),
            }),
          ),
        );

      expect(
        { grpc: yield* untilClosed("grpc"), connect: yield* untilClosed("connect") },
        `each refused stream within ${closeDeadlineMs} ms`,
      ).toEqual({
        grpc: {
          httpStatus: 200,
          grpcStatus: String(Code.ResourceExhausted),
          connectCode: undefined,
          rstCode: http2.constants.NGHTTP2_NO_ERROR,
        },
        connect: {
          httpStatus: 429,
          grpcStatus: undefined,
          connectCode: "resource_exhausted",
          rstCode: http2.constants.NGHTTP2_NO_ERROR,
        },
      });
      yield* expectServing(session, port);
    }),
  );

  it.live("delivers a refusal that waits behind a stalled connection", () =>
    Effect.gen(function* () {
      const { downloadName, downloadBytes, fillMs, stallMs, closeDeadlineMs } =
        fixtures.stalledConnection;
      const port = yield* serve("127.0.0.1", undefined, {
        ...authorityEcho,
        getGreeting: (request, ctx) =>
          Effect.succeed({
            greeting:
              request.name === downloadName ? "x".repeat(downloadBytes) : new URL(ctx.url).host,
          }),
      });
      const proxy = yield* stallingProxy(port);
      const session = yield* raw.connectWithLargestWindows(`http://127.0.0.1:${proxy.port}`);
      const authority = `127.0.0.1:${port}`;

      proxy.reading(false);
      yield* Effect.forkChild(raw.getGreeting(session, "grpc", authority, downloadName));
      yield* Effect.sleep(Duration.millis(fillMs));
      const refused = yield* Effect.forkChild(
        raw.getGreetingUntilClosed(
          session,
          "grpc",
          authority,
          expand(fixtures.messageLimit.nameOverLimit),
        ),
      );
      yield* Effect.sleep(Duration.millis(stallMs));
      const whileStalled = yield* Effect.sync(() => Option.fromNullishOr(refused.pollUnsafe()));
      proxy.reading(true);
      const reply = yield* Fiber.join(refused).pipe(
        Effect.timeoutOption(Duration.millis(closeDeadlineMs)),
      );

      expect(
        Option.isNone(whileStalled),
        "the refused call was still waiting while the connection was stalled",
      ).toBe(true);
      expect(
        Option.map(reply, ({ grpcStatus, rstCode }) => ({ grpcStatus, rstCode })),
        "the refused call once the connection reads again",
      ).toEqual(
        Option.some({
          grpcStatus: String(Code.ResourceExhausted),
          rstCode: http2.constants.NGHTTP2_NO_ERROR,
        }),
      );
    }),
  );

  it.live("sends a client-streaming answer that is ready before the request ends", () =>
    Effect.gen(function* () {
      const port = yield* serveStreaming({
        ...streamingTestService,
        clientStream: async (requests) => {
          for await (const request of requests) return { data: `first ${request.data.length}` };
          return { data: "no message" };
        },
      });
      const { message, messages, pauseMs, deadlineMs, answer } = fixtures.earlyAnswer;
      const answers = yield* overEachProtocol(`http://127.0.0.1:${port}`, (transport) =>
        Effect.promise(async () => {
          const client = createClient(StreamingTestService, transport);
          try {
            const requests = paced({ data: message }, messages, pauseMs);
            return (await client.clientStream(requests, { timeoutMs: deadlineMs })).data;
          } catch (error) {
            return Code[ConnectError.from(error).code];
          }
        }),
      );
      expect(answers, "each protocol's answer within the client's deadline").toEqual({
        grpc: answer,
        grpcWeb: answer,
        connect: answer,
      });
    }),
  );

  it.live("stops a bidi handler when its client cancels the call", () =>
    Effect.gen(function* () {
      const { replyEveryMs, replies: expectedReplies } = fixtures.cancelledBidi;
      const running = { handlers: 0 };
      const port = yield* serveStreaming({
        ...streamingTestService,
        bidi: async function* () {
          running.handlers += 1;
          try {
            for (let reply = 0; ; reply += 1) {
              yield { data: `reply ${reply}` };
              await sleep(replyEveryMs);
            }
          } finally {
            running.handlers -= 1;
          }
        },
      });
      const replies = yield* overEachProtocol(`http://127.0.0.1:${port}`, (transport) =>
        Effect.promise(async () => {
          const client = createClient(StreamingTestService, transport);
          const controller = new AbortController();
          const requests = createWritableIterable<Chunk>();
          const responses = client
            .bidi(requests, { signal: controller.signal })
            [Symbol.asyncIterator]();
          const read: Array<string> = [];
          while (read.length < expectedReplies.length) {
            const response = await responses.next();
            if (response.done === true) break;
            read.push(response.value.data);
          }
          controller.abort();
          await responses.next().catch(() => undefined);
          return read;
        }),
      );
      yield* Effect.sync(() => running.handlers).pipe(
        Effect.repeat({ until: (left) => left === 0, schedule: Schedule.spaced("20 millis") }),
        Effect.timeout("5 seconds"),
        Effect.ignore,
      );

      expect(replies, "the replies each protocol's client read before it cancelled").toEqual({
        grpc: expectedReplies,
        grpcWeb: expectedReplies,
        connect: expectedReplies,
      });
      expect(
        running.handlers,
        "bidi handlers still running 5 seconds after their clients cancelled",
      ).toBe(0);
    }),
  );
});
