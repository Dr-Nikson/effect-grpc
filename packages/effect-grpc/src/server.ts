// packages/effect-grpc/src/server.ts
import { Effect, Scope, Types } from "effect";

import type { GenService, GenServiceMethods } from "@bufbuild/protobuf/codegenv2";
import { HandlerContext, ServiceImpl } from "@connectrpc/connect";

import * as ProtoRuntime from "./protoRuntime.js";
import * as internal from "./server.internal.js";

/**
 * Represents a gRPC server that can run multiple services within an Effect environment.
 * The server manages the lifecycle and execution of registered gRPC services.
 *
 * @template Services - Union type of all service tags registered with this server
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 *
 * // Create a server with multiple services
 * const server = EffectGrpcServer.GrpcServerBuilder()
 *   .withService(userService)
 *   .withService(productService)
 *   .build()
 *
 * // Run the server within an Effect program
 * const program = Effect.gen(function* () {
 *   yield* server.run()
 *   // Server is now running and handling gRPC requests
 * })
 *
 * // Execute with proper resource management
 * Effect.runPromise(Effect.scoped(program))
 * ```
 */
export interface GrpcServer<in Services> {
  readonly _Services: Types.Contravariant<Services>;

  run(): Effect.Effect<never, never, Scope.Scope>;
}

/**
 * Utility type that concatenates service tags when adding a new service to an existing collection.
 * If Services is never (empty collection), returns just the new Tag.
 * Otherwise, returns a union of the new Tag and existing Services.
 *
 * @example
 * ```typescript
 * // Adding first service to empty collection
 * type FirstService = ConcatServiceTags<GrpcService<"UserService", UserProto, any>, never>
 * // Result: "UserService"
 *
 * // Adding second service to existing collection
 * type SecondService = ConcatServiceTags<GrpcService<"ProductService", ProductProto, any>, "UserService">
 * // Result: "UserService" | "ProductService"
 *
 * // Adding third service
 * type ThirdService = ConcatServiceTags<GrpcService<"OrderService", OrderProto, any>, "UserService" | "ProductService">
 * // Result: "UserService" | "ProductService" | "OrderService"
 * ```
 */
export type ConcatServiceTags<S extends GrpcService<any, any, any>, Services> =
  S extends GrpcService<infer Tag, any, any> ?
    [Services] extends [never] ?
      Tag
    : Tag | Services
  : never; // This should never be the case

/**
 * Utility type that ensures service tags are unique when adding to a collection.
 * If Services is never (empty collection), allows any service S.
 * If the service's Tag already exists in Services, returns never to prevent duplicates.
 * Otherwise, returns the service S to allow it to be added.
 *
 * @example
 * ```typescript
 * // Adding first service - always allowed
 * type FirstService = UniqueTag<GrpcService<"UserService", UserProto, any>, never>
 * // Result: GrpcService<"UserService", UserProto, any>
 *
 * // Adding unique service - allowed
 * type SecondService = UniqueTag<GrpcService<"ProductService", ProductProto, any>, "UserService">
 * // Result: GrpcService<"ProductService", ProductProto, any>
 *
 * // Adding duplicate service - blocked
 * type DuplicateService = UniqueTag<GrpcService<"UserService", AnotherProto, any>, "UserService" | "ProductService">
 * // Result: never (prevents duplicate tags)
 * ```
 */
export type UniqueTag<S extends GrpcService<any, any, any>, Services> =
  S extends GrpcService<infer Tag, any, any> ?
    [Services] extends [never] ?
      S // If Services === never => we allow S with any Tag
    : Tag extends Services ? never
    : S // We do not allow S with Tag which is already present in Services
  : never; // This should never be the case

/**
 * Builder interface for constructing gRPC servers with type-safe service registration.
 * Provides a fluent API for configuring context transformation and adding services.
 *
 * @template Ctx - The context type that will be provided to service handlers
 * @template Services - Union type of all registered service tags
 *
 * @example
 * ```typescript
 * import { Effect } from "effect"
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 *
 * // Create a server with custom context transformation
 * const server = EffectGrpcServer.GrpcServerBuilder()
 *   .withContextTransformer((handlerCtx) =>
 *     Effect.succeed({
 *       userId: handlerCtx.requestHeader.get("user-id"),
 *       timestamp: Date.now()
 *     })
 *   )
 *   .withService(userService)
 *   .withService(productService)
 *   .build()
 *
 * // Or with default HandlerContext
 * const simpleServer = EffectGrpcServer.GrpcServerBuilder()
 *   .withService(userService)
 *   .build()
 * ```
 */
export interface GrpcServerBuilder<Ctx, Services> {
  readonly transformCtx: (ctx: HandlerContext) => Effect.Effect<Ctx>;
  readonly services: Record<string & Services, GrpcService<any, any, Ctx>>;

  withContextTransformer<This extends GrpcServerBuilder<Ctx, Services>, Ctx1>(
    this: [Services] extends [never] ? This : never,
    f: (ctx: Ctx) => Effect.Effect<Ctx1>,
  ): GrpcServerBuilder<Ctx1, never>;

  withService<S extends GrpcService<any, any, Ctx>>(
    service: UniqueTag<S, Services>,
  ): GrpcServerBuilder<Ctx, ConcatServiceTags<S, Services>>;

  build<This extends GrpcServerBuilder<Ctx, Services>>(
    this: [Services] extends [never] ? never : This,
  ): GrpcServer<Services>;
}

/**
 * Creates a new GrpcServerBuilder instance with default HandlerContext.
 * This is the entry point for building a gRPC server.
 *
 * @example
 * ```typescript
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 *
 * // Create a new server builder
 * const builder = EffectGrpcServer.GrpcServerBuilder()
 *
 * // Chain methods to configure the server
 * const server = builder
 *   .withService(myService)
 *   .build()
 * ```
 */
export const GrpcServerBuilder: {
  (): GrpcServerBuilder<HandlerContext, never>;
} = () => internal.ConnectEsGprcServerBuilder.empty;

export type GrpcServiceTypeId = typeof internal.grpcServiceTypeId;

/**
 * Represents a gRPC service with a specific tag, Protocol Buffer definition, and context type.
 * This interface binds together the service definition and its implementation.
 *
 * Note: GrpcService instances are typically created by the protoc-gen-effect code generator
 * when processing .proto files, rather than being manually constructed.
 *
 * @template Tag - A unique identifier for this service (typically a string literal)
 * @template Proto - The Protocol Buffer service definition generated from .proto files
 * @template Ctx - The context type available to service method handlers
 *
 * @example
 * ```typescript
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 * import { UserService } from "./gen/user_pb" // Generated by protoc-gen-effect
 *
 * // Define a service with custom context
 * interface AppContext {
 *   userId: string
 *   db: Database
 * }
 *
 * // Service definition generated by code generator
 * const userService: EffectGrpcServer.GrpcService<"UserService", typeof UserService, AppContext> =
 *   EffectGrpcServer.GrpcService("UserService", UserService)((exec) => ({
 *     getUser: (req) => exec.unary(req, ctx, (req, appCtx) =>
 *       Effect.gen(function* () {
 *         const user = yield* findUser(appCtx.db, req.userId)
 *         return { user }
 *       })
 *     )
 *   }))
 * ```
 */
export interface GrpcService<Tag, Proto extends GenService<any>, Ctx> {
  readonly Type: GrpcServiceTypeId;
  readonly _Tag: Tag;
  readonly _Ctx: Types.Invariant<Ctx>;

  readonly definition: Proto;

  implementation(executor: ProtoRuntime.ServerExecutor<Ctx>): ServiceImpl<Proto>;
}

/**
 * Creates a new GrpcService instance with the specified tag and Protocol Buffer definition.
 * This is typically used by code generators rather than being called manually.
 *
 * @template Tag - The service tag identifier
 * @template Proto - The Protocol Buffer service definition
 * @template RuntimeShape - The runtime shape of the service methods
 *
 * @param tag - Unique identifier for this service
 * @param definition - Protocol Buffer service definition
 * @returns A function that takes an implementation and returns a GrpcService
 *
 * @example
 * ```typescript
 * import { EffectGrpcServer } from "@dr_nikson/effect-grpc"
 * import { UserService } from "./gen/user_pb"
 *
 * // Create a service (typically done by code generator)
 * const createUserService = EffectGrpcServer.GrpcService("UserService", UserService)
 *
 * // Provide implementation
 * const userService = createUserService<AppContext>((exec) => ({
 *   getUser: (req) => exec.unary(req, ctx, (req, appCtx) =>
 *     Effect.succeed({ user: { id: req.userId, name: "John" } })
 *   )
 * }))
 * ```
 */
export const GrpcService: {
  <Tag, Proto extends GenService<RuntimeShape>, RuntimeShape extends GenServiceMethods>(
    tag: Tag,
    definition: Proto,
  ): <Ctx>(
    implementation: (exec: ProtoRuntime.ServerExecutor<Ctx>) => ServiceImpl<Proto>,
  ) => GrpcService<Tag, Proto, Ctx>;
} = internal.makeGrpcService;
