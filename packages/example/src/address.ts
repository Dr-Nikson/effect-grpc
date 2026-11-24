// packages/example/src/address.ts
import { Config } from "effect";

/**
 * An IP address rather than `localhost`, because Node can bind `localhost` to `::1` alone while a
 * client on an IPv4-only host dials `127.0.0.1`.
 */
export const host = Config.String("EFFECT_GRPC_EXAMPLE_HOST").pipe(Config.withDefault("127.0.0.1"));

/**
 * `Config.Port` rejects 0, which asks the OS for a free port.
 */
export const port = Config.Int("EFFECT_GRPC_EXAMPLE_PORT").pipe(Config.withDefault(8000));

export const baseUrl = Config.all([host, port]).pipe(
  Config.map(
    ([host, port]) => new URL(`http://${host.includes(":") ? `[${host}]` : host}:${port}`),
  ),
);
