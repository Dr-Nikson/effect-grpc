// packages/example/src/address.ts
import { Config } from "effect";

/**
 * An IP address rather than `localhost`, because Node can bind `localhost` to `::1` alone while a
 * client on an IPv4-only host dials `127.0.0.1`. Set `EFFECT_GRPC_EXAMPLE_HOST=::1` to serve IPv6.
 */
export const host = Config.string("EFFECT_GRPC_EXAMPLE_HOST").pipe(Config.withDefault("127.0.0.1"));

export const port = Config.port("EFFECT_GRPC_EXAMPLE_PORT").pipe(Config.withDefault(8000));

/**
 * The URL a client dials. A URL needs an IPv6 address in brackets.
 */
export const baseUrl = Config.all([host, port]).pipe(
  Config.map(
    ([host, port]) => new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`),
  ),
);
