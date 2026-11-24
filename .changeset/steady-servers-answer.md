---
"@dr_nikson/effect-grpc": patch
---

Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB (#61)

One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

The server now rejects a request message larger than 4 MiB, the default limit of other gRPC implementations, with `RESOURCE_EXHAUSTED`, on every method kind. This also applies when the message is compressed and only its decompressed size is too large. Before, the server accepted messages of up to about 4 GiB. A setting to raise the limit is planned.

After it refuses a message, the server reads the rest of the request and throws it away, and it holds the answer until the client has nothing more queued. For unary, server-streaming and client-streaming methods that is when the request ends. For bidi methods it is when the message in flight has arrived and nothing follows it. A Node client that keeps one connection open, such as the generated client, keeps working after the server refuses its oversized messages, over gRPC, gRPC-web and Connect. One case is not covered: a bidi client over gRPC whose request stream pauses between large messages can keep writing its next message into the refused call, and if the application starts another large upload right away, the two together can pass the 10 MB that Node's client allows on one connection.

The same hold changes when some answers arrive. On unary, server-streaming and client-streaming methods, an error decided before the whole request has been read, such as an unsupported content type, and an answer a client-streaming method returns before its request has ended now reach the client once the request has ended. A request with a malformed authority to a registered method waits in the same way as a refused one.
