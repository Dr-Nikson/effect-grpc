// packages/effect-grpc/src/testing/rawHttp2.ts
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import http2 from "node:http2";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import {
  GetGreetingRequestSchema,
  GetGreetingResponseSchema,
} from "../generated/com/example/v1/hello_world_api_pb.js";
import { TestServer } from "./harness.js";

export type Protocol = "grpc" | "grpc-web" | "connect";

export interface RawRequest {
  readonly protocol: Protocol;
  readonly authority: string;
  readonly header?: ":authority" | "host" | undefined;
  readonly name?: string;
}

export interface RawReply {
  readonly httpStatus: Option.Option<number>;
  /** The gRPC status code of a gRPC or gRPC-web reply, or the error code of a Connect reply. */
  readonly status: Option.Option<string>;
  readonly greeting: Option.Option<string>;
}

export class RawClient extends Context.Tag("@dr_nikson/effect-grpc/testing/RawClient")<
  RawClient,
  http2.ClientHttp2Session
>() {}

export const rawClient: Layer.Layer<RawClient, never, TestServer> = Layer.scoped(
  RawClient,
  Effect.flatMap(TestServer, ({ url }) =>
    Effect.acquireRelease(
      Effect.sync(() => http2.connect(url).on("error", () => {})),
      (session) => Effect.sync(() => session.destroy()),
    ),
  ),
);

const path = "/com.example.v1.HelloWorldAPI/GetGreeting";

const contentTypes: Record<Protocol, string> = {
  grpc: "application/grpc",
  "grpc-web": "application/grpc-web+proto",
  connect: "application/json",
};

const frame = (payload: Uint8Array): Buffer => {
  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(payload.length, 1);
  return Buffer.concat([prefix, payload]);
};

const requestBody = (protocol: Protocol, name: string): Buffer =>
  protocol === "connect" ?
    Buffer.from(JSON.stringify({ name }))
  : frame(toBinary(GetGreetingRequestSchema, create(GetGreetingRequestSchema, { name })));

interface Response {
  readonly headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;
  readonly trailers: http2.IncomingHttpHeaders;
  readonly body: Buffer;
}

type Update = (response: Response) => Response;

const exchange = (stream: http2.ClientHttp2Stream, body: Buffer): Stream.Stream<Update, Error> =>
  Stream.asyncPush<Update, Error>(
    (emit) =>
      Effect.sync(() => {
        stream
          .on("response", (headers) => emit.single((response) => ({ ...response, headers })))
          .on("trailers", (trailers) => emit.single((response) => ({ ...response, trailers })))
          .on("data", (chunk: Buffer) =>
            emit.single((response) => ({
              ...response,
              body: Buffer.concat([response.body, chunk]),
            })),
          )
          .on("error", (error) => emit.fail(error))
          .on("close", () => emit.end())
          .end(body);
      }),
    { bufferSize: "unbounded" },
  );

const ConnectBody = Schema.parseJson(
  Schema.Struct({ greeting: Schema.optional(Schema.String), code: Schema.optional(Schema.String) }),
);

const connectReply = ({ headers, body }: Response) =>
  Schema.decodeUnknown(ConnectBody)(body.toString("utf8")).pipe(
    Effect.map(({ greeting, code }) => ({
      httpStatus: Option.fromNullable(headers[":status"]),
      status: Option.fromNullable(code),
      greeting: Option.fromNullable(greeting),
    })),
  );

// The first frame of a gRPC or gRPC-web body is the message. A gRPC-web body ends with a second
// frame that carries the trailers, so the message is cut by its length prefix.
const grpcReply = ({ headers, trailers, body }: Response) =>
  Effect.sync(() => ({
    httpStatus: Option.fromNullable(headers[":status"]),
    status: Option.firstSomeOf([
      Option.fromNullable(headers["grpc-status"]),
      Option.fromNullable(trailers["grpc-status"]),
    ]).pipe(Option.map(String)),
    greeting: Option.liftPredicate(body, (bytes) => bytes.length >= 5 && bytes[0] === 0).pipe(
      Option.map(
        (bytes) =>
          fromBinary(GetGreetingResponseSchema, bytes.subarray(5, 5 + bytes.readUInt32BE(1)))
            .greeting,
      ),
    ),
  }));

export const send = ({
  protocol,
  authority,
  header = ":authority",
  name = "hostile",
}: RawRequest) =>
  Effect.gen(function* () {
    const session = yield* RawClient;
    const stream = yield* Effect.sync(() =>
      session.request({
        ":method": "POST",
        ":path": path,
        [header]: authority,
        "content-type": contentTypes[protocol],
        ...(protocol === "grpc" ? { te: "trailers" } : {}),
      }),
    );
    const response = yield* exchange(stream, requestBody(protocol, name)).pipe(
      Stream.runFold<Response, Update>(
        { headers: {}, trailers: {}, body: Buffer.alloc(0) },
        (current, update) => update(current),
      ),
    );

    return yield* protocol === "connect" ? connectReply(response) : grpcReply(response);
  }).pipe(Effect.timeout("5 seconds"));
