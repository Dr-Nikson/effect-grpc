// packages/e2e-tests/src/hostile-requests.test.ts
import { Cause, Effect, Exit, Layer } from "effect";
import http2 from "node:http2";

import type { HandlerContext } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { compressionGzip, createGrpcTransport } from "@connectrpc/connect-node";
import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/hello_world_api_effect.js";
import * as raw from "./raw-unary.js";
import fixtures from "./fixtures/hostile-requests.json" with { type: "json" };
import { HelloWorldAPI } from "./generated/com/example/v1/hello_world_api_pb.js";
import { Port, PortLive } from "./test-fixtures.js";

type Repeated = { readonly repeat: string; readonly times: number };

const expand = ({ repeat, times }: Repeated): string => repeat.repeat(times);

const authorityEcho: effectProto.HelloWorldAPIService<HandlerContext> = {
  getGreeting: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
  faceTheError: (_request, ctx) => Effect.succeed({ greeting: new URL(ctx.url).host }),
};

const serve = (host: string) =>
  Effect.gen(function* () {
    const port = yield* Port;
    const service = yield* effectProto.HelloWorldAPIServiceTag;
    const server = EffectGrpcServer.GrpcServerBuilder()
      .withContextTransformer((handlerCtx) => Effect.succeed(handlerCtx))
      .withService(service)
      .build();
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
) =>
  raw
    .getGreeting(session, protocol, authority, name, contentType)
    .pipe(Effect.timeout("5 seconds"));

const expectServing = (session: http2.ClientHttp2Session, port: number) =>
  Effect.gen(function* () {
    for (const protocol of raw.protocols) {
      const reply = yield* call(session, protocol, `127.0.0.1:${port}`);
      expect(reply.greeting, `a normal call over ${protocol} afterwards`).toBe(`127.0.0.1:${port}`);
    }
  });

const expectInvalidAuthority = (
  session: http2.ClientHttp2Session,
  authority: string,
  name: string,
) =>
  Effect.gen(function* () {
    for (const contentType of fixtures.grpcContentTypes) {
      const grpc = yield* call(session, "grpc", authority, "hostile", contentType);
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

    const connect = yield* call(session, "connect", authority);
    expect(
      { httpStatus: connect.httpStatus, connectCode: connect.connectCode },
      `${name} over Connect`,
    ).toEqual({ httpStatus: 400, connectCode: "invalid_argument" });
  });

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

  it.scopedLive("serves the generated client at an IPv6 literal address", () =>
    Effect.gen(function* () {
      const port = yield* serve("::1");

      const greetings = yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const first = yield* client.getGreeting({ name: "Ada" }, {});
        const second = yield* client.getGreeting({ name: "Ada" }, {});
        return [first.greeting, second.greeting];
      }).pipe(
        Effect.provide(clientAt(`http://[::1]:${port}`)),
        Effect.scoped,
        Effect.timeout("5 seconds"),
      );

      expect(greetings).toEqual([`[::1]:${port}`, `[::1]:${port}`]);
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
      const { limitBytes, nameAtLimit, nameOverLimit } = fixtures.messageLimit;
      expect(limitBytes).toBe(4 * 1024 * 1024);

      const generated = yield* Effect.gen(function* () {
        const client = yield* effectProto.HelloWorldAPIClientTag;
        const atLimit = yield* client.getGreeting({ name: expand(nameAtLimit) }, {});
        const overLimit = yield* Effect.exit(
          client.getGreeting({ name: expand(nameOverLimit) }, {}),
        );
        const next = yield* client.getGreeting({ name: "next" }, {});
        return {
          atLimit: atLimit.greeting,
          overLimit:
            Exit.isFailure(overLimit) ?
              ConnectError.from(Cause.squash(overLimit.cause)).code
            : undefined,
          next: next.greeting,
        };
      }).pipe(Effect.provide(clientAt(baseUrl)), Effect.scoped, Effect.timeout("10 seconds"));
      expect(generated, "the generated client over gRPC").toEqual({
        atLimit: `127.0.0.1:${port}`,
        overLimit: Code.ResourceExhausted,
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
});
