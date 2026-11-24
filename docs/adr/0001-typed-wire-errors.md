# Typed wire errors

Status: accepted on 2026-11-24 in #72. P24 (#77), P25 (#12, #27) and P30 (#82) build on it.

A failed RPC reaches an effect-grpc 4.x client as a typed failure, never as a defect. The failure is `GrpcException`, a port of grpc-java's `StatusException`: a status code, the wire message, application metadata and protobuf details, sent in the status that every gRPC implementation reads. A method can list in a proto option the protobuf messages it fails with. Its handler and its client method then fail with a declared error for each message, and `Effect.catchTag` catches it by the message's full name.

## Context

effect-grpc 3.x loses most of a failed call between the handler and the caller:

- The client turns every failed call into a defect. `client.internal.ts` bridges each call with `Effect.promise`, and the generated client method returns `Effect<Out>`, so no Effect error operator sees a failure.
- The server sends only the status code and the message. `toConnectError` drops `description`, and a `GrpcException` cannot hold metadata or details.
- A method cannot say which errors it fails with, so every handler and every client method has the same generic error type.

The design must work for the gRPC, gRPC-web and Connect protocols and keep what it sends in HTTP/2 headers small. It uses Effect's `Option` for absent values, as `agents/CODING_STANDARDS.md` requires, and it follows grpc-java's `StatusException`, as #12 asks.

## What we measured

The facts below come from probes on the versions in the lockfile: effect 4.1.5, @connectrpc/connect and connect-node 2.3.0, @bufbuild/protobuf and protoc-gen-es 2.17.0, buf 1.75.0 and Node 24.22.3. A connect-node server answered Connect clients on cleartext HTTP/2, as effect-grpc's server and client do, and `buf curl` was the client written in Go.

- **Status, metadata and details reach every client.** A handler threw a `ConnectError` with a code, a message, two metadata entries and two details. The Node client received all of them over gRPC, gRPC-web and Connect. `buf curl` printed the code, the message and the details over all three protocols, and the metadata over gRPC and Connect.
- **Unknown details stay raw.** `ConnectError.findDetails` decodes only the types it is given and skips the others without an error. The skipped details stay in `ConnectError.details` as a type name and bytes.
- **Connect keeps protocol keys out of error metadata.** The server drops keys such as `grpc-status` and `content-type` that a handler puts in an error's metadata. The client's `ConnectError.metadata` is the union of response headers and trailers, so it holds protocol keys too. Connect's own `mergeNonProtocolHeaders` reduces it to exactly the handler's keys on all three protocols.
- **A rethrown wire error loses its metadata.** A handler that rethrows a `ConnectError` from an upstream call relays its code, message and details, but not its metadata.
- **Failures that never reach a server have a code.** A closed port gives `UNAVAILABLE`, a passed deadline gives `DEADLINE_EXCEEDED`, and an aborted call gives `CANCELLED`.
- **A large status destroys itself on gRPC.** Over gRPC, a detail of 48,000 bytes arrived. A detail of 64,000 bytes made the client see `INTERNAL` "Stream closed with error code NGHTTP2_FRAME_SIZE_ERROR", so the real code, message and details were lost. gRPC-web carries trailers in the response body and Connect carries details in the JSON body, and both delivered 200,000 bytes.
- **An interrupted caller stays interrupted.** With `Effect.tryPromise`, a failed call is a typed failure. When the calling fiber is interrupted, its `Exit` holds only the interruption, and the server sees the stream canceled.
- **A proto type name works as a tag.** `Effect.catchTag("probe.v1.UserNotFound", ...)` matches an error with that `_tag`.
- **An `Option` cause garbles logs.** A `Data.TaggedError` with an `Option` in its `cause` field hands the `Option` to `Error.cause`. `Cause.pretty` then prints `[cause]: Error: some(Error: socket hang up)` without the cause's stack, and `none()` when there is no cause.
- **protobuf-es reads a method option at run time.** For a `MethodOptions` extension, protoc-gen-es generates a `GenExtension`, and `getOption` reads the option from the descriptor in the generated code.
- **Generated code imports the options file.** A `_pb.ts` file whose proto imports `effect_grpc/v1/options.proto` imports the generated `options_pb.js` by a relative path.
- **buf reads protos from an npm package.** A buf v2 workspace that lists `node_modules/@dr_nikson/effect-grpc/proto` as a module compiles a proto that imports the options file. `buf generate` then writes code for both files, with no network.

## Decisions

### `GrpcException` is a gRPC status

| Field | Type | On the wire | Since |
|---|---|---|---|
| `_tag` | `"GrpcException"` | never | P25 |
| `code` | `Code` from `@connectrpc/connect` | `grpc-status`, or the Connect error code | 3.x |
| `message` | `string` | `grpc-message`, or the Connect error message | 3.x |
| `metadata` | `Record.ReadonlyRecord<string, string>` with lower-case keys | trailers, or the Connect response headers | P24 |
| `details` | `ReadonlyArray<Any>`, protobuf-es's `google.protobuf.Any` | `grpc-status-details-bin`, or the Connect `details` | P24 |
| `cause` | the standard `Error.cause` | never | 3.x |

- `message` is the text that the peer reads, the field that grpc-java calls the status description. The 3.x `description` field never reached the wire, so 4.x removes it together with `withDescription`. Put the context a caller needs in `message`, and the context for logs in `cause`.
- `metadata` holds only the application's keys. The client removes the protocol keys with Connect's `mergeNonProtocolHeaders`, which keeps exactly the handler's keys on all three protocols. An empty record means no metadata, so the field is never absent. Read one key as an `Option` with `Record.get`. Metadata that a client received stays with the caller: a server that fails with the same exception sends its code, its message and its details, but not that metadata, as Connect does for a rethrown wire error. To forward metadata, a handler builds a new exception with the keys it chooses.
- `details` holds each detail as a `google.protobuf.Any`, the type that `google.rpc.Status` uses on the wire. A detail of a type that nobody registered stays readable, and a server relays it unchanged. `GrpcException.findDetail` decodes the first detail of a type as an `Option`, and protobuf-es's `anyPack` builds a detail for a server.
- `cause` stays the standard `Error.cause` and never goes on the wire. An `Option` in that slot made `Cause.pretty` print `some(...)` without the cause's stack. Library code reads the cause with `Option.fromNullishOr`, at the boundary where a platform value enters, as `agents/CODING_STANDARDS.md` allows.

`create(code, message, cause?)` stays the short form. The constructor, `new GrpcException.GrpcException({ code, message, metadata, details, cause })`, is the full form, as Effect's own `HttpClientError` does it, and it fills an empty record and an empty list for the fields it is not given. `from(code, cause)` returns a `GrpcException` unchanged. For a `ConnectError` it keeps the code, the raw message, the filtered metadata and the details, with the `ConnectError` as the cause. For another `Error` it uses the error's message and the given code, and for any other value its string. The conversion to a `ConnectError` becomes internal to the server, so no Connect type stays on the public API of `GrpcException`.

### Errors travel in the standard gRPC status

effect-grpc writes no wire format of its own. The server builds a `ConnectError` with the code, the message, the metadata and the details, and Connect encodes it:

| | gRPC | gRPC-web | Connect |
|---|---|---|---|
| Code and message | `grpc-status` and `grpc-message` trailers | the same, in the trailer frame of the response body | the JSON error body: `code`, `message` and the matching HTTP status |
| Details | `grpc-status-details-bin`, a `google.rpc.Status` whose details are `google.protobuf.Any` | the same, in the trailer frame | the JSON `details`: type name, base64 value and a `debug` JSON copy |
| Metadata | trailers | the trailer frame | response headers |

Because the status is the standard one, a gRPC client in any language reads it, and `buf curl` prints the details by type name.

Over gRPC, metadata and details are HTTP/2 trailers, and a status that is too large reaches the client as `INTERNAL` with nothing of its own. So the server caps what it adds to a status at 4 KiB: the message, the encoded details and the metadata, counted as HTTP/2 counts a header list, with 32 bytes for each entry on top of its name and value. Over the cap, the server drops the parts of least value first: the details that the method does not declare, then the metadata, then the declared detail. It cuts the message last, always keeps the code, and logs a warning that names what it dropped. The cap applies on all three protocols, so a status reads the same on each, and a proxy that turns gRPC-web or Connect into gRPC cannot break it. grpc-java's default limit for a header or trailer block that it receives is 8,192 bytes (`GrpcUtil.DEFAULT_MAX_HEADER_LIST_SIZE`, read in its source, not measured). The cap leaves half of that for the protocol's own keys and for proxies.

### Tags are `"GrpcException"` and a message's full name

- The tag of `GrpcException` changes from `"@dr_nikson/effect-grpc/grpcException/GrpcException"` to `"GrpcException"`. Effect 4 tags its own errors by name, such as `HttpClientError`, and a short tag works as a plain key in `Effect.catchTags`. 3.x code that matches the long tag stops compiling, so the change cannot pass unnoticed.
- The tag of a declared error is the full name of its protobuf message, such as `"acme.v1.UserNotFound"`. The type takes it from protobuf-es's literal `$typeName`, so nobody writes it twice. It cannot collide with a message of the same short name in another package. It is also the type name on the wire, so the client needs no mapping to find the declared error. The plugin refuses a message whose full name is `GrpcException`.

### What a client call fails with

| The call ends with | The client's failure |
|---|---|
| a status without a detail of a type that the method declares | `GrpcException`, with the metadata and every detail |
| a status whose first detail of a declared type decodes (P30) | that detail's declared error, with the same status fields |
| a status whose first detail of a declared type does not decode (P30) | `GrpcException`, with the detail kept raw |
| a detail of a type that the client does not know | `GrpcException`, with the detail kept raw |
| a transport failure, such as a closed port | `GrpcException` with Connect's code: `UNAVAILABLE` for a closed port |
| a deadline that passes | `GrpcException` with `DEADLINE_EXCEEDED` |
| an interruption of the calling fiber | the interruption, not a failure |

Every failure that is not a declared error is a `GrpcException`. So `Effect.catchTag("GrpcException", ...)` after the declared tags handles all of them. An interrupted caller asked to stop and has no failure to handle. The call's signal aborts, the server sees the stream canceled, and the fiber's `Exit` holds only the interruption.

### A method lists its errors in the `effect_grpc.v1.rpc` option

`options.proto` declares one message-valued extension of `google.protobuf.MethodOptions`. The full file is under [Usage](#usage). A method lists the full names of the messages it fails with:

```protobuf
option (effect_grpc.v1.rpc) = {errors: ["acme.v1.UserNotFound"]};
```

P30 implements these rules:

- Each entry is the full name of a protobuf message. The plugin resolves each name against the compiled files. It stops, naming the method and the entry, when a name does not resolve, names something other than a message, or repeats.
- A declared error is a value of the generic type `GrpcException.Declared<typeof UserNotFoundSchema>`, and a handler builds one with `GrpcException.declared`. The plugin generates no class for it, because a declared message can come from a file or a package that the plugin never generates, such as `google.rpc.BadRequest`.
- The error type of the method's handler is the union of `GrpcException` and its declared errors, so a handler that fails with anything else does not compile. The client method has the same error type.
- The server sends a declared error as its status, with the declared message as the first detail. The generated client maps each `GrpcException` with `GrpcException.refine`, which looks only at the first detail of a type that the method declares. If that detail decodes, the failure becomes its declared error, and if it does not, the failure stays a `GrpcException`, so a later detail never changes which catch runs. The union type and the list that `refine` gets come from the same resolved option, so they cannot disagree.
- A method without the option keeps `GrpcException` on both sides, as in P25.

One message holds all the options that effect-grpc reads from a method, so a later option needs no new extension number.

### `effect/protobuf` is not used

Effect 4.1.5 ships `effect/protobuf`, marked experimental. It builds descriptors from `FileDescriptorProto` values and encodes and decodes plain objects keyed by the proto field names, with its own representation of oneofs and 64-bit integers. Connect's transports, `ConnectError.details` and the messages that protoc-gen-es generates all use protobuf-es descriptors and values. The module would be a second protobuf runtime with a different value model, and it has no job in this design.

### The first release ships P25 without P24

| Unit | What it ships | Release |
|---|---|---|
| P25 (#12, #27) | `Effect.tryPromise` in place of `Effect.promise`, with `GrpcException.from` for each rejection. `GrpcException` in the error type of the client executor and of the generated client methods. A `protocol` option in the client config: `"grpc"` by default, `"grpc-web"` or `"connect"`. The tag `"GrpcException"`, the removal of `description` and `withDescription`, and the move of `toConnectError` out of the public API. | 4.0.0-alpha.0 |
| P24 (#77) | `metadata` and `details` in `GrpcException`, its constructor, `from` and the server's encoder. `findDetail`, the 4 KiB cap, and a `toJSON` that lists the details by type name. | a later 4.x release |
| P30 (#82) | `options.proto` in the npm package, the plugin's reading of the option, `Declared`, `declared`, `refine`, the generated error unions, and the server's encoding of a declared error. | after 4.0.0 |

P25 does not need P24. Code and message already reach every client, and they are all that `Effect.catchTag` and a check of the code need. P25 makes every breaking change to `GrpcException`, so P24 and P30 only add to the API of the alpha. P24 adds metadata and details to the server and the client in one unit, so no release has a field that the server cannot send. Until P24 lands, a client reaches a `ConnectError`'s metadata and details through `cause`. P25's acceptance lines that assert a description, metadata and a detail move to P24.

The main path also needs the client's `protocol` option. Today the client builds only a gRPC transport, so it cannot call a server over gRPC-web or Connect.

### Operator decisions

1. **The extension number.** Default: `options.proto` uses 50717 until the operator gets a number from the protobuf global extension registry, and P30 ships with it. Reason: only the operator can ask the registry, with a pull request or an issue on protocolbuffers/protobuf, and P30 comes after 4.0.0. descriptor.proto sets the range from 50000 to 99999 aside for one organization or for experiments, so a published library in that range can collide with a user's own option of the same number. One registry number covers the method option and any later option on another descriptor type, as protovalidate's 1159 does. A change of number changes no `.proto` file of a user, only regenerated code.
2. **How users import `options.proto`.** Default: the npm package ships `proto/effect_grpc/v1/options.proto`. A buf user lists the package's `proto` directory as a module in `buf.yaml`, as below, and `buf generate` writes `effect_grpc/v1/options_pb.ts` next to the user's code, where the user's generated files import it. A protoc user passes `-I node_modules/@dr_nikson/effect-grpc/proto`, which we did not measure because protoc is not installed here. Reason: this needs no account, no service and no network, and the `options.proto` that a user compiles always matches the plugin of the same package version. A later release can also publish the file to the Buf Schema Registry under the same import path.

```yaml
version: v2
modules:
  - path: proto
  - path: node_modules/@dr_nikson/effect-grpc/proto
```

## Usage

The docs check compiles these blocks with the generated code of the protos below (`pnpm run test:docs`). The API this record settles does not exist yet, so `src/grpcException.ts` writes it as declarations, and the examples import it from `./index.js` in place of `@dr_nikson/effect-grpc`.

```yaml
# buf.gen.yaml
version: v2
inputs:
  - directory: proto
plugins:
  - local: protoc-gen-es
    opt: target=ts,import_extension=js
    out: src/generated
  - local: protoc-gen-effect
    opt: target=ts,import_extension=js
    out: src/generated
```

```protobuf
// proto/effect_grpc/v1/options.proto
syntax = "proto3";

package effect_grpc.v1;

import "google/protobuf/descriptor.proto";

// The options that effect-grpc reads from a method.
message RpcOptions {
  // The full names of the messages that the method fails with, such as "acme.v1.UserNotFound".
  repeated string errors = 1;
}

extend google.protobuf.MethodOptions {
  // Provisional, until the protobuf global extension registry assigns a number.
  RpcOptions rpc = 50717;
}
```

```protobuf
// proto/acme/v1/users.proto
syntax = "proto3";

package acme.v1;

import "effect_grpc/v1/options.proto";

message GetUserRequest {
  string user_id = 1;
}

message CreateUserRequest {
  string name = 1;
}

message UserReply {
  string name = 1;
}

message UserNotFound {
  string user_id = 1;
}

message QuotaExceeded {
  uint32 limit = 1;
}

message InvalidField {
  string field = 1;
  string reason = 2;
}

service UserService {
  rpc GetUser(GetUserRequest) returns (UserReply) {
    option (effect_grpc.v1.rpc) = {errors: ["acme.v1.UserNotFound"]};
  }

  rpc CreateUser(CreateUserRequest) returns (UserReply) {
    option (effect_grpc.v1.rpc) = {errors: ["acme.v1.QuotaExceeded"]};
  }
}
```

```typescript
// src/grpcException.ts
import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { Any } from "@bufbuild/protobuf/wkt";
import type { Code } from "@connectrpc/connect";
import { Data, type Option, type Record } from "effect";
import type { YieldableError } from "effect/Cause";

export interface Status {
  readonly code: Code;
  readonly message: string;
  readonly metadata: Record.ReadonlyRecord<string, string>;
  readonly details: ReadonlyArray<Any>;
}

export interface Init {
  readonly code: Code;
  readonly message: string;
  readonly metadata?: Record.ReadonlyRecord<string, string>;
  readonly details?: ReadonlyArray<Any>;
  readonly cause?: unknown;
}

declare const normalize: (init: Init) => Status & { readonly cause?: unknown };

export class GrpcException extends Data.TaggedError("GrpcException")<
  Status & { readonly cause?: unknown }
> {
  constructor(init: Init) {
    super(normalize(init));
  }
}

export declare const create: (code: Code, message: string, cause?: unknown) => GrpcException;

export declare const from: (code: Code, cause: unknown) => GrpcException;

export declare const findDetail: <Desc extends DescMessage>(
  status: Status,
  schema: Desc,
) => Option.Option<MessageShape<Desc>>;

export type DeclaredError<Desc extends DescMessage> = YieldableError &
  Status & {
    readonly _tag: MessageShape<Desc>["$typeName"];
    readonly schema: Desc;
    readonly detail: MessageShape<Desc>;
  };

export type Declared<Desc extends DescMessage> = Desc extends DescMessage ? DeclaredError<Desc> : never;

export declare const declared: <Desc extends DescMessage>(
  code: Code,
  message: string,
  schema: Desc,
  detail: MessageInitShape<Desc>,
  options?: Omit<Init, "code" | "message">,
) => Declared<Desc>;

export declare const refine: <Desc extends DescMessage>(
  schemas: ReadonlyArray<Desc>,
) => (error: GrpcException) => GrpcException | Declared<Desc>;
```

```typescript
// src/index.ts
export * as GrpcException from "./grpcException.js";
```

From P25 on, a handler fails with a status as in 3.x, and the client catches it by tag:

```typescript
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { Effect } from "effect";

import type {
  GetUserRequest,
  GetUserRequestSchema,
  UserReply,
} from "./generated/acme/v1/users_pb.js";
import { GrpcException } from "./index.js";

export const getUser = (
  request: GetUserRequest,
): Effect.Effect<{ name: string }, GrpcException.GrpcException> =>
  request.userId === "" ?
    Effect.fail(GrpcException.create(Code.InvalidArgument, "user_id is required"))
  : Effect.fail(GrpcException.create(Code.NotFound, `no user ${request.userId}`));

declare const client: {
  getUser(
    request: MessageInitShape<typeof GetUserRequestSchema>,
    meta: object,
  ): Effect.Effect<UserReply, GrpcException.GrpcException>;
};

export const displayName = client.getUser({ userId: "u-1" }, {}).pipe(
  Effect.map((reply) => reply.name),
  Effect.catchTag("GrpcException", (error) =>
    error.code === Code.NotFound ? Effect.succeed("unknown user") : Effect.fail(error),
  ),
);
```

From P24 on, a status carries metadata and details, and the client reads each one as an `Option`:

```typescript
import { create } from "@bufbuild/protobuf";
import { anyPack } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import { Option, Record } from "effect";

import { InvalidFieldSchema } from "./generated/acme/v1/users_pb.js";
import { GrpcException } from "./index.js";

export const rejected = new GrpcException.GrpcException({
  code: Code.InvalidArgument,
  message: "user_id is required",
  metadata: { "x-request-id": "r-1" },
  details: [anyPack(InvalidFieldSchema, create(InvalidFieldSchema, { field: "user_id", reason: "empty" }))],
});

export const explain = (error: GrpcException.GrpcException) => ({
  requestId: Record.get(error.metadata, "x-request-id"),
  field: GrpcException.findDetail(error, InvalidFieldSchema).pipe(Option.map((invalid) => invalid.field)),
});
```

From P30 on, the generated types name the declared errors of each method. A handler of `GetUser` cannot fail with `QuotaExceeded`, which only `CreateUser` declares. Every failure still has the status fields, so one retry policy reads `code` from any of them:

```typescript
import { Code } from "@connectrpc/connect";
import { Effect, Schedule } from "effect";

import {
  type GetUserRequest,
  QuotaExceededSchema,
  type UserReply,
  UserNotFoundSchema,
} from "./generated/acme/v1/users_pb.js";
import { GrpcException } from "./index.js";

type GetUserFailure = GrpcException.GrpcException | GrpcException.Declared<typeof UserNotFoundSchema>;

type GetUserHandler = (request: GetUserRequest) => Effect.Effect<{ name: string }, GetUserFailure>;

export const getUser: GetUserHandler = (request) =>
  Effect.fail(GrpcException.declared(Code.NotFound, "no such user", UserNotFoundSchema, { userId: request.userId }));

export const undeclared: GetUserHandler = () =>
  // @ts-expect-error GetUser does not declare acme.v1.QuotaExceeded.
  Effect.fail(GrpcException.declared(Code.ResourceExhausted, "quota", QuotaExceededSchema, { limit: 3 }));

declare const call: Effect.Effect<UserReply, GrpcException.GrpcException>;

export const generatedGetUser: Effect.Effect<UserReply, GetUserFailure> = call.pipe(
  Effect.mapError(GrpcException.refine([UserNotFoundSchema])),
);

export const displayName = generatedGetUser.pipe(
  Effect.retry({ schedule: Schedule.recurs(2), while: (error) => error.code === Code.Unavailable }),
  Effect.map((reply) => reply.name),
  Effect.catchTags({
    "acme.v1.UserNotFound": (error) => Effect.succeed(`no user ${error.detail.userId}`),
    GrpcException: (error) => Effect.fail(error),
  }),
);
```

The plugin reads the option from the descriptors it receives, as `getOption` reads it here:

```typescript
import { getOption } from "@bufbuild/protobuf";

import { UserService } from "./generated/acme/v1/users_pb.js";
import { rpc } from "./generated/effect_grpc/v1/options_pb.js";

export const declaredErrors: ReadonlyArray<string> = getOption(UserService.method.getUser, rpc).errors;
```

## Alternatives considered

- **One `GrpcException` with the declared error as its `reason`.** Effect 4 handles `HttpClientError` this way, with `Effect.catchReason`. #82 asks for `Effect.catchTag` on a union of declared errors, `catchReason` needs both tags at every call, and the type parameter on `GrpcException` spreads through every signature that names it.
- **One generated class for each declared message.** A class gives `instanceof`, but the plugin would need a home for it, and a declared message from another package, such as `google.rpc.BadRequest`, has no generated `_effect.ts` to hold it. The generic `Declared` type works for any protobuf-es schema.
- **The long tag behind an exported constant.** It avoids one breaking change, but `Effect.catchTags` then needs computed keys, and every catch reads a constant in place of the name.
- **Declared errors that hold the status in a nested field.** A nested `status` keeps the status fields apart from the message's fields, which `detail` already does. Flat fields let one retry policy or log line read `code` from every failure of a method.
- **Fetch `Headers` for `metadata`.** It matches `RequestMeta.headers`, but it is mutable inside an error, and its `get` returns `null`, which every reader would wrap in an `Option`.
- **`withDescription` that appends to `message`.** It mirrors grpc-java's `augmentDescription`, but the same 3.x call would change meaning without a compile error. Its removal fails to compile instead.
- **A custom metadata key that carries typed errors as JSON.** Other gRPC clients cannot read it, it costs header bytes on gRPC, and the standard status already reaches every client.
- **Declaring errors by a naming convention, a runtime registry or a plugin parameter.** A `<Method>Error` convention is implicit and cannot share an error between methods. A registry in the client config gives no per-method types. A plugin parameter keeps the declaration outside the proto, where clients in other languages never see it.
- **Errors as `google.rpc.ErrorInfo` reasons (AIP-193).** A reason is a string with string metadata, so the client gets no typed payload. A server can still send `ErrorInfo` as a detail, and `findDetail` reads it.

## Consequences

- 4.x breaks 3.x code in these places: client code that recovers a defect from a failed call, code that matches the long tag, `description` with `withDescription`, and calls of the public `toConnectError`. Each one fails to compile, except the recovery of a defect, which P25's changeset names.
- A declared error whose message has a 64-bit field holds a `bigint`, which `JSON.stringify` rejects, so P30's `toJSON` renders the detail with protobuf-es's `toJson`.
- protoc-gen-effect writes an `_effect.ts` file for every proto file, `options.proto` among them. P23's message-only option or P30 skips files without services.
- `GrpcServerBindError` keeps its long tag. A follow-up can rename it to `"GrpcServerBindError"` under the same rule.
- The 4 KiB cap trades large details for a status that always arrives. A later builder option can raise it for a deployment whose clients and proxies accept more.
