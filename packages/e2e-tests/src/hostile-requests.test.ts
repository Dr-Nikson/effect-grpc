// packages/e2e-tests/src/hostile-requests.test.ts
import {
  Cause,
  Context,
  Duration,
  Effect,
  ExecutionStrategy,
  Exit,
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
import * as raw from "./raw-unary.js";
import fixtures from "./fixtures/hostile-requests.json" with { type: "json" };
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import { StreamingTestService } from "./generated/com/example/v1/streaming_test_service_pb.js";
import { Port, PortLive } from "./test-fixtures.js";

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

const serve = (host: string, options?: EffectGrpcServer.GrpcServerOptions) =>
  Effect.gen(function* () {
    const port = yield* Port;
    const service = yield* effectProto.HelloWorldAPIServiceTag;
    const server = EffectGrpcServer.GrpcServerBuilder()
      .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
      .withService(service)
      .build(options);
    yield* Effect.forkScoped(server.run({ host, port }));
    yield* Effect.sleep("1 second");
    return port;
  }).pipe(
    Effect.provide(
      effectProto.helloWorldAPIServiceLiveLayer(effectProto.HelloWorldAPIServiceTag, authorityEcho),
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

const sessionTo = (baseUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Http2SessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
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
    const port = yield* Port;
    const service = EffectGrpcServer.GrpcService(
      "StreamingTestService",
      StreamingTestService,
    )(() => implementation);
    const server = EffectGrpcServer.GrpcServerBuilder().withService(service).build();
    yield* Effect.forkScoped(server.run({ host: "127.0.0.1", port }));
    yield* Effect.sleep("1 second");
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
  it.scopedLive("reads each served authority as the host the fixture names", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive.skipIf(!ipv6LoopbackBinds)(
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
      }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("answers each rejected authority with INVALID_ARGUMENT and keeps serving", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const session = yield* raw.connect(`http://127.0.0.1:${port}`);

      for (const { case: name, authority } of fixtures.rejectedAuthorities) {
        yield* expectInvalidAuthority(session, authority, name);
        yield* expectServing(session, port);
      }
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("reads the authority from host when :authority is absent", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("keeps serving after a 10 KiB authority", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("an empty authority is reset by HTTP/2 before the server sees it", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("limits each request message to 4 MiB and keeps serving", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const baseUrl = `http://127.0.0.1:${port}`;
      const { limitBytes, nameAtLimit, nameJustOverLimit, nameOverLimit } = fixtures.messageLimit;
      expect(limitBytes).toBe(4 * 1024 * 1024);

      const generated = yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const atLimit = yield* client.getGreeting({ name: expand(nameAtLimit) }, {});
        const justOverLimit = yield* Effect.exit(
          client.getGreeting({ name: expand(nameJustOverLimit) }, {}),
        );
        const next = yield* client.getGreeting({ name: "next" }, {});
        return {
          atLimit: atLimit.greeting,
          justOverLimit:
            Exit.isFailure(justOverLimit) ?
              ConnectError.from(Cause.squash(justOverLimit.cause)).code
            : undefined,
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("limits each request message to the readMaxBytes the server is built with", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("stops while clients that had a message refused keep their connections", () =>
    Effect.gen(function* () {
      const { stopDeadlineMs } = fixtures.refusedClientsConnected;
      const name = expand(fixtures.messageLimit.nameOverLimit);
      const serverScope = yield* Scope.fork(yield* Effect.scope, ExecutionStrategy.sequential);
      const port = yield* serve("127.0.0.1").pipe(Scope.extend(serverScope));
      const baseUrl = `http://127.0.0.1:${port}`;

      const generated = Context.get(
        yield* Layer.build(clientAt(baseUrl)),
        effectProto.HelloWorldAPIClientTag,
      );
      const refusals = {
        generated: Exit.match(yield* Effect.exit(generated.getGreeting({ name }, {})), {
          onFailure: (cause) => Code[ConnectError.from(Cause.squash(cause)).code],
          onSuccess: () => "served",
        }),
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
      const stopped = yield* Scope.close(serverScope, Exit.void).pipe(
        Effect.disconnect,
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("closes a refused request that its client keeps sending", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("sends a client-streaming answer that is ready before the request ends", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );

  it.scopedLive("stops a bidi handler when its client cancels the call", () =>
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
    }).pipe(Effect.provide(PortLive)),
  );
});
