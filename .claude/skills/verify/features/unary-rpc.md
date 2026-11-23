# Unary RPC

A client calls a unary method and gets the handler's response, over both the gRPC protocol and the Connect protocol. The handler's run is visible in the server log.

## Sub-features

- `rpc-grpc` returns the greeting for `GetGreeting` over gRPC (HTTP/2, binary protobuf).
- `rpc-connect` returns HTTP 200 with the greeting for `GetGreeting` over Connect JSON.
- `rpc-handler` runs the Effect handler once per call. The server logs `getGreeting called, this is really cool!` with `method: com.example.v1.HelloWorldAPI/GetGreeting`.
- `rpc-payload` delivers request fields to the handler, so the greeting repeats `name`.

## How to get to it (user POV)

- From any gRPC client: `buf curl --protocol grpc --http2-prior-knowledge --schema packages/example/proto -d '{"name":"Ada"}' http://localhost:8000/com.example.v1.HelloWorldAPI/GetGreeting`.
- From any Connect client: `curl --http2-prior-knowledge -H 'content-type: application/json' --data '{"name":"Ada"}' http://localhost:8000/com.example.v1.HelloWorldAPI/GetGreeting`.
- From the generated Effect client: see [effect-client.md](./effect-client.md).

## Driving it with control-example

Preconditions:

- `$C launch` is running, and `$C doctor` reports no FAIL.

- **gRPC call.** Run `$C call grpc GetGreeting '{"name":"Ada"}'`. The result is `exit_code=0` with the response `{"greeting": "Hey there! Your name is Ada, right?"}`. The server-log section of the same file has exactly one `getGreeting called` line.
- **Connect call.** Run `$C call connect GetGreeting '{"name":"Ada"}'`. The result is `http_status=200`, the body `{"greeting":"Hey there! Your name is Ada, right?"}`, and one `getGreeting called` line in the server-log section.
- **Empty request.** Run `$C call connect GetGreeting '{}'`. The result is `http_status=200` with the greeting `Hey there! Your name is , right?`, because proto3 sends the default empty string.
- **Proof.** Cite the `NN-grpc-GetGreeting.txt` and `NN-connect-GetGreeting.txt` evidence files. Each holds the command, the response, and the handler log line from that call.

## Gotchas

- `curl` needs `--http2-prior-knowledge`. Without it, the server rejects the request as HTTP/1.1 (see `srv-h2c` in [server-lifecycle.md](./server-lifecycle.md)).
- `buf curl` needs `--schema packages/example/proto`, because the server has no reflection.
- The server log annotates every call with `protocol: gRPC`, Connect calls included. Do not use that annotation to tell the protocols apart.
- `$C launch` makes one `GetGreeting` call itself, named `readiness-probe`. Count handler lines in each evidence file's server-log section, not in the whole `server.log`.
