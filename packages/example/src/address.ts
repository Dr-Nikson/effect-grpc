// packages/example/src/address.ts
import { Config } from "effect";

/**
 * The host the example server binds and the example client dials. It is an IP address rather than
 * `localhost`: Node can bind `localhost` to `::1` alone, while a client on an IPv4-only host dials
 * `127.0.0.1`.
 */
export const host = "127.0.0.1";

/** The port from `EFFECT_GRPC_EXAMPLE_PORT`, or 8000 when the variable is unset. */
export const port = Config.port("EFFECT_GRPC_EXAMPLE_PORT").pipe(Config.withDefault(8000));
