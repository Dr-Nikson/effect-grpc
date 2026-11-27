---
"@dr_nikson/effect-grpc": patch
---

Remove the server's debug output, answer HTTP/2 CONNECT requests with 405, and log HTTP/2 server errors through the Effect logger (#63)

The server no longer prints a line for every request, connection, session and stream. The server's own log lines are the ready line, the two stop lines and the server error line, and they go through the Effect logger.

An HTTP/2 CONNECT request now gets Node's 405 response. Before, a debug listener marked it as handled, so the request never got an answer and its stream stayed open.

An error that the HTTP/2 server emits after it starts listening, such as a failed accept of an incoming connection, is logged through the Effect logger as `gRPC server error`, and the process keeps running. A bind failure still fails `listen` with `GrpcServerBindError` and is not logged a second time. Before, the server also printed `Server error` with a stack trace to stderr, even when the caller handled the error.
