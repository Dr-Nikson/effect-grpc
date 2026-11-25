# Fixture: a service with one rpc of each kind

The generator supports unary rpcs only. This fixture records what it generates for a service that
also has streaming rpcs.

```protobuf
// proto/example/v1/chat.proto
syntax = "proto3";

package example.v1;

service ChatService {
  rpc Send(ChatMessage) returns (ChatReceipt);
  rpc Watch(ChatMessage) returns (stream ChatReceipt);
  rpc Upload(stream ChatMessage) returns (ChatReceipt);
  rpc Talk(stream ChatMessage) returns (stream ChatReceipt);
}

message ChatMessage {
  string text = 1;
}

message ChatReceipt {
  string id = 1;
}
```

```yaml
# buf.gen.yaml
version: v2
inputs:
  - directory: proto
plugins:
  - local: protoc-gen-es
    opt: target=ts,import_extension=js
    out: src/generated
  - local: protoc-gen-effect
    opt: target=ts,import_extension=js
    out: src/generated
```

```typescript
import { Effect, Layer } from "effect";
import { EffectGrpcClient } from "@dr_nikson/effect-grpc";

import * as effectProto from "./generated/example/v1/chat_effect.js";

const service: effectProto.ChatService = {
  send: (request) => Effect.succeed({ id: request.text }),
};

export const serviceLayer = effectProto.chatServiceLiveLayer(effectProto.ChatServiceTag, service);

export const clientLayer = effectProto.chatServiceClientLiveLayer(effectProto.ChatServiceClientTag).pipe(
  Layer.provide(
    Layer.succeed(
      effectProto.ChatServiceConfigTag,
      EffectGrpcClient.GrpcClientConfig({ baseUrl: new URL("http://127.0.0.1:8000") }),
    ),
  ),
  Layer.provide(EffectGrpcClient.liveGrpcClientRuntimeLayer()),
);

export const call = Effect.gen(function* () {
  const client = yield* effectProto.ChatServiceClientTag;
  return yield* client.send({ text: "hello" }, {});
});
```
