import { Context, Effect, Layer } from "effect";

import type { DescMessage, MessageInitShape, MessageShape } from "@bufbuild/protobuf";
import type { GenMessage, GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import { type ContextValues } from "@connectrpc/connect";

import * as internal from "./client.internal.js";

export type GrpcClientTypeId = typeof internal.grpcClientTypeId;

export interface GrpcClient {
  readonly Type: GrpcClientTypeId;
  // readonly _Tag: Types.Invariant<Tag>
  // readonly _Tag: Tag
  // readonly _Meta: Types.Contravariant<Meta>

  makeExecutor<Shape extends GenServiceMethods>(
    serviceDefinition: GenService<Shape>,
    methodNames: ReadonlyArray<keyof GenService<Shape>["method"]>,
  ): Executor<Shape>;
}
export const GrpcClient = Context.GenericTag<GrpcClient, GrpcClient>(
  "@tipizzato/effect-grpc/GrpcClient",
);

export const liveGrpcClientLayer: {
  (): Layer.Layer<GrpcClient>;
} = internal.liveGrpcClient;

export type RequestMeta = {
  contextValues?: ContextValues;
  headers?: Headers;
};

export type Executor<RuntimeShape extends GenServiceMethods> = {
  [P in keyof RuntimeShape]: RuntimeShape[P] extends (
    { methodKind: "unary"; input: GenMessage<infer In>; output: GenMessage<infer Out> }
  ) ?
    UnaryExecutorFn<GenMessage<In>, GenMessage<Out>>
  : "provided methodKind is not yet supported";
};

type UnaryExecutorFn<I extends DescMessage, O extends DescMessage> = (
  request: MessageInitShape<I>,
  meta?: RequestMeta,
) => Effect.Effect<MessageShape<O>>;
