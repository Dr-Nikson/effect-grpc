// packages/effect-grpc/src/protocGenPlugin.test.ts
import { Effect } from "effect";

import { describe, expect, it } from "@effect/vitest";

import * as namingTestProto from "./generated/com/example/v1/naming_test_service_effect.js";

describe("generated names (issue #30)", () => {
  it.effect("are usable for a service whose name already ends in Service", () =>
    Effect.sync(() => {
      expect(namingTestProto.NamingTestServiceTag).toBeDefined();
      expect(namingTestProto.NamingTestServiceClientTag).toBeDefined();
      expect(namingTestProto.namingTestServiceLiveLayer).toBeDefined();
      expect(namingTestProto.namingTestServiceClientLiveLayer).toBeDefined();
      expect(namingTestProto.NamingTestServiceConfigTag).toBeDefined();
      expect(namingTestProto.NamingTestServiceProtoId).toBe("com.example.v1.NamingTestService");
    }),
  );
});
