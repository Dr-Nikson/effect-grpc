// packages/e2e-tests/src/example.test.ts
import { Effect } from "effect";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "example");

interface Program {
  readonly child: ChildProcessWithoutNullStreams;
  readonly output: () => string;
}

const start = (program: "server" | "client", port: string) =>
  Effect.acquireRelease(
    Effect.sync((): Program => {
      const child = spawn(process.execPath, [join("dist", `${program}.js`)], {
        cwd: exampleDir,
        env: { ...process.env, EFFECT_GRPC_EXAMPLE_PORT: port },
      });
      const chunks: Array<string> = [];
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => chunks.push(chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => chunks.push(chunk));
      return { child, output: () => chunks.join("") };
    }),
    ({ child }) => Effect.sync(() => child.kill("SIGKILL")),
  );

const outputMatching = ({ child, output }: Program, pattern: RegExp) =>
  Effect.callback<RegExpExecArray, Error>((resume) => {
    const check = () => {
      const match = pattern.exec(output());
      if (match !== null) resume(Effect.succeed(match));
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    child.once("close", (code) =>
      resume(Effect.fail(new Error(`exited with code ${code} before ${pattern}:\n${output()}`))),
    );
    check();
  }).pipe(Effect.timeout("20 seconds"));

const exitCode = ({ child }: Program) =>
  Effect.callback<number | null>((resume) => {
    child.once("close", (code) => resume(Effect.succeed(code)));
  }).pipe(Effect.timeout("20 seconds"));

describe("the example", () => {
  it.live("answers its client with a greeting and then the typed error, and stops on SIGTERM", () =>
    Effect.gen(function* () {
      const server = yield* start("server", "0");
      const [, port = ""] = yield* outputMatching(
        server,
        /gRPC server listening on http:\/\/127\.0\.0\.1:(\d+)/,
      );

      const client = yield* start("client", port);
      expect(yield* exitCode(client)).toBe(1);
      expect(client.output()).toContain(
        "Got some response from gRPC: Hey there! Your name is Meowucher, right?",
      );
      expect(client.output()).toContain("Face the consequences!");

      server.child.kill("SIGTERM");
      expect(yield* exitCode(server)).toBe(130);
      expect(server.output()).toContain("gRPC server stopped");
    }),
  );
});
