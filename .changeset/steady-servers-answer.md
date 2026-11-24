---
"@dr_nikson/effect-grpc": patch
---

Keep the server running when a request's authority cannot be parsed, serve Node clients that dial an IPv6 literal, and limit request messages to 4 MiB (#61)

One request could stop the server process. A request whose authority was not a valid URL authority threw inside the server's request listener, and Node's HTTP/2 client sends such an authority (`::1:8000`) when it dials `http://[::1]:8000`, as the generated client does. The server now reads an IPv6 address followed by a port without brackets as that address and port. It answers an authority that it still cannot parse with `INVALID_ARGUMENT`: gRPC clients get the status in an HTTP 200 response, and Connect clients get HTTP 400 with a JSON error body.

The server now rejects a request message larger than 4 MiB with `RESOURCE_EXHAUSTED`, also when the message is compressed and only its decompressed size is too large. Before, it accepted messages of up to about 4 GiB. This is the default of other gRPC implementations. Clients that send larger messages now get that error, and a setting to raise the limit is planned.
