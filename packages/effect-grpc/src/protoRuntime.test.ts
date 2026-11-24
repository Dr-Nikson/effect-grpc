// packages/effect-grpc/src/protoRuntime.test.ts
import { Cause, Deferred, Effect, Exit, Ref } from "effect";
import type { Scope } from "effect";
import http2 from "node:http2";
import net from "node:net";
import { describe, expect, it } from "vitest";

import { create, createFileRegistry } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { serviceDesc } from "@bufbuild/protobuf/codegenv2";
import {
  EmptySchema,
  FileDescriptorProtoSchema,
  file_google_protobuf_empty,
} from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";

import * as GrpcException from "./grpcException.js";
import * as Server from "./server.js";

type Handler = () => Effect.Effect<
  MessageInitShape<typeof EmptySchema>,
  GrpcException.GrpcException
>;

type HandlerEnd = "interrupted" | "ended another way" | "still running";

type Sent =
  | {
      readonly kind: "status";
      readonly code: Code | undefined;
      readonly message: string | undefined;
    }
  | {
      readonly kind: "after the cancel";
      readonly frames: ReadonlyArray<string>;
      readonly handler: HandlerEnd;
    };

interface Outcome {
  readonly outcome: string;
  readonly call: "waits for the reply" | "sends a 50 ms deadline" | "cancels once the handler runs";
  readonly handler: Handler;
  readonly contextTransformer?: () => Effect.Effect<unknown, GrpcException.GrpcException>;
  readonly sends: Sent;
}

// The number of pairs follows the handler's structure: 5 for a bare Effect.never, 6 once the
// handler adds an Effect.onExit. The matcher pins the pairs, not their number.
const deadlineMessage = expect.stringMatching(
  /^Unknown error; Request was canceled(; Unknown error; Request was canceled)*$/,
);

const outcomes: ReadonlyArray<Outcome> = [
  {
    outcome: "a typed failure",
    call: "waits for the reply",
    handler: () =>
      Effect.fail(GrpcException.create(Code.FailedPrecondition, "Face the consequences!")),
    sends: { kind: "status", code: Code.FailedPrecondition, message: "Face the consequences!" },
  },
  {
    outcome: "a defect",
    call: "waits for the reply",
    handler: () => Effect.die(new Error("the handler died")),
    sends: { kind: "status", code: Code.Internal, message: "Internal server error" },
  },
  {
    outcome: "a client cancel",
    call: "cancels once the handler runs",
    handler: () => Effect.never,
    sends: { kind: "after the cancel", frames: [], handler: "interrupted" },
  },
  {
    outcome: "a deadline expiry",
    call: "sends a 50 ms deadline",
    handler: () => Effect.never,
    sends: { kind: "status", code: Code.Internal, message: deadlineMessage },
  },
  {
    outcome: "a typed failure with a dying finalizer",
    call: "waits for the reply",
    handler: () =>
      Effect.fail(GrpcException.create(Code.NotFound, "typed failure")).pipe(
        Effect.ensuring(Effect.die(new Error("the finalizer died"))),
      ),
    sends: { kind: "status", code: Code.Internal, message: "typed failure; Internal server error" },
  },
  {
    outcome: "a throw inside a context transformer",
    call: "waits for the reply",
    contextTransformer: () => {
      throw new Error("the context transformer threw");
    },
    handler: () => Effect.succeed({}),
    sends: { kind: "status", code: Code.Internal, message: "Internal server error" },
  },
  {
    outcome: "an interrupt inside the handler",
    call: "waits for the reply",
    handler: () => Effect.interrupt,
    sends: { kind: "status", code: Code.Aborted, message: "Request was canceled" },
  },
  {
    outcome: "two typed failures in parallel",
    call: "waits for the reply",
    handler: () =>
      Effect.failCause(
        Cause.parallel(
          Cause.fail(GrpcException.create(Code.NotFound, "first")),
          Cause.fail(GrpcException.create(Code.AlreadyExists, "second")),
        ),
      ),
    sends: { kind: "status", code: Code.Internal, message: "first | second" },
  },
  {
    outcome: "an empty cause",
    call: "waits for the reply",
    handler: () => Effect.failCause(Cause.empty),
    sends: { kind: "status", code: Code.Unknown, message: "Unknown error" },
  },
];

const registry = createFileRegistry(
  create(FileDescriptorProtoSchema, {
    name: "effect_grpc_test/outcome.proto",
    package: "effect_grpc_test",
    dependency: ["google/protobuf/empty.proto"],
    syntax: "proto3",
    service: [
      {
        name: "OutcomeService",
        method: ["Run", "Ping"].map((name) => ({
          name,
          inputType: ".google.protobuf.Empty",
          outputType: ".google.protobuf.Empty",
        })),
      },
    ],
  }),
  (name) => (name === "google/protobuf/empty.proto" ? file_google_protobuf_empty : undefined),
);
const outcomeFile = registry.getFile("effect_grpc_test/outcome.proto");
if (outcomeFile === undefined) {
  throw new Error("the test descriptor for OutcomeService did not register");
}

type EmptyUnary = { methodKind: "unary"; input: typeof EmptySchema; output: typeof EmptySchema };
const OutcomeService = serviceDesc<{ run: EmptyUnary; ping: EmptyUnary }>(outcomeFile, 0);

const serve = (row: Outcome, handler: Handler) => {
  const service = Server.GrpcService(
    "effect_grpc_test.OutcomeService",
    OutcomeService,
  )((executor) => ({
    run: (request, context) =>
      executor.unary("effect_grpc_test.OutcomeService/Run", request, context, handler),
    ping: (request, context) =>
      executor.unary("effect_grpc_test.OutcomeService/Ping", request, context, () =>
        Effect.succeed({}),
      ),
  }));
  const builder =
    row.contextTransformer === undefined ?
      Server.GrpcServerBuilder()
    : Server.GrpcServerBuilder().withContextTransformer(row.contextTransformer);
  return builder.withService(service).build().listen({ host: "127.0.0.1", port: 0 });
};

const connect = (url: string) =>
  Effect.acquireRelease(
    Effect.sync(() => http2.connect(url).on("error", () => {})),
    (session) => Effect.sync(() => session.destroy()),
  );

const open = (
  session: http2.ClientHttp2Session,
  method: "Run" | "Ping",
  headers: http2.OutgoingHttpHeaders = {},
): http2.ClientHttp2Stream => {
  const stream = session.request({
    ":method": "POST",
    ":path": `/effect_grpc_test.OutcomeService/${method}`,
    "content-type": "application/grpc",
    te: "trailers",
    ...headers,
  });
  stream.on("error", () => {});
  stream.end(Buffer.alloc(5));
  return stream;
};

const call = (
  session: http2.ClientHttp2Session,
  method: "Run" | "Ping",
  headers?: http2.OutgoingHttpHeaders,
) =>
  Effect.async<{
    readonly stream: number;
    readonly code: Code | undefined;
    readonly message: string | undefined;
  }>((resume) => {
    const stream = open(session, method, headers);
    let code: Code | undefined;
    let message: string | undefined;
    const read = (fields: http2.IncomingHttpHeaders): void => {
      if (fields["grpc-status"] !== undefined) code = Number(fields["grpc-status"]);
      if (fields["grpc-message"] !== undefined) {
        message = decodeURIComponent(String(fields["grpc-message"]));
      }
    };
    stream.on("response", read);
    stream.on("trailers", read);
    stream.on("close", () => resume(Effect.succeed({ stream: stream.id ?? 0, code, message })));
    stream.resume();
    return Effect.sync(() => stream.close(http2.constants.NGHTTP2_CANCEL));
  });

const frameTypes = [
  "DATA",
  "HEADERS",
  "PRIORITY",
  "RST_STREAM",
  "SETTINGS",
  "PUSH_PROMISE",
  "PING",
  "GOAWAY",
  "WINDOW_UPDATE",
  "CONTINUATION",
];

/**
 * A client that cancels reads nothing more from its stream, so a TCP relay between the client and
 * the server records the type of each frame the server sends, per stream.
 */
const frameTap = (port: number) =>
  Effect.gen(function* () {
    const frames = new Map<number, Array<string>>();
    const serverClosed = yield* Deferred.make<void>();
    const sockets: Array<net.Socket> = [];
    const relay = yield* Effect.acquireRelease(
      Effect.async<net.Server>((resume) => {
        const relay = net.createServer((client) => {
          const upstream = net.connect(port, "127.0.0.1");
          sockets.push(client, upstream);
          let pending = Buffer.alloc(0);
          upstream.on("data", (chunk: Buffer) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 9 && pending.length >= 9 + pending.readUIntBE(0, 3)) {
              const type = pending.readUInt8(3);
              const stream = pending.readUInt32BE(5) & 0x7fffffff;
              if (stream !== 0) {
                frames.set(stream, [
                  ...(frames.get(stream) ?? []),
                  frameTypes[type] ?? String(type),
                ]);
              }
              pending = pending.subarray(9 + pending.readUIntBE(0, 3));
            }
            client.write(chunk);
          });
          client.pipe(upstream);
          upstream.on("end", () => client.end());
          upstream.on("close", () => Deferred.unsafeDone(serverClosed, Effect.void));
          client.on("error", () => {});
          upstream.on("error", () => {});
        });
        relay.listen(0, "127.0.0.1", () => resume(Effect.succeed(relay)));
      }),
      (relay) =>
        Effect.sync(() => {
          sockets.forEach((socket) => socket.destroy());
          relay.close();
        }),
    );
    const address = relay.address();
    const relayPort = address !== null && typeof address === "object" ? address.port : 0;
    return {
      url: `http://127.0.0.1:${relayPort}`,
      framesOn: (stream: number): ReadonlyArray<string> => frames.get(stream) ?? [],
      serverClosed: Deferred.await(serverClosed),
    };
  });

const observeCancel = (row: Outcome) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const handlerEnd = yield* Ref.make<HandlerEnd>("still running");
    const address = yield* serve(row, () =>
      Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(row.handler()),
        Effect.onExit((exit) =>
          Ref.set(handlerEnd, Exit.isInterrupted(exit) ? "interrupted" : "ended another way"),
        ),
      ),
    );
    const tap = yield* frameTap(address.port);
    const session = yield* connect(tap.url);

    const cancelled = open(session, "Run");
    yield* Deferred.await(started);
    cancelled.close(http2.constants.NGHTTP2_CANCEL);
    const ping = yield* call(session, "Ping");
    // Once the server closes the connection, it can send no more frames on the cancelled stream.
    session.close();
    yield* tap.serverClosed;

    expect(ping.code, "the connection still serves a call after the cancel").toBe(0);
    expect(tap.framesOn(ping.stream), "the tap records the server's frames").toContain("HEADERS");
    return {
      kind: "after the cancel",
      frames: tap.framesOn(cancelled.id ?? 0),
      handler: yield* Ref.get(handlerEnd),
    } satisfies Sent;
  });

const observe = (row: Outcome): Effect.Effect<Sent, Server.GrpcServerBindError, Scope.Scope> =>
  row.call === "cancels once the handler runs" ?
    observeCancel(row)
  : Effect.gen(function* () {
      const address = yield* serve(row, row.handler);
      const session = yield* connect(address.url);
      const reply = yield* call(
        session,
        "Run",
        row.call === "sends a 50 ms deadline" ? { "grpc-timeout": "50m" } : {},
      );
      return { kind: "status", code: reply.code, message: reply.message } satisfies Sent;
    });

describe("what the server sends for each handler outcome", () => {
  for (const row of outcomes) {
    it(`${row.outcome}, when the client ${row.call}`, () =>
      Effect.gen(function* () {
        expect(yield* observe(row)).toEqual(row.sends);
      }).pipe(Effect.scoped, Effect.runPromise));
  }
});
