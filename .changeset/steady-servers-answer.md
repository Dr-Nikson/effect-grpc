---
"@dr_nikson/effect-grpc": patch
---

Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB (#61)

One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

The server now rejects a request message larger than 4 MiB, the default limit of other gRPC implementations, with `RESOURCE_EXHAUSTED`, on every method kind. This also applies when the message is compressed and only its decompressed size is too large. Before, the server accepted messages of up to about 4 GiB. A setting to raise the limit is planned.

On unary and server-streaming methods, which covers every method that generated code serves, the server reads the rest of a refused request and throws it away, and it answers only after the client has sent the whole request. A Node client that keeps one connection open, such as the generated client, keeps working after the server refuses its oversized messages to these methods, over gRPC, gRPC-web and Connect. An error that the server decides before it reads the request, such as an unsupported content type or a malformed authority, also reaches the client of these methods only once the request has ended.

Client-streaming and bidi methods, which only hand-written handlers serve because the generated code covers unary methods only, get the limit without that protection. The server answers a refused message at once and stops reading the request, and a Node client counts the unsent rest of that message against its connection's memory for as long as the connection lives. Once those refused messages add up to about 10 MB on one connection, the call that passes that mark and every later call on that connection fail with `INTERNAL`, until the application creates a new client. Before this change, the server accepted those messages.
