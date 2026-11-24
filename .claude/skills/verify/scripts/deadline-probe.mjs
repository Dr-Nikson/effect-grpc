// .claude/skills/verify/scripts/deadline-probe.mjs
import http2 from "node:http2";
import process from "node:process";

import { create, toBinary } from "@bufbuild/protobuf";

import { GetGreetingRequestSchema } from "./dist/generated/com/example/v1/hello_world_api_pb.js";

const { DEADLINE_URL: url, DEADLINE_MS: deadlineMs } = process.env;
if (!url || !/^\d+$/.test(deadlineMs ?? "")) {
  throw new Error("set DEADLINE_URL and DEADLINE_MS; run this file through control-example");
}
const path = "/com.example.v1.HelloWorldAPI/GetGreetingSlowly";
const name = "deadline";

const envelope = (message) => {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};
const binaryRequest = envelope(
  toBinary(GetGreetingRequestSchema, create(GetGreetingRequestSchema, { name })),
);

// Node's HTTP/2 client sends the deadline header and keeps no timer of its own, so the status each
// line reports is the one the server sent.
const requests = {
  grpc: {
    headers: { "content-type": "application/grpc", te: "trailers", "grpc-timeout": `${deadlineMs}m` },
    body: binaryRequest,
  },
  "grpc-web": {
    headers: { "content-type": "application/grpc-web+proto", "grpc-timeout": `${deadlineMs}m` },
    body: binaryRequest,
  },
  connect: {
    headers: { "content-type": "application/json", "connect-timeout-ms": deadlineMs },
    body: JSON.stringify({ name }),
  },
};

/** gRPC-web carries its trailers in the body, as a frame whose flag byte has the high bit set. */
const grpcWebTrailers = (body) => {
  let offset = 0;
  while (offset + 5 <= body.length) {
    const length = body.readUInt32BE(offset + 1);
    if ((body[offset] & 0x80) !== 0) {
      const lines = body.subarray(offset + 5, offset + 5 + length).toString("utf8").split("\r\n");
      return Object.fromEntries(
        lines.filter((line) => line.includes(":")).map((line) => {
          const colon = line.indexOf(":");
          return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
        }),
      );
    }
    offset += 5 + length;
  }
  return {};
};

const session = http2.connect(url);
session.on("error", () => {});

const call = (protocol) =>
  new Promise((resolve) => {
    const started = Date.now();
    const fields = {};
    const chunks = [];
    const stream = session.request({ ":method": "POST", ":path": path, ...requests[protocol].headers });
    stream.on("response", (headers) => Object.assign(fields, headers));
    stream.on("trailers", (trailers) => Object.assign(fields, trailers));
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", () => {});
    stream.on("close", () => {
      const body = Buffer.concat(chunks);
      const ms = Date.now() - started;
      if (protocol === "connect") {
        const json = body.length > 0 ? JSON.parse(body.toString("utf8")) : {};
        resolve({ protocol, ms, httpStatus: fields[":status"], code: json.code, message: json.message });
        return;
      }
      const status = protocol === "grpc-web" ? { ...grpcWebTrailers(body), ...fields } : fields;
      resolve({
        protocol,
        ms,
        httpStatus: fields[":status"],
        grpcStatus: status["grpc-status"] === undefined ? null : Number(status["grpc-status"]),
        message:
          status["grpc-message"] === undefined ? null : decodeURIComponent(status["grpc-message"]),
      });
    });
    stream.end(requests[protocol].body);
  });

let failed = false;
for (const protocol of Object.keys(requests)) {
  const reply = await call(protocol);
  const passed =
    protocol === "connect" ?
      reply.httpStatus === 504 && reply.code === "deadline_exceeded"
    : reply.httpStatus === 200 && reply.grpcStatus === 4;
  failed ||= !passed;
  process.stdout.write(`${JSON.stringify({ ...reply, passed })}\n`);
}
session.close();
process.stdout.write(`verdict=${failed ? "FAIL" : "PASS"}\n`);
process.exitCode = failed ? 1 : 0;
