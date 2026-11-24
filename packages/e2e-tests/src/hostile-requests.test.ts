// packages/e2e-tests/src/hostile-requests.test.ts
import { Cause, Effect, Exit, Layer, Option, Schedule } from "effect";
import http2 from "node:http2";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import type { Client, HandlerContext, ServiceImpl, Transport } from "@connectrpc/connect";
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

const serve = (host: string) =>
  Effect.gen(function* () {
    const service = yield* effectProto.HelloWorldAPIServiceTag;
    const server = EffectGrpcServer.GrpcServerBuilder()
      .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
      .withService(service)
      .build();
    const { port } = yield* server.listen({ host, port: 0 });
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

const answerOf = (call: Effect.Effect<{ readonly greeting: string }, unknown>) =>
  call.pipe(
    Effect.timeout("10 seconds"),
    Effect.exit,
    Effect.map(
      Exit.match({
        onSuccess: ({ greeting }) => greeting,
        onFailure: (cause) => {
          const error = Cause.squash(cause);
          return Cause.isTimeoutError(error) ?
              "no answer within 10 seconds"
            : ConnectError.from(error).code;
        },
      }),
    ),
  );

const sessionTo = (baseUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Http2SessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

const getGreetingWith = (client: Client<typeof HelloWorldAPI>) => (name: string) =>
  Effect.tryPromise({
    try: (signal) => client.getGreeting({ name }, { signal }),
    catch: (error) => error,
  });

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

class RecordingSessionManager extends Http2SessionManager {
  readonly sessions = new Set<http2.ClientHttp2Stream["session"]>();

  override async request(
    ...args: Parameters<Http2SessionManager["request"]>
  ): Promise<http2.ClientHttp2Stream> {
    const stream = await super.request(...args);
    this.sessions.add(stream.session);
    return stream;
  }
}

const recordingSessionTo = (baseUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new RecordingSessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

type Chunk = { readonly data: string };
type StreamingCall = (typeof fixtures.streamingClient.calls)[number];

async function* streamOf(chunks: ReadonlyArray<Chunk>): AsyncIterable<Chunk> {
  yield* chunks;
}

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

const pingPong = async (
  client: Client<typeof StreamingTestService>,
  chunks: ReadonlyArray<Chunk>,
  signal: AbortSignal,
  replies: Array<string>,
) => {
  const requests = createWritableIterable<Chunk>();
  const responses = client.bidi(requests, { signal })[Symbol.asyncIterator]();
  try {
    for (const chunk of chunks) {
      await requests.write(chunk);
      const response = await responses.next();
      if (response.done === true) return;
      replies.push(response.value.data);
    }
  } finally {
    requests.close();
  }
  let response = await responses.next();
  while (response.done !== true) {
    replies.push(response.value.data);
    response = await responses.next();
  }
};

const streamingAnswerOf = (
  client: Client<typeof StreamingTestService>,
  { method, messages }: StreamingCall,
) =>
  Effect.promise(async (signal) => {
    const { oversized, normal } = fixtures.streamingClient;
    const chunks = messages.map((message) => ({
      data: message === "oversized" ? expand(oversized) : normal,
    }));
    const first = Option.getOrThrow(Option.fromNullable(chunks[0]));
    const replies: Array<string> = [];
    const collect = async (responses: AsyncIterable<Chunk>) => {
      for await (const response of responses) replies.push(response.data);
    };
    try {
      if (method === "unary") replies.push((await client.unary(first, { signal })).data);
      else if (method === "serverStream") await collect(client.serverStream(first, { signal }));
      else if (method === "clientStream")
        replies.push((await client.clientStream(streamOf(chunks), { signal })).data);
      else if (method === "bidi") await collect(client.bidi(streamOf(chunks), { signal }));
      else await pingPong(client, chunks, signal, replies);
    } catch (error) {
      replies.push(Code[ConnectError.from(error).code]);
    }
    return replies;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.catchTag("TimeoutException", () => Effect.succeed(["no answer within 10 seconds"])),
  );

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

  it.live("limits each request message to 4 MiB and keeps serving", () =>
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
    }),
  );

  it.live("keeps a long-lived client usable after its oversized messages are refused", () =>
    Effect.gen(function* () {
      const port = yield* serve("127.0.0.1");
      const baseUrl = `http://127.0.0.1:${port}`;
      const { nameOversized, calls } = fixtures.longLivedClient;
      const oversized = expand(nameOversized);
      const callAll = (
        getGreeting: (name: string) => Effect.Effect<{ readonly greeting: string }, unknown>,
      ) =>
        Effect.forEach(calls, (call) =>
          answerOf(getGreeting(call === "oversized" ? oversized : "next")),
        );

      const transports = {
        grpc: createGrpcTransport({ baseUrl, sessionManager: yield* sessionTo(baseUrl) }),
        grpcWeb: createGrpcWebTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
        connect: createConnectTransport({
          baseUrl,
          httpVersion: "2",
          sessionManager: yield* sessionTo(baseUrl),
        }),
      };
      const answers = {
        grpc: yield* callAll(getGreetingWith(createClient(HelloWorldAPI, transports.grpc))),
        grpcWeb: yield* callAll(getGreetingWith(createClient(HelloWorldAPI, transports.grpcWeb))),
        connect: yield* callAll(getGreetingWith(createClient(HelloWorldAPI, transports.connect))),
        generatedClient: yield* Effect.gen(function* () {
          const client = yield* effectProto.HelloWorldAPIClientTag;
          return yield* callAll((name) => client.getGreeting({ name }, {}));
        }).pipe(Effect.provide(clientAt(baseUrl)), Effect.scoped),
      };

      const expected = calls.map((call) =>
        call === "oversized" ? Code.ResourceExhausted : `127.0.0.1:${port}`,
      );
      expect(answers, "each call's answer, one client connection per protocol").toEqual({
        grpc: expected,
        grpcWeb: expected,
        connect: expected,
        generatedClient: expected,
      });
    }),
  );

  it.scopedLive(
    "keeps a long-lived client usable after oversized unary and server-streaming messages",
    () =>
      Effect.gen(function* () {
        const port = yield* serveStreaming(streamingTestService);
        const baseUrl = `http://127.0.0.1:${port}`;
        const sessions = {
          grpc: yield* recordingSessionTo(baseUrl),
          grpcWeb: yield* recordingSessionTo(baseUrl),
          connect: yield* recordingSessionTo(baseUrl),
        };
        const answersOver = (transport: Transport) => {
          const client = createClient(StreamingTestService, transport);
          return Effect.forEach(fixtures.streamingClient.calls, (call) =>
            streamingAnswerOf(client, call),
          );
        };
        const answers = {
          grpc: yield* answersOver(createGrpcTransport({ baseUrl, sessionManager: sessions.grpc })),
          grpcWeb: yield* answersOver(
            createGrpcWebTransport({ baseUrl, httpVersion: "2", sessionManager: sessions.grpcWeb }),
          ),
          connect: yield* answersOver(
            createConnectTransport({ baseUrl, httpVersion: "2", sessionManager: sessions.connect }),
          ),
        };

        const expected = fixtures.streamingClient.calls.map(({ answer }) => answer);
        expect(answers, "each call's answer, one client connection per protocol").toEqual({
          grpc: expected,
          grpcWeb: expected,
          connect: expected,
        });
        expect(
          {
            grpc: sessions.grpc.sessions.size,
            grpcWeb: sessions.grpcWeb.sessions.size,
            connect: sessions.connect.sessions.size,
          },
          "HTTP/2 connections each protocol's client used",
        ).toEqual({ grpc: 1, grpcWeb: 1, connect: 1 });
      }),
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
    }),
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
    }),
  );
});
