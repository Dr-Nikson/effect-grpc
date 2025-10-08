import { Effect } from "effect";

import type { DescMethod, MessageInitShape } from "@bufbuild/protobuf";
import type { GenMessage, GenService } from "@bufbuild/protobuf/codegenv2";

export type ExtractMessageType<T extends GenMessage<any>> =
  T extends GenMessage<infer A> ? A : never;

export type ServiceServerMethodDefinition<
  T extends Pick<DescMethod, "input" | "output" | "methodKind">,
  Ctx,
> =
  T extends { methodKind: "unary"; input: GenMessage<infer In>; output: GenMessage<infer Out> } ?
    (request: In, ctx: Ctx) => Effect.Effect<MessageInitShape<GenMessage<Out>>>
  : "provided methodKind is not supported, expected value: 'unary'";

export type ExtractServiceServerMethods<T extends GenService<any>, Ctx> =
  T extends GenService<infer RuntimeShape> ?
    { [K in keyof RuntimeShape]: ServiceServerMethodDefinition<RuntimeShape[K], Ctx> }
  : "first step";

export type ServiceClientMethodDefinition<
  T extends Pick<DescMethod, "input" | "output" | "methodKind">,
  Meta,
> =
  T extends { methodKind: "unary"; input: GenMessage<infer In>; output: GenMessage<infer Out> } ?
    (request: MessageInitShape<GenMessage<In>>, ctx: Meta) => Effect.Effect<Out>
  : "provided methodKind is not supported, expected value: 'unary'";

export type ExtractServiceClientMethods<T extends GenService<any>, Meta> =
  T extends GenService<infer RuntimeShape> ?
    { [K in keyof RuntimeShape]: ServiceClientMethodDefinition<RuntimeShape[K], Meta> }
  : "first step";
