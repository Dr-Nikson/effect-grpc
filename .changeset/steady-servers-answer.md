---
"@dr_nikson/effect-grpc": minor
---

Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB by default (#61)

One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

The server now rejects a request message larger than 4 MiB, the default of grpc-go and grpc-js, with `RESOURCE_EXHAUSTED`. The limit applies to each message of every method kind, also when the message is compressed and only its decompressed size is too large. Before, the server accepted messages of up to about 4 GiB. To set another limit, pass `readMaxBytes` in bytes to `build`, as in `.build({ readMaxBytes: 16 * 1024 * 1024 })`. `build` throws `Cause.IllegalArgumentException` for a value that is not a whole number from 1 to 4294967295.

Once the server has answered a request whose upload is still running, such as a refused message, it resets the rest of that request with `NO_ERROR`. The client stops sending, curl and buf curl finish such a call, and graceful shutdown no longer waits for a client that keeps its connection.

Known limitation: a Node client without the HTTP/2 fixes from nodejs/node#67113 and nodejs/node#67114 frees the unsent rest of a refused message once the server resets the stream, but keeps counting it against its session memory limit, Node's `maxSessionMemory` (10 MB by default). With connect-node 2.1.0 on Node 24.22.3, the gRPC and gRPC-web transports then fail the second refused 5 MiB message and every later call on that connection with `INTERNAL`, and the Connect transport fails from the eleventh. A new connection, for example through a new transport, is served, and the server's shutdown does not wait for such a client.
