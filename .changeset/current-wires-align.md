---
"@dr_nikson/effect-grpc": major
---

Move to Connect-RPC 2.3, protobuf-es 2.17 and buf 1.75 (#65)

**Breaking.** effect-grpc needs Node.js 22 or later, because `@connectrpc/connect-node` 2.3 does. The peer range of `@connectrpc/connect` is now `^2.3.0` (it was `^2.1.0`), and the peer range of `@bufbuild/protobuf` is now `^2.17.0` (it was `^2.8.0`). Use `@bufbuild/protoc-gen-es` 2.17 or later next to them. protoc-gen-es needs the `@bufbuild/protobuf` version that matches its own, so upgrade the two together and run `buf generate` again.

An app that installs other versions of these packages gets a second copy of each. `@connectrpc/connect-node` 2.3 pins its `@connectrpc/connect` peer to 2.3.0, and `@bufbuild/protoplugin` 2.17 pins its `@bufbuild/protobuf` dependency to 2.17.0.

What else changes for a user:

- A connection attempt that takes longer than 20 seconds now fails the call with `Code.Unavailable`. Set `connectTimeoutMs` in the `pingOptions` of the client config to change the limit.
- protobuf-es 2.12 and later parse input more strictly. A string field that holds invalid UTF-8 now fails a gRPC call with `Code.Internal`, where it decoded to replacement characters before. A JSON request with a duplicate key now fails with `Code.InvalidArgument`, where the last value won before. The parser also rejects an overlong binary tag and limits how deep a message can nest.
