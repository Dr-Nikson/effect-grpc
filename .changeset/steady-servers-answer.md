---
"@dr_nikson/effect-grpc": minor
---

Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB by default (#61)

One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

The server now rejects a request message larger than 4 MiB, the default of grpc-go and grpc-js, with `RESOURCE_EXHAUSTED`. The limit applies to each message of every method kind, also when the message is compressed and only its decompressed size is too large. Before, the server accepted messages of up to about 4 GiB. To set another limit, pass `readMaxBytes` in bytes to `build`, as in `.build({ readMaxBytes: 16 * 1024 * 1024 })`.

Known limitation: a Node client without the HTTP/2 fixes from nodejs/node#67113 and nodejs/node#67114 can no longer use its connection after about 10 MB of refused uploads. The server stops reading a message it refuses, and the client keeps the unsent rest queued on its connection. Once that passes the client's session memory limit, Node's `maxSessionMemory` (10 MB by default), the call and every later call on that connection fail with `INTERNAL`, until the application opens a new connection, for example through a new transport.
