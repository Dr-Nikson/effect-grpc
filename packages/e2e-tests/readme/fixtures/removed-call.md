# Fixture: a README that calls the removed typed-tag shape

```protobuf
// proto/example/v1/hello.proto
syntax = "proto3";

package example.v1;

service HelloService {
  rpc SayHello(HelloRequest) returns (HelloResponse);
}

message HelloRequest {
  string name = 1;
}

message HelloResponse {
  string message = 1;
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
import * as effectProto from "./generated/example/v1/hello_effect.js";

const AuthClientTag = effectProto.HelloServiceClientTag<{ token: string }>("AuthMeta");
```
