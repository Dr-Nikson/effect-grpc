import type { DescMethod, DescService } from "@bufbuild/protobuf";
import type { GeneratedFile, Schema } from "@bufbuild/protoplugin";
import { createEcmaScriptPlugin, safeIdentifier } from "@bufbuild/protoplugin";

import packageJson from "../package.json" with { type: "json" };

export const protocGenEffectGrpc = createEcmaScriptPlugin({
  name: "protoc-gen-effect-grpc",
  version: `v${String(packageJson.version)}`,
  generateTs,
});

function generateTs(schema: Schema<object>): void {
  for (const file of schema.files) {
    const f = schema.generateFile(file.name + "_effect.ts");
    f.preamble(file);

    const effectImports = {
      Context: safeIdentifier("Context"),
      Effect: safeIdentifier("Effect"),
      Layer: safeIdentifier("Layer"),
    };
    f.print("import * as ", effectImports.Context, ' from "effect/Context";');
    f.print("import * as ", effectImports.Effect, ' from "effect/Effect";');
    f.print("import * as ", effectImports.Layer, ' from "effect/Layer";');
    f.print();

    const fileBasename = file.name.split("/").pop() || file.name;
    file.services.forEach((service) =>
      generateEffectService(f, service, fileBasename, effectImports),
    );
  }
}

interface EffectImports {
  Context: string;
  Effect: string;
  Layer: string;
}

/**
 * Appends a suffix to a name only if the name doesn't already end with that suffix.
 * This prevents names like "HelloWorldServiceService" when the proto service
 * is already named "HelloWorldService".
 */
function appendSuffixIfNeeded(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : name + suffix;
}

function generateEffectService(
  f: GeneratedFile,
  service: DescService,
  fileBasename: string,
  effectImports: EffectImports,
): void {
  const { Context: importContext, Effect: importEffect, Layer: importLayer } = effectImports;
  const importEffectGrpcService = f.import("EffectGrpcServer", packageJson.name);
  const importGrpcException = f.import("GrpcException", packageJson.name);

  const importService = f.importSchema(service);

  const serviceName = appendSuffixIfNeeded(service.name, "Service");
  const serviceNameLower = serviceName.charAt(0).toLowerCase() + serviceName.slice(1);

  const serviceId = service.typeName;
  const serviceIdSymbol = safeIdentifier(service.name + "ProtoId");
  const serviceSymbol = safeIdentifier(serviceName);
  const grpcServiceSymbol = safeIdentifier(serviceName.replace(/Service$/, "") + "GrpcService");
  const serviceTagSymbol = safeIdentifier(serviceName + "Tag");
  const serviceLiveLayerSymbol = safeIdentifier(serviceNameLower + "LiveLayer");
  const makeTagSymbol = safeIdentifier("make" + serviceName + "Tag");
  const makeLiveLayerSymbol = safeIdentifier("make" + serviceName + "LiveLayer");
  const providedType = 'Tag["Identifier"]';

  f.print("/**");
  f.print(" * Unique identifier for the ", service.name, " gRPC service.");
  f.print(" *");
  f.print(
    " * This constant represents the fully qualified service name from the Protocol Buffer definition.",
  );
  f.print(" * It's used to identify and wire gRPC dependencies.");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("const", serviceIdSymbol), " = ", f.string(serviceId), " as const;");
  f.print(f.export("type", serviceIdSymbol), " = typeof ", serviceIdSymbol, ";");
  f.print();

  f.print("/**");
  f.print(" * gRPC service interface.");
  f.print(" *");
  f.print(" * @typeParam Ctx - The type of context passed to service methods. Use this to inject");
  f.print(
    " *                  dependencies or pass request-scoped data (e.g., authentication info)",
  );
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * // Simple implementation with default context");
  f.print(" * const service: effectProto.", serviceSymbol, " = {");
  if (service.methods.length > 0 && service.methods[0] !== undefined) {
    const firstMethod = service.methods[0];
    f.print(" *   ", firstMethod.localName, ": (request) =>");
    f.print(" *     Effect.succeed({})");
  }
  f.print(" * };");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("interface", serviceSymbol), "<Ctx = any> {");

  service.methods.forEach(generateServerMethod);

  f.print("}");
  f.print();

  f.print("/**");
  f.print(" * Creates a Layer that provides a gRPC service implementation.");
  f.print(" *");
  f.print(" * This function takes your service implementation and wraps it in a Layer that can be");
  f.print(" * composed with other layers to build your application. The returned function accepts");
  f.print(" * a tag to identify the service in the Effect context.");
  f.print(" *");
  f.print(" * @typeParam Ctx - The context type used by your service implementation");
  f.print(" *");
  f.print(" * @param tag - Context tag to identify the service");
  f.print(" * @param service - Your implementation of the ", serviceSymbol, " interface");
  f.print(" * @returns A Layer providing the gRPC service");
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as Layer from "effect/Layer";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * // Define your service implementation");
  f.print(" * const myService: effectProto.", serviceSymbol, " = {");
  if (service.methods.length > 0 && service.methods[0] !== undefined) {
    const firstMethod = service.methods[0];
    f.print(" *   ", firstMethod.localName, ": (request) =>");
    f.print(" *     Effect.succeed({})");
  }
  f.print(" * };");
  f.print(" *");
  f.print(" * // Create the service layer");
  f.print(
    " * const ServiceLayer = effectProto.",
    serviceLiveLayerSymbol,
    "(effectProto.",
    serviceTagSymbol,
    ", myService);",
  );
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("const", serviceLiveLayerSymbol), ": {");
  f.print("  <Tag extends ", serviceTagSymbol, "<Ctx>, Ctx>(");
  f.print("    tag: Tag,");
  f.print("    service: ", serviceSymbol, "<Ctx>,");
  f.print("  ): ", importLayer, ".Layer<", providedType, ">;");
  f.print("} = ", makeLiveLayerSymbol, ";");

  f.print();

  f.print("/**");
  f.print(" * Type alias for the wrapped gRPC service.");
  f.print(" *");
  f.print(" * This represents the Effect-wrapped version of your service implementation,");
  f.print(" * ready to be registered with a gRPC server.");
  f.print(" *");
  f.print(" * @typeParam Ctx - The context type used by the service");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("type", grpcServiceSymbol),
    "<Ctx = any>",
    " = ",
    importEffectGrpcService,
    ".GrpcService<",
    serviceIdSymbol,
    ", typeof ",
    importService,
    ", Ctx>",
  );
  f.print();

  f.print("/**");
  f.print(" * Type alias for the service tag.");
  f.print(" *");
  f.print(" * Used to identify and retrieve the service from the Effect context.");
  f.print(" *");
  f.print(" * @typeParam Ctx - The context type used by the service");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("type", serviceTagSymbol),
    "<Ctx = any>",
    " = ",
    importContext,
    ".Service<",
    grpcServiceSymbol,
    "<Ctx>, ",
    grpcServiceSymbol,
    "<Ctx>>",
  );
  f.print();

  f.print("/**");
  f.print(
    " * The default Context tag of the ",
    service.name,
    " service, for an implementation that does not read `ctx`.",
  );
  f.print(" * Its key is `", service.typeName, "/Service`.");
  f.print(" *");
  f.print(
    " * For an implementation that reads a typed `ctx`, make a tag with {@link ",
    makeTagSymbol,
    "}.",
  );
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * declare const service: effectProto.", serviceSymbol, ";");
  f.print(" *");
  f.print(
    " * const ServiceLayer = effectProto.",
    serviceLiveLayerSymbol,
    "(effectProto.",
    serviceTagSymbol,
    ", service);",
  );
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("const", serviceTagSymbol),
    ": ",
    serviceTagSymbol,
    " = ",
    importContext,
    ".Service<",
    grpcServiceSymbol,
    ">(`${",
    serviceIdSymbol,
    "}/Service`);",
  );

  f.print();

  f.print("/**");
  f.print(
    " * Makes a Context tag for a ",
    service.name,
    " service implementation that reads a typed `ctx`.",
  );
  f.print(" *");
  f.print(
    " * The tag's key is `",
    service.typeName,
    "/Service<key>`, so it never equals the default tag's key.",
  );
  f.print(" * The key is the tag's identity: tags made with the same key share one Context slot,");
  f.print(
    " * whatever their type argument. Name the key after the context type. A server that serves",
  );
  f.print(" * the service needs a context transformer that produces `Ctx`.");
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import type { HandlerContext } from "@connectrpc/connect";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * declare const service: effectProto.", serviceSymbol, "<HandlerContext>;");
  f.print(" *");
  f.print(
    " * const HandlerContextTag = effectProto.",
    makeTagSymbol,
    '<HandlerContext>("HandlerContext");',
  );
  f.print(
    " * const ServiceLayer = effectProto.",
    serviceLiveLayerSymbol,
    "(HandlerContextTag, service);",
  );
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("function", makeTagSymbol), "<Ctx>(key: string): ", serviceTagSymbol, "<Ctx> {");
  f.print(
    "  return ",
    importContext,
    ".Service<",
    grpcServiceSymbol,
    "<Ctx>>(`${",
    serviceIdSymbol,
    "}/Service<${key}>`);",
  );
  f.print("}");

  f.print();
  f.print("function ", makeLiveLayerSymbol, "<Tag extends ", serviceTagSymbol, "<Ctx>, Ctx>(");
  f.print("  tag: Tag,");
  f.print("  service: ", serviceSymbol, "<Ctx>,");
  f.print("): ", importLayer, ".Layer<", providedType, "> {");
  f.print(
    "  const instance: ",
    grpcServiceSymbol,
    "<Ctx> = ",
    importEffectGrpcService,
    ".GrpcService(",
  );
  f.print("    ", serviceIdSymbol, ",");
  f.print("    ", importService, ",");
  f.print("  )((executor) => ({");

  service.methods.forEach((method) => {
    if (method.methodKind === "unary") {
      f.print("    ", method.localName, ": (req, ctx) =>");
      f.print(
        "      executor.unary(`${",
        serviceIdSymbol,
        "}/",
        method.name,
        "`, req, ctx, (req, ctx) => service.",
        method.localName,
        "(req, ctx)),",
      );
    }
  });

  f.print("  }));");
  f.print();
  f.print("  return ", importLayer, ".succeed(tag, instance);");
  f.print("}");

  f.print();

  const clientName = appendSuffixIfNeeded(service.name, "Client");
  const clientNameLower = clientName.charAt(0).toLowerCase() + clientName.slice(1);

  const clientSymbol = safeIdentifier(clientName);
  const importEffectGrpcClient = f.import("EffectGrpcClient", packageJson.name);
  const clientTagSymbol = safeIdentifier(clientName + "Tag");
  const clientLiveLayerSymbol = safeIdentifier(clientNameLower + "LiveLayer");
  const configTagSymbol = safeIdentifier(service.name + "ConfigTag");
  const makeClientTagSymbol = safeIdentifier("make" + clientName + "Tag");
  const makeClientLiveLayerSymbol = safeIdentifier("make" + clientName + "LiveLayer");

  f.print("/**");
  f.print(" * Client interface for making gRPC calls to ", service.name, " service.");
  f.print(" *");
  f.print(" * This interface defines the client-side methods for calling the gRPC service.");
  f.print(" * Each method accepts a request message and metadata, and returns an Effect that");
  f.print(" * produces the response or fails with an error.");
  f.print(" *");
  f.print(" * @typeParam Meta - The type of metadata to pass with each request. This can be used");
  f.print(
    " *                   for authentication tokens, tracing headers, or other per-request data.",
  );
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * // Use the client in an Effect");
  f.print(" * const program = Effect.gen(function* () {");
  f.print(" *   const client = yield* effectProto.", clientTagSymbol, ";");
  if (service.methods.length > 0 && service.methods[0] !== undefined) {
    const firstMethod = service.methods[0];
    f.print(" *   const response = yield* client.", firstMethod.localName, "({}, {});");
    f.print(" *   return response;");
  }
  f.print(" * });");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("interface", clientSymbol), "<Meta> {");

  service.methods.forEach(generateClientMethod);

  f.print("}");
  f.print();

  f.print("/**");
  f.print(" * Type alias for the client tag.");
  f.print(" *");
  f.print(" * Used to identify and retrieve the client from the Effect context.");
  f.print(" *");
  f.print(" * @typeParam Meta - The metadata type used by the client");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("type", clientTagSymbol),
    "<Meta = any>",
    " = ",
    importContext,
    ".Service<",
    clientSymbol,
    "<Meta>, ",
    clientSymbol,
    "<Meta>>",
  );
  f.print();

  f.print("/**");
  f.print(
    " * The default Context tag of the ",
    service.name,
    " client. Its key is `",
    service.typeName,
    "/Client`.",
  );
  f.print(" *");
  f.print(
    " * For a client with typed metadata, make a tag with {@link ",
    makeClientTagSymbol,
    "}.",
  );
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(
    " * const ClientLayer = effectProto.",
    clientLiveLayerSymbol,
    "(effectProto.",
    clientTagSymbol,
    ");",
  );
  f.print(" *");
  f.print(" * const program = Effect.gen(function* () {");
  f.print(" *   const client = yield* effectProto.", clientTagSymbol, ";");
  if (service.methods.length > 0 && service.methods[0] !== undefined) {
    const firstMethod = service.methods[0];
    f.print(" *   return yield* client.", firstMethod.localName, "({}, {});");
  }
  f.print(" * });");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("const", clientTagSymbol),
    ": ",
    clientTagSymbol,
    " = ",
    importContext,
    ".Service<",
    clientSymbol,
    "<any>>(`${",
    serviceIdSymbol,
    "}/Client`);",
  );

  f.print();

  f.print("/**");
  f.print(
    " * Makes a Context tag for a ",
    service.name,
    " client whose calls take metadata of type `Meta`.",
  );
  f.print(" *");
  f.print(
    " * The tag's key is `",
    service.typeName,
    "/Client<key>`, so it never equals the default tag's key.",
  );
  f.print(" * The key is the tag's identity: tags made with the same key share one Context slot,");
  f.print(
    " * whatever their type argument. Name the key after the metadata type. Build the client",
  );
  f.print(
    " * with the two-argument {@link ",
    clientLiveLayerSymbol,
    "}, whose `transformMeta` turns `Meta` into request headers.",
  );
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * interface AuthMeta {");
  f.print(" *   readonly token: string;");
  f.print(" * }");
  f.print(" *");
  f.print(" * const AuthClientTag = effectProto.", makeClientTagSymbol, '<AuthMeta>("AuthMeta");');
  f.print(" * const ClientLayer = effectProto.", clientLiveLayerSymbol, "(");
  f.print(
    " *   (meta: AuthMeta) => ({ headers: new Headers({ authorization: `Bearer ${meta.token}` }) }),",
  );
  f.print(" *   AuthClientTag,");
  f.print(" * );");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("function", makeClientTagSymbol),
    "<Meta>(key: string): ",
    clientTagSymbol,
    "<Meta> {",
  );
  f.print(
    "  return ",
    importContext,
    ".Service<",
    clientSymbol,
    "<Meta>>(`${",
    serviceIdSymbol,
    "}/Client<${key}>`);",
  );
  f.print("}");

  f.print();

  f.print("/**");
  f.print(" * Creates a Layer that provides a gRPC client for the ", service.name, " service.");
  f.print(" *");
  f.print(" * This function creates a client that can make gRPC calls to the service.");
  f.print(" * It has two overloads:");
  f.print(" * 1. Simple version: Just pass the tag (uses default empty metadata)");
  f.print(" * 2. Advanced version: Pass a metadata transformer function and the tag");
  f.print(" *");
  f.print(" * The client layer requires:");
  f.print(" * - ", configTagSymbol, ": Configuration with the server URL");
  f.print(" * - EffectGrpcClient.GrpcClientRuntime: The gRPC runtime");
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as Layer from "effect/Layer";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(' * import { EffectGrpcClient } from "@dr_nikson/effect-grpc";');
  f.print(" *");
  f.print(" * // Simple usage with default metadata");
  f.print(
    " * const ClientLayer = effectProto.",
    clientLiveLayerSymbol,
    "(effectProto.",
    clientTagSymbol,
    ");",
  );
  f.print(" *");
  f.print(" * // Configuration layer");
  f.print(" * const ConfigLayer = Layer.succeed(");
  f.print(" *   effectProto.", configTagSymbol, ",");
  f.print(' *   { baseUrl: new URL("http://localhost:50051") }');
  f.print(" * );");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Effect from "effect/Effect";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * // Advanced usage with metadata transformation");
  f.print(" * interface AppMeta {");
  f.print(" *   userId: string;");
  f.print(" *   authToken: string;");
  f.print(" * }");
  f.print(" *");
  f.print(" * const AppClientTag = effectProto.", makeClientTagSymbol, '<AppMeta>("AppMeta");');
  f.print(" *");
  f.print(" * // Transform app metadata to gRPC headers");
  f.print(" * const ClientLayer = effectProto.", clientLiveLayerSymbol, "(");
  f.print(" *   (meta: AppMeta) => ({");
  f.print(" *     headers: new Headers({");
  f.print(' *       "authorization": `Bearer ${meta.authToken}`,');
  f.print(' *       "x-user-id": meta.userId');
  f.print(" *     })");
  f.print(" *   }),");
  f.print(" *   AppClientTag");
  f.print(" * );");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(f.export("const", clientLiveLayerSymbol), ": {");
  f.print("  <Tag extends ", clientTagSymbol, "<Meta>, Meta>(");
  f.print("    transformMeta: (meta: Meta) => ", importEffectGrpcClient, ".RequestMeta,");
  f.print("    tag: Tag,");
  f.print("  ): ", importLayer, ".Layer<");
  f.print("    ", providedType, ",");
  f.print("    never,");
  f.print(
    "    ",
    configTagSymbol,
    '["Identifier"] | ',
    importEffectGrpcClient,
    ".GrpcClientRuntime",
  );
  f.print("  >;");
  f.print();
  f.print("  <Tag extends ", clientTagSymbol, ">(");
  f.print("    tag: Tag,");
  f.print("  ): ", importLayer, ".Layer<");
  f.print("    ", providedType, ",");
  f.print("    never,");
  f.print(
    "    ",
    configTagSymbol,
    '["Identifier"] | ',
    importEffectGrpcClient,
    ".GrpcClientRuntime",
  );
  f.print("  >;");
  f.print("} = ", makeClientLiveLayerSymbol, ";");
  f.print();

  f.print("/**");
  f.print(" * Type alias for the client configuration tag.");
  f.print(" *");
  f.print(" * This tag provides the configuration required by the gRPC client,");
  f.print(" * such as the server URL and connection options.");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("type", configTagSymbol),
    " = ",
    importContext,
    ".Service<",
    importEffectGrpcClient,
    ".GrpcClientConfig<",
    serviceIdSymbol,
    ">, ",
    importEffectGrpcClient,
    ".GrpcClientConfig<",
    serviceIdSymbol,
    ">>",
  );
  f.print();

  f.print("/**");
  f.print(" * Tag for the ", service.name, " client configuration.");
  f.print(" *");
  f.print(" * This tag is used to provide the gRPC client configuration, which includes:");
  f.print(' * - baseUrl: The URL of the gRPC server (e.g., "http://localhost:50051")');
  f.print(" * - Additional connection options (timeouts, interceptors, etc.)");
  f.print(" *");
  f.print(" * You must provide this configuration as a Layer when using the client.");
  f.print(" *");
  f.print(" * @example");
  f.print(" * ```typescript");
  f.print(' * import * as Layer from "effect/Layer";');
  f.print(' * import * as effectProto from "./' + fileBasename + '_effect.js";');
  f.print(" *");
  f.print(" * // Simple configuration with just the base URL");
  f.print(" * const ConfigLayer = Layer.succeed(");
  f.print(" *   effectProto.", configTagSymbol, ",");
  f.print(' *   { baseUrl: new URL("http://localhost:50051") }');
  f.print(" * );");
  f.print(" * ```");
  f.print(" *");
  f.print(" * @generated from service ", service.typeName);
  f.print(" */");
  f.print(
    f.export("const", configTagSymbol),
    ": ",
    configTagSymbol,
    " = ",
    importEffectGrpcClient,
    ".GrpcClientConfig.makeTag(",
    serviceIdSymbol,
    ");",
  );

  f.print();

  f.print(
    "function ",
    makeClientLiveLayerSymbol,
    "<Tag extends ",
    clientTagSymbol,
    "<Meta>, Meta = object>(",
  );
  f.print(
    "  ...args: readonly [(meta: Meta) => ",
    importEffectGrpcClient,
    ".RequestMeta, Tag] | readonly [Tag]",
  );
  f.print(") {");
  f.print("  const [transformMeta, tag] =");
  f.print("    isDefaultMetaArguments(args) ?");
  f.print("      ([() => ({}) as ", importEffectGrpcClient, ".RequestMeta, args[0]] as const)");
  f.print("    : args;");
  f.print();
  f.print("  const prog = ", importEffect, ".gen(function* () {");
  f.print("    const config = yield* ", configTagSymbol, ";");
  f.print("    const grpcRuntime = yield* ", importEffectGrpcClient, ".GrpcClientRuntime;");

  const methodNames = service.methods
    .filter((method) => method.methodKind === "unary")
    .map((method) => `"${method.localName}"`)
    .join(", ");

  f.print(
    "    const executor = yield* grpcRuntime.makeExecutor(",
    importService,
    ", [",
    methodNames,
    "], config);",
  );
  f.print();
  f.print("    return {");

  service.methods.forEach((method, index) => {
    if (method.methodKind === "unary") {
      f.print("      ", method.localName, "(req, meta) {");
      f.print("        return executor.", method.localName, "(req, transformMeta(meta));");
      f.print("      }", index === service.methods.length - 1 ? "" : ",");
    }
  });

  f.print("    } as ", clientSymbol, "<Meta>;");
  f.print("  });");
  f.print();
  f.print("  return ", importLayer, ".effect(tag, prog);");
  f.print();
  f.print("  function isDefaultMetaArguments(args: unknown): args is readonly [Tag] {");
  f.print("    return Array.isArray(args) && args.length === 1;");
  f.print("  }");
  f.print("}");

  function generateClientMethod(method: DescMethod): void {
    const inputDesc = f.importSchema(method.input);
    const outputType = f.importShape(method.output);
    const importMessageInitShape = f.import("MessageInitShape", "@bufbuild/protobuf", true);

    switch (method.methodKind) {
      case "unary":
        f.print();
        f.print(f.jsDoc(method, "  "));
        f.print("  ", method.localName, "(");
        f.print("    request: ", importMessageInitShape, "<typeof ", inputDesc, ">,");
        f.print("    meta: Meta");
        f.print("  ): ", importEffect, ".Effect<", outputType, ">;");
        return;
      default:
        f.print(
          "  // Method[",
          method.localName,
          "] wasn't generated: methodKind is not yet supported [",
          method.methodKind,
          "]",
        );
        return;
    }
  }

  function generateServerMethod(method: DescMethod): void {
    const inputType = f.importShape(method.input);
    const outputDesc = f.importSchema(method.output);
    const importMessageInitShape = f.import("MessageInitShape", "@bufbuild/protobuf", true);

    switch (method.methodKind) {
      case "unary":
        f.print();
        f.print(f.jsDoc(method, "  "));
        f.print(
          "  ",
          method.localName,
          "(request: ",
          inputType,
          ", ctx: Ctx): ",
          importEffect,
          ".Effect<",
          importMessageInitShape,
          "<typeof ",
          outputDesc,
          ">, ",
          importGrpcException,
          ".GrpcException>;",
        );
        return;
      default:
        f.print(
          "// Method[",
          method.localName,
          "] wasn't generated: methodKind is not yet supported [",
          method.methodKind,
          "]",
        );
        return;
    }
  }
}
