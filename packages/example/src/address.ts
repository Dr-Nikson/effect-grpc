// packages/example/src/address.ts
import { Config } from "effect";

/**
 * An IP address rather than `localhost`, because Node can bind `localhost` to `::1` alone while a
 * client on an IPv4-only host dials `127.0.0.1`.
 */
export const host = "127.0.0.1";

/**
 * `Config.port` rejects 0, which asks the OS for a free port. The server reports a port it cannot bind.
 */
export const port = Config.integer("EFFECT_GRPC_EXAMPLE_PORT").pipe(Config.withDefault(8000));
