---
"@dr_nikson/effect-grpc": major
---

Fail generated client calls with `GrpcException` instead of defects, and send a handler's JSON data to the client (#27, #12, #72)

**Breaking.** Each generated client method, and each method of `EffectGrpcClient.ClientExecutor`, now fails with `GrpcException`. Its type was `Effect.Effect<Response>`, and every failed call died with Connect's `ConnectError` as a defect. A status that the server sent, a transport failure such as a closed port (`Unavailable`) and a passed deadline (`DeadlineExceeded`) now reach the error channel, where `Effect.catch`, `Effect.catchTag`, `Effect.retry` and the other error operators see them. Code that recovered these defects with `Effect.catchDefect`, `Effect.sandbox` or `Cause.findDefect` stops seeing them. The exception's `cause` holds the `ConnectError`. An interrupted call still ends interrupted, not failed.

**Breaking.** Run `buf generate` again. Code that an earlier `protoc-gen-effect` generated types its calls as never failing, while the calls now fail with `GrpcException`.

`GrpcException` has a new field, `data`, an `Option` of JSON (`Schema.Json`). `GrpcException.withData(error, data)` sets it, and it also works in a pipe. The server sends the data as one `google.protobuf.Value` in the standard gRPC status details: in the `grpc-status-details-bin` trailer over gRPC and gRPC-web, and in the error body over Connect. `GrpcException.from` reads the data back from a `ConnectError`, so the generated client's failure carries the code, the message and the data. `buf curl` prints the data under `details[].debug` on all three protocols, and so does the JSON error body of a Connect call. `new GrpcException({...})` takes `data` as an optional field that defaults to `Option.none()`, so code that builds the class keeps compiling.

Known limitations:

- A reader gets the data as `JSON.stringify` writes it. `NaN` and `Infinity` arrive as `null`, and data that `JSON.stringify` refuses, such as a cycle, is not sent.
- Over gRPC the details travel in a trailer, so a status past HTTP/2's header limit fails the call with `INTERNAL`. In a test with Connect 2.3, 32 KiB of data passed and 63 KiB failed.
- The generated client still speaks gRPC only. A Connect client in Node on gRPC-web or Connect reads the same `GrpcException`, data included, with `GrpcException.from(Code.Unknown, error)`.
