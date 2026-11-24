// .claude/skills/verify/scripts/hostile-requests.mjs
import { readFileSync } from "node:fs";
import http2 from "node:http2";
import process from "node:process";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import {
  GetGreetingRequestSchema,
  GetGreetingResponseSchema,
} from "./dist/generated/com/example/v1/hello_world_api_pb.js";

const { HOSTILE_URL: url, HOSTILE_FIXTURES: fixturesPath, HOSTILE_MODE: mode } = process.env;
if (!url || !fixturesPath || !["authority", "message-limit"].includes(mode)) {
  throw new Error(
    "set HOSTILE_URL, HOSTILE_FIXTURES and HOSTILE_MODE; run this file through control-example",
  );
}
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));
const expand = ({ repeat, times }) => repeat.repeat(times);
const protocols = ["grpc", "connect"];
const path = "/com.example.v1.HelloWorldAPI/GetGreeting";

const session = http2.connect(url);
session.on("error", () => {});

const envelope = (message) => {
  const frame = Buffer.alloc(5 + message.length);
  frame.writeUInt32BE(message.length, 1);
  frame.set(message, 5);
  return frame;
};

// With `authority` undefined, Node's client sends its default for the session URL, which for an
// IPv6 literal URL is the address and port without brackets.
const call = (protocol, authority, name) =>
  new Promise((resolve) => {
    const headers = {
      ":method": "POST",
      ":path": path,
      ...(authority === undefined ? {} : { ":authority": authority }),
      ...(protocol === "grpc" ?
        { "content-type": "application/grpc", te: "trailers" }
      : { "content-type": "application/json" }),
    };
    const reply = { httpStatus: undefined, headersEndedStream: false, grpcStatus: undefined };
    const chunks = [];
    const stream = session.request(headers);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      reply.rstCode = stream.rstCode;
      stream.close(http2.constants.NGHTTP2_CANCEL);
      const body = Buffer.concat(chunks);
      if (protocol === "grpc" && reply.grpcStatus === "0") {
        reply.greeting = fromBinary(GetGreetingResponseSchema, body.subarray(5)).greeting;
      } else if (protocol === "connect" && reply.httpStatus !== undefined) {
        const json = JSON.parse(body.toString("utf8"));
        reply.greeting = json.greeting;
        reply.connectCode = json.code;
      }
      resolve(reply);
    };
    stream.on("response", (h, flags) => {
      reply.httpStatus = h[":status"];
      reply.headersEndedStream = (flags & http2.constants.NGHTTP2_FLAG_END_STREAM) !== 0;
      reply.grpcStatus = h["grpc-status"];
    });
    stream.on("trailers", (t) => (reply.grpcStatus = t["grpc-status"]));
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", () => {});
    const message = toBinary(GetGreetingRequestSchema, create(GetGreetingRequestSchema, { name }));
    stream.end(protocol === "grpc" ? envelope(message) : JSON.stringify({ name }));
  });

const results = [];
const report = () => {
  const failed = results.filter((pass) => !pass).length;
  console.log(JSON.stringify({ verdict: failed === 0 ? "PASS" : "FAIL", checks: results.length, failed }));
  process.exit(failed === 0 ? 0 : 1);
};
const check = (name, pass, reply) => {
  const observed = { ...reply, greeting: reply.greeting?.slice(0, 60) };
  results.push(pass);
  console.log(JSON.stringify({ check: name, pass, observed }));
  if (session.destroyed) {
    results.push(false);
    console.log(JSON.stringify({ check: "the connection to the server is still open", pass: false }));
    report();
  }
};

const greeted = (reply, name) =>
  reply.greeting?.startsWith(`Hey there! Your name is ${name.slice(0, 20)}`) === true;
const invalidArgument = (reply, protocol) =>
  protocol === "grpc" ?
    reply.httpStatus === 200 && reply.headersEndedStream && reply.grpcStatus === "3"
  : reply.httpStatus === 400 && reply.connectCode === "invalid_argument";

const expectServing = async (after) => {
  for (const protocol of protocols) {
    const reply = await call(protocol, undefined, "next");
    check(`a normal call over ${protocol} after ${after}`, greeted(reply, "next"), reply);
  }
};

if (mode === "authority") {
  const cases = [
    ...fixtures.servedAuthorities.map(({ case: name, authority }) => ({ name, authority, served: true })),
    ...fixtures.rejectedAuthorities.map(({ case: name, authority }) => ({ name, authority, served: false })),
    ...fixtures.longAuthorities.map(({ case: name, authority, served }) => ({
      name,
      authority: expand(authority),
      served,
    })),
  ];
  for (const { name, authority, served } of cases) {
    for (const protocol of protocols) {
      const reply = await call(protocol, authority, "hostile");
      check(
        `${name} over ${protocol} ${served ? "is served" : "gets INVALID_ARGUMENT"}`,
        served ? greeted(reply, "hostile") : invalidArgument(reply, protocol),
        reply,
      );
    }
    await expectServing(name);
  }
  for (const protocol of protocols) {
    const reply = await call(protocol, fixtures.emptyAuthority, "hostile");
    check(
      `an empty authority over ${protocol} is reset with PROTOCOL_ERROR`,
      reply.rstCode === http2.constants.NGHTTP2_PROTOCOL_ERROR,
      reply,
    );
  }
  await expectServing("an empty authority");
} else {
  const { nameAtLimit, nameOverLimit } = fixtures.messageLimit;
  const atLimit = expand(nameAtLimit);
  const overLimit = expand(nameOverLimit);
  const limit = await call("grpc", undefined, atLimit);
  check("a message of exactly 4 MiB over grpc is served", greeted(limit, atLimit), limit);
  const grpc = await call("grpc", undefined, overLimit);
  check("a 5 MiB message over grpc gets RESOURCE_EXHAUSTED", grpc.grpcStatus === "8", grpc);
  const connect = await call("connect", undefined, overLimit);
  check(
    "a 5 MiB message over connect gets RESOURCE_EXHAUSTED",
    connect.httpStatus === 429 && connect.connectCode === "resource_exhausted",
    connect,
  );
  await expectServing("the oversized messages");
}

report();
