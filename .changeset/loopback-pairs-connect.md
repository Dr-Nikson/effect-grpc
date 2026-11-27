---
"@dr_nikson/effect-grpc": patch
---

Make the README server and client snippets connect on IPv4-only hosts (#60)

The snippets now bind and dial `127.0.0.1` instead of `localhost`. Node can bind `localhost` to `::1`, and a client on a host without a non-loopback IPv6 address dials `127.0.0.1` and gets `ECONNREFUSED`. The Quick Start server also provides `Layer.scope`, which `server.run` needs. Without it, the server stopped with `Service not found: effect/Scope` right after it started listening.
