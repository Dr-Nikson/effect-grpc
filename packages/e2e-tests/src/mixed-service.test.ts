// packages/e2e-tests/src/mixed-service.test.ts
import { Cause, Effect, Layer } from "effect";

import type { Transport } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import {
  Http2SessionManager,
  createConnectTransport,
  createGrpcTransport,
  createGrpcWebTransport,
} from "@connectrpc/connect-node";
import { EffectGrpcClient, EffectGrpcServer } from "@dr_nikson/effect-grpc";
import { describe, expect, it } from "@effect/vitest";

import * as effectProto from "./generated/com/example/v1/streaming_test_service_effect.js";
import { StreamingTestService } from "./generated/com/example/v1/streaming_test_service_pb.js";

type Chunk = { readonly data: string };

const service: effectProto.StreamingTestService = {
  unary: (request) => Effect.succeed({ data: `unary ${request.data}` }),
};

const serve = Effect.gen(function* () {
  const grpcService = yield* effectProto.StreamingTestServiceTag;
  const server = EffectGrpcServer.GrpcServerBuilder().withService(grpcService).build();
  return yield* server.listen({ host: "127.0.0.1", port: 0 });
}).pipe(
  Effect.provide(
    effectProto.streamingTestServiceLiveLayer(effectProto.StreamingTestServiceTag, service),
  ),
);

const generatedClientAt = (address: EffectGrpcServer.GrpcServerAddress) =>
  effectProto
    .streamingTestServiceClientLiveLayer(effectProto.StreamingTestServiceClientTag)
    .pipe(
      Layer.provide(
        Layer.succeed(
          effectProto.StreamingTestServiceConfigTag,
          EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL(address.url) }),
        ),
      ),
      Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
    );

/**
 * The server's scope closes only after every client session closes, so each session is aborted in
 * a finalizer that runs before the server's.
 */
const sessionTo = (baseUrl: string) =>
  Effect.acquireRelease(
    Effect.sync(() => new Http2SessionManager(baseUrl)),
    (sessionManager) => Effect.sync(() => sessionManager.abort()),
  );

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

async function* streamOf(chunk: Chunk): AsyncIterable<Chunk> {
  yield chunk;
}

const repliesOf = async (responses: AsyncIterable<Chunk>): Promise<ReadonlyArray<string>> => {
  const replies: Array<string> = [];
  for await (const response of responses) replies.push(response.data);
  return replies;
};

const answerOf = (call: (signal: AbortSignal) => Promise<ReadonlyArray<string>>) =>
  Effect.tryPromise({ try: call, catch: (error) => ConnectError.from(error) }).pipe(
    Effect.timeout("5 seconds"),
    Effect.match({
      onSuccess: (replies) => ({ replies }),
      onFailure: (error) =>
        Cause.isTimeoutError(error) ?
          "no answer within 5 seconds"
        : { code: error.code, message: error.rawMessage },
    }),
  );

const answersOver = (transport: Transport) =>
  Effect.gen(function* () {
    const client = createClient(StreamingTestService, transport);
    const request: Chunk = { data: "hello" };
    return {
      serverStream: yield* answerOf((signal) =>
        repliesOf(client.serverStream(request, { signal })),
      ),
      clientStream: yield* answerOf(async (signal) => [
        (await client.clientStream(streamOf(request), { signal })).data,
      ]),
      bidi: yield* answerOf((signal) => repliesOf(client.bidi(streamOf(request), { signal }))),
      unary: yield* answerOf(async (signal) => [(await client.unary(request, { signal })).data]),
    };
  });

describe("A service with unary and streaming rpcs, served through the generated code (#100)", () => {
  it.live(
    "answers each streaming rpc with UNIMPLEMENTED and serves the unary rpc, over gRPC, gRPC-web and Connect",
    () =>
      Effect.gen(function* () {
        const { url } = yield* serve;
        const answers = yield* overEachProtocol(url, answersOver);

        const expected = {
          serverStream: {
            code: Code.Unimplemented,
            message: expect.stringContaining("ServerStream"),
          },
          clientStream: {
            code: Code.Unimplemented,
            message: expect.stringContaining("ClientStream"),
          },
          bidi: { code: Code.Unimplemented, message: expect.stringContaining("Bidi") },
          unary: { replies: ["unary hello"] },
        };
        expect(
          answers,
          "each call's answer, the streaming rpcs first, one client connection per protocol",
        ).toEqual({ grpc: expected, grpcWeb: expected, connect: expected });
      }),
  );

  it.live("serves the unary rpc to the generated Effect client", () =>
    Effect.gen(function* () {
      const address = yield* serve;
      const reply = yield* Effect.gen(function* () {
        const client = yield* effectProto.StreamingTestServiceClientTag;
        return yield* client.unary({ data: "hello" }, {});
      }).pipe(Effect.provide(generatedClientAt(address)), Effect.timeout("5 seconds"));

      expect(reply.data, "the reply the unary handler built").toBe("unary hello");
    }),
  );
});
