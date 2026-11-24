// packages/e2e-tests/src/raw-unary.ts
import { Effect, Scope } from "effect";
import http2 from "node:http2";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import {
  GetGreetingRequestSchema,
  GetGreetingResponseSchema,
} from "./generated/com/example/v1/hello_world_api_pb.js";

export type Protocol = "grpc" | "connect";

export const protocols: ReadonlyArray<Protocol> = ["grpc", "connect"];

export interface RawReply {
  readonly httpStatus: number | undefined;
  readonly contentType: string | undefined;
  readonly headersEndedStream: boolean;
  readonly grpcStatus: string | undefined;
  readonly grpcMessage: string | undefined;
  readonly connectCode: string | undefined;
  readonly greeting: string | undefined;
  readonly rstCode: number | undefined;
}

const path = "/com.example.v1.HelloWorldAPI/GetGreeting";

const header = (value: string | Array<string> | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const envelope = (message: Uint8Array): Buffer => {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};

const decodeBody = (
  protocol: Protocol,
  httpStatus: number | undefined,
  grpcStatus: string | undefined,
  body: Buffer,
): Pick<RawReply, "connectCode" | "greeting"> => {
  if (protocol === "grpc") {
    return {
      connectCode: undefined,
      greeting:
        grpcStatus === "0" ?
          fromBinary(GetGreetingResponseSchema, body.subarray(5)).greeting
        : undefined,
    };
  }
  if (httpStatus === undefined) return { connectCode: undefined, greeting: undefined };
  const json: { readonly code?: string; readonly greeting?: string } = JSON.parse(
    body.toString("utf8"),
  );
  return { connectCode: json.code, greeting: json.greeting };
};

export const connect = (url: string): Effect.Effect<http2.ClientHttp2Session, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => http2.connect(url).on("error", () => {})),
    (session) => Effect.sync(() => session.destroy()),
  );

export const getGreeting = (
  session: http2.ClientHttp2Session,
  protocol: Protocol,
  authority: string,
  name: string,
  contentType: string = protocol === "grpc" ? "application/grpc" : "application/json",
): Effect.Effect<RawReply> =>
  Effect.async<RawReply>((resume) => {
    const message = toBinary(GetGreetingRequestSchema, create(GetGreetingRequestSchema, { name }));
    const stream = session.request({
      ":method": "POST",
      ":path": path,
      ":authority": authority,
      "content-type": contentType,
      ...(protocol === "grpc" ? { te: "trailers" } : {}),
    });

    let httpStatus: number | undefined;
    let responseContentType: string | undefined;
    let headersEndedStream = false;
    let grpcStatus: string | undefined;
    let grpcMessage: string | undefined;
    const chunks: Array<Buffer> = [];
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      const body = Buffer.concat(chunks);
      const rstCode = stream.rstCode;
      // The server can stop reading an oversized upload once it has answered; drop the rest.
      stream.close(http2.constants.NGHTTP2_CANCEL);
      resume(
        Effect.try(() => ({
          httpStatus,
          contentType: responseContentType,
          headersEndedStream,
          grpcStatus,
          grpcMessage: grpcMessage === undefined ? undefined : decodeURIComponent(grpcMessage),
          ...decodeBody(protocol, httpStatus, grpcStatus, body),
          rstCode,
        })).pipe(Effect.orDie),
      );
    };

    stream.on("response", (headers, flags) => {
      httpStatus = headers[":status"];
      responseContentType = header(headers["content-type"]);
      headersEndedStream = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
      grpcStatus = header(headers["grpc-status"]);
      grpcMessage = header(headers["grpc-message"]);
    });
    stream.on("trailers", (trailers) => {
      grpcStatus = header(trailers["grpc-status"]);
      grpcMessage = header(trailers["grpc-message"]);
    });
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", () => {});
    stream.end(protocol === "grpc" ? envelope(message) : JSON.stringify({ name }));

    return Effect.sync(() => stream.close(http2.constants.NGHTTP2_CANCEL));
  });
