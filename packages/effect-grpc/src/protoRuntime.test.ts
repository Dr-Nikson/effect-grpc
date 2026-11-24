// packages/effect-grpc/src/protoRuntime.test.ts
import { Cause, Deferred, Effect, Exit, Layer, References } from "effect";
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
import { Code, ConnectError } from "@connectrpc/connect";

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
      readonly code: string;
      readonly message: string | undefined;
    }
  | {
      readonly kind: "after the cancel";
      readonly frames: ReadonlyArray<string>;
      readonly handler: HandlerEnd;
      /**
       * The status of the error the executor hands Connect to send. The cancelled stream carries
       * nothing more, so this is the only place the server's status for a cancel shows.
       */
      readonly handedToConnect: string;
    };

interface Outcome {
  readonly outcome: string;
  readonly call: "waits for the reply" | "sends a 50 ms deadline" | "cancels once the handler runs";
  readonly handler: Handler;
  readonly contextTransformer?: () => Effect.Effect<unknown, GrpcException.GrpcException>;
  readonly sends: Sent;
}

const codeName = (code: number | undefined): string =>
  code === undefined ? "no grpc-status" : (Code[code] ?? String(code));

const status = (code: Code, message: string): Sent => ({
  kind: "status",
  code: codeName(code),
  message,
});

/**
 * A call gets one status. A deadline or a client cancel that interrupts the handler gives its own
 * status, even when a finalizer dies. Otherwise the first typed failure gives its status, also when
 * a finalizer dies after it, although Effect 4 then reports the failure as a defect. Any other defect
 * gives Internal with a fixed message.
 */
const outcomes: ReadonlyArray<Outcome> = [
  {
    outcome: "a typed failure",
    call: "waits for the reply",
    handler: () =>
      Effect.fail(GrpcException.create(Code.FailedPrecondition, "Face the consequences!")),
    sends: status(Code.FailedPrecondition, "Face the consequences!"),
  },
  {
    outcome: "a defect",
    call: "waits for the reply",
    handler: () => Effect.die(new Error("the handler died")),
    sends: status(Code.Internal, "Internal server error"),
  },
  {
    outcome: "a client cancel",
    call: "cancels once the handler runs",
    handler: () => Effect.never,
    sends: {
      kind: "after the cancel",
      frames: [],
      handler: "interrupted",
      handedToConnect: "Canceled",
    },
  },
  {
    outcome: "a deadline expiry",
    call: "sends a 50 ms deadline",
    handler: () => Effect.never,
    sends: status(Code.DeadlineExceeded, "the operation timed out"),
  },
  {
    outcome: "a deadline expiry with a dying finalizer",
    call: "sends a 50 ms deadline",
    handler: () => Effect.never.pipe(Effect.ensuring(Effect.die(new Error("the finalizer died")))),
    sends: status(Code.DeadlineExceeded, "the operation timed out"),
  },
  {
    outcome: "a typed failure with a dying finalizer",
    call: "waits for the reply",
    handler: () =>
      Effect.fail(GrpcException.create(Code.NotFound, "typed failure")).pipe(
        Effect.ensuring(Effect.die(new Error("the finalizer died"))),
      ),
    sends: status(Code.NotFound, "typed failure"),
  },
  {
    outcome: "a defect with a dying finalizer",
    call: "waits for the reply",
    handler: () =>
      Effect.die(new Error("the handler died")).pipe(
        Effect.ensuring(Effect.die(new Error("the finalizer died"))),
      ),
    sends: status(Code.Internal, "Internal server error"),
  },
  {
    outcome: "a defect that is a GrpcException",
    call: "waits for the reply",
    handler: () => Effect.die(GrpcException.create(Code.NotFound, "typed failure")),
    sends: status(Code.Internal, "Internal server error"),
  },
  {
    outcome: "a throw inside a context transformer",
    call: "waits for the reply",
    contextTransformer: () => {
      throw new Error("the context transformer threw");
    },
    handler: () => Effect.succeed({}),
    sends: status(Code.Internal, "Internal server error"),
  },
  {
    outcome: "a typed failure inside a context transformer",
    call: "waits for the reply",
    contextTransformer: () => Effect.fail(GrpcException.create(Code.Unauthenticated, "no token")),
    handler: () => Effect.succeed({}),
    sends: status(Code.Unauthenticated, "no token"),
  },
  {
    outcome: "a throw inside the handler body",
    call: "waits for the reply",
    handler: () => {
      throw new Error("the handler threw");
    },
    sends: status(Code.Internal, "Internal server error"),
  },
  {
    outcome: "an interrupt inside the handler",
    call: "waits for the reply",
    handler: () => Effect.interrupt,
    sends: status(Code.Aborted, "Request was canceled"),
  },
  {
    outcome: "two typed failures in one cause",
    call: "waits for the reply",
    handler: () =>
      Effect.failCause(
        Cause.combine(
          Cause.fail(GrpcException.create(Code.NotFound, "first")),
          Cause.fail(GrpcException.create(Code.AlreadyExists, "second")),
        ),
      ),
    sends: status(Code.NotFound, "first"),
  },
  {
    outcome: "a typed failure while concurrent work is interrupted",
    call: "waits for the reply",
    handler: () =>
      Effect.all([Effect.fail(GrpcException.create(Code.NotFound, "first")), Effect.never], {
        concurrency: "unbounded",
      }).pipe(Effect.as({})),
    sends: status(Code.NotFound, "first"),
  },
  {
    outcome: "an empty cause",
    call: "waits for the reply",
    handler: () => Effect.failCause(Cause.empty),
    sends: status(Code.Unknown, "Unknown error"),
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

const serve = (row: Outcome, handler: Handler, handedToConnect: Deferred.Deferred<string>) => {
  const service = Server.GrpcService(
    "effect_grpc_test.OutcomeService",
    OutcomeService,
  )((executor) => ({
    run: (request, context) => {
      const reply = executor.unary(
        "effect_grpc_test.OutcomeService/Run",
        request,
        context,
        handler,
      );
      reply.then(
        () => Deferred.doneUnsafe(handedToConnect, Effect.succeed("a reply")),
        (error: unknown) =>
          Deferred.doneUnsafe(
            handedToConnect,
            Effect.succeed(codeName(ConnectError.from(error).code)),
          ),
      );
      return reply;
    },
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
  Effect.callback<{
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
    stream.on("close", () =>
      resume(
        stream.id !== undefined && stream.rstCode === http2.constants.NGHTTP2_NO_ERROR ?
          Effect.succeed({ stream: stream.id, code, message })
        : Effect.die(new Error(`${method} did not end cleanly: RST_STREAM ${stream.rstCode}`)),
      ),
    );
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
      Effect.callback<net.Server>((resume) => {
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
          upstream.on("end", () => {
            client.end();
            Deferred.doneUnsafe(serverClosed, Effect.void);
          });
          upstream.on("error", (error) => Deferred.doneUnsafe(serverClosed, Effect.die(error)));
          client.on("error", () => {});
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
      allServerFramesSeen: Deferred.await(serverClosed),
    };
  });

const observeCancel = (row: Outcome) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const ended = yield* Deferred.make<HandlerEnd>();
    const handedToConnect = yield* Deferred.make<string>();
    const address = yield* serve(
      row,
      () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(row.handler()),
          Effect.onExit((exit) =>
            Deferred.succeed(ended, Exit.hasInterrupts(exit) ? "interrupted" : "ended another way"),
          ),
        ),
      handedToConnect,
    );
    const tap = yield* frameTap(address.port);
    const session = yield* connect(tap.url);

    const cancelled = open(session, "Run");
    yield* Deferred.await(started);
    const cancelledStream = cancelled.id;
    if (cancelledStream === undefined) return yield* Effect.die(new Error("Run has no stream id"));
    cancelled.close(http2.constants.NGHTTP2_CANCEL);
    const handler = yield* Deferred.await(ended).pipe(
      Effect.timeoutOrElse({
        duration: "2 seconds",
        orElse: () => Effect.succeed<HandlerEnd>("still running"),
      }),
    );
    const handed = yield* Deferred.await(handedToConnect).pipe(
      Effect.timeoutOrElse({ duration: "2 seconds", orElse: () => Effect.succeed("nothing") }),
    );
    const ping = yield* call(session, "Ping");
    session.close();
    yield* tap.allServerFramesSeen;

    expect(ping.code, "the connection still serves a call after the cancel").toBe(0);
    expect(tap.framesOn(ping.stream), "the tap records the server's frames").toContain("HEADERS");
    return {
      kind: "after the cancel",
      frames: tap.framesOn(cancelledStream),
      handler,
      handedToConnect: handed,
    } satisfies Sent;
  });

const observe = (row: Outcome): Effect.Effect<Sent, Server.GrpcServerBindError, Scope.Scope> =>
  row.call === "cancels once the handler runs" ?
    observeCancel(row)
  : Effect.gen(function* () {
      const address = yield* serve(row, row.handler, yield* Deferred.make<string>());
      const session = yield* connect(address.url);
      const reply = yield* call(
        session,
        "Run",
        row.call === "sends a 50 ms deadline" ? { "grpc-timeout": "50m" } : {},
      );
      return {
        kind: "status",
        code: codeName(reply.code),
        message: reply.message,
      } satisfies Sent;
    });

describe("what the server sends for each handler outcome", () => {
  for (const row of outcomes) {
    it(`${row.outcome}, when the client ${row.call}`, async () => {
      const sent = await Effect.runPromise(
        observe(row).pipe(
          Effect.scoped,
          Effect.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
      );
      expect(sent).toEqual(row.sends);
    });
  }
});
