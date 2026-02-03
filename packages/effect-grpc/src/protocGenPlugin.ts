// #!/usr/bin/env -S node
import type { GeneratedFile, Schema } from "@bufbuild/protoplugin";
import { createEcmaScriptPlugin, safeIdentifier } from "@bufbuild/protoplugin";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
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

        // Add Effect imports (namespace imports from submodules)
        const effectImports = {
            Context: safeIdentifier("Context"),
            Effect: safeIdentifier("Effect"),
            Layer: safeIdentifier("Layer"),
            Scope: safeIdentifier("Scope"),
        };
        f.print('import * as ', effectImports.Context, ' from "effect/Context";');
        f.print('import * as ', effectImports.Effect, ' from "effect/Effect";');
        f.print('import * as ', effectImports.Layer, ' from "effect/Layer";');
        f.print('import * as ', effectImports.Scope, ' from "effect/Scope";');
        f.print();

        // Extract basename from file path for import examples
        const fileBasename = file.name.split('/').pop() || file.name;
        file.services.forEach(service => generateEffectService(f, service, fileBasename, effectImports));
        /*
                for (const service of file.services) {
                    f.print(f.jsDoc(service));
                    f.print(f.export("class", safeIdentifier(service.name + "Client")), " {");


                    // To support the custom option we defined in customoptions/default_host.proto,
                    // we need to generate code for this proto file first. This will generate the
                    // file customoptions/default_host_pb.ts, which contains the generated option
                    // extension `default_host`.
                    // Then we use the functions hasOption() and getOption() to see whether the
                    // option is set, and set the value as the default for the constructor argument.
                    if (hasOption(service, default_host)) {
                        const defaultHost = getOption(service, default_host);
                        f.print("  constructor(private readonly baseUrl = ", f.string(defaultHost), ") {}");
                    } else {
                        f.print("  constructor(private readonly baseUrl: string) {}");
                    }
                    f.print();
                    for (const method of service.methods) {
                        if (method.methodKind != "unary") {
                            // Fetch only supports unary RPCs
                            continue;
                        }
                        f.print(f.jsDoc(method, "  "));
                        const inputType = f.importShape(method.input);
                        const inputDesc = f.importSchema(method.input);
                        const outputType = f.importShape(method.output);
                        const outputDesc = f.importSchema(method.output);
                        f.print("  async ", method.localName, "(request: ", inputType, "): Promise<", outputType, "> {");
                        f.print('    const method = "POST";');
                        f.print('    const url = `${this.baseUrl}/', service.typeName, '/', method.name, '`;');
                        f.print('    const headers = new Headers({');
                        f.print('      "Content-Type": "application/json",');
                        f.print('    });');
                        f.print('    const body = ', f.runtime.toJsonString, '(', inputDesc, ', request);');
                        if (schema.options.logRequests) {
                            f.print("    console.log(`${method} ${url}`, request);");
                        }
                        f.print("    const response = await fetch(url, { method, headers, body });");
                        f.print("    if (response.status !== 200) {");
                        f.print("      throw Error(`HTTP ${response.status} ${response.statusText}`);");
                        f.print("    }");
                        f.print("    return ", f.runtime.fromJson, "(", outputDesc, ", await response.json());");
                        f.print("  }");
                    }
                    f.print("}");
                }*/
    }
}

interface EffectImports {
    Context: string;
    Effect: string;
    Layer: string;
    Scope: string;
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
    // Effect imports are added manually as namespace imports in generateTs()
    const { Context: importContext, Effect: importEffect, Layer: importLayer, Scope: importScope } = effectImports;
    const importEffectGrpcService = f.import("EffectGrpcServer", packageJson.name);
    const importGrpcException = f.import("GrpcException", packageJson.name);

    const importService = f.importSchema(service);

    // Use appendSuffixIfNeeded to avoid duplicate suffixes (e.g., "HelloWorldServiceService")
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

    // Generate service ID constant with JSDoc
    f.print("/**");
    f.print(" * Unique identifier for the ", service.name, " gRPC service.");
    f.print(" *");
    f.print(" * This constant represents the fully qualified service name from the Protocol Buffer definition.");
    f.print(" * It's used to identify and wire gRPC dependencies.");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(f.export("const", serviceIdSymbol), " = ", f.string(serviceId), " as const;");
    f.print(f.export("type", serviceIdSymbol), " = typeof ", serviceIdSymbol, ";");
    f.print();

    // Generate comprehensive JSDoc for service interface
    f.print("/**");
    f.print(" * gRPC service interface.");
    f.print(" *");
    f.print(" * @typeParam Ctx - The type of context passed to service methods. Use this to inject");
    f.print(" *                  dependencies or pass request-scoped data (e.g., authentication info)");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
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

    // Generate direct exported layer function with JSDoc
    f.print("/**");
    f.print(" * Creates a Layer that provides a gRPC service implementation.");
    f.print(" *");
    f.print(" * This function takes your service implementation and wraps it in a Layer that can be");
    f.print(" * composed with other layers to build your application. The returned function accepts");
    f.print(" * a Context.Tag to identify the service in the Effect context.");
    f.print(" *");
    f.print(" * @typeParam Ctx - The context type used by your service implementation");
    f.print(" *");
    f.print(" * @param tag - Context tag to identify the service");
    f.print(" * @param service - Your implementation of the ", serviceSymbol, " interface");
    f.print(" * @returns A Layer providing the gRPC service");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as Layer from \"effect/Layer\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
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
    f.print(" * const ServiceLayer = effectProto.", serviceLiveLayerSymbol, "(effectProto.", serviceTagSymbol, ", myService);");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(f.export("const", serviceLiveLayerSymbol), ": {");
    f.print("  <Tag extends ", serviceTagSymbol, "<Ctx>, Ctx>(");
    f.print("    tag: Tag,");
    f.print("    service: ", serviceSymbol, "<Ctx>,");
    f.print("  ): ", importLayer, ".Layer<", importContext, ".Tag.Identifier<Tag>>;");
    f.print("} = ", makeLiveLayerSymbol, ";");

    f.print();

    // Generate type aliases with JSDoc
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
        f.export("type", grpcServiceSymbol), "<Ctx = any>",
        " = ", importEffectGrpcService, ".GrpcService<", serviceIdSymbol, ", typeof ", importService, ", Ctx>"
    );
    f.print();

    // export type DebugAPIServiceTag<Ctx = any> = Context.Tag<DebugAPIGrpcService<Ctx>, DebugAPIGrpcService<Ctx>>
    f.print("/**");
    f.print(" * Type alias for the service Context.Tag.");
    f.print(" *");
    f.print(" * Used to identify and retrieve the service from the Effect context.");
    f.print(" *");
    f.print(" * @typeParam Ctx - The context type used by the service");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(
        f.export("type", serviceTagSymbol), "<Ctx = any>",
        " = ",
        importContext, ".Tag<", grpcServiceSymbol, "<Ctx>, ", grpcServiceSymbol, "<Ctx>>"
    );
    f.print();

    // Generate ServiceTag constant with comprehensive JSDoc
    f.print("/**");
    f.print(" * Context.Tag for identifying the ", service.name, " service implementation.");
    f.print(" *");
    f.print(" * This tag is used to provide and retrieve the service from the Effect context.");
    f.print(" * It supports both default (any) context and typed context via the function overload.");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" *");
    f.print(" * // Use default context tag");
    f.print(" * const myService = {");
    if (service.methods.length > 0 && service.methods[0] !== undefined) {
        const firstMethod = service.methods[0];
        f.print(" *   ", firstMethod.localName, ": (request) => Effect.succeed({})");
    }
    f.print(" * };");
    f.print(" * const ServiceLayer = effectProto.", serviceLiveLayerSymbol, "(effectProto.", serviceTagSymbol, ", myService);");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" *");
    f.print(" * // Create a typed context tag");
    f.print(" * interface MyContext {");
    f.print(" *   userId: string;");
    f.print(" * }");
    f.print(" *");
    f.print(" * const TypedServiceTag = effectProto.", serviceTagSymbol, "<MyContext>(\"MyContext\");");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(f.export("const", serviceTagSymbol), ": ", serviceTagSymbol, " & {");
    f.print("  <Ctx>(ctxKey: string): ", serviceTagSymbol, "<Ctx>;");
    f.print("} = Object.assign(", makeTagSymbol, "(), ", makeTagSymbol, ");");

    f.print();

    /**
     * @example
     * ```typescript
     * function makeDebugAPIServiceTag<Ctx = any>(ctxKey: string = "any"): DebugAPITag<Ctx> {
     *     return Context.GenericTag<DebugAPIGrpcService<Ctx>>(`${proto.DebugAPI.typeName}<${ctxKey}}>`);
     * }
     * ```
     */
    f.print( "function ", makeTagSymbol, "<Ctx = any>(ctxKey: string = ", f.string("any"), "): ", serviceTagSymbol, "<Ctx> {");
    f.print("  return ", importContext, ".GenericTag<", grpcServiceSymbol, "<Ctx>>(`", service.typeName, "<${ctxKey}>`);")
    f.print("}")

    f.print();
    // Generate implementation function
    f.print("function ", makeLiveLayerSymbol, "<Tag extends ", serviceTagSymbol, "<Ctx>, Ctx>(");
    f.print("  tag: Tag,");
    f.print("  service: ", serviceSymbol, "<Ctx>,");
    f.print("): ", importLayer, ".Layer<", importContext, ".Tag.Identifier<Tag>> {");
    f.print("  const instance: ", grpcServiceSymbol, "<Ctx> = ", importEffectGrpcService, ".GrpcService(");
    f.print("    ", serviceIdSymbol, ",");
    f.print("    ", importService, ",");
    f.print("  )((executor) => ({");

    service.methods.forEach((method) => {
        if (method.methodKind === "unary") {
            f.print("    ", method.localName, ": (req, ctx) =>");
            f.print("      executor.unary(`${", serviceIdSymbol, "}/", method.name, "`, req, ctx, (req, ctx) => service.", method.localName, "(req, ctx)),");
        }
    });

    f.print("  }));");
    f.print();
    f.print("  return ", importLayer, ".succeed(tag, instance);");
    f.print("}");

    f.print();

    // Use appendSuffixIfNeeded to avoid duplicate suffixes (e.g., "HelloWorldClientClient")
    const clientName = appendSuffixIfNeeded(service.name, "Client");
    const clientNameLower = clientName.charAt(0).toLowerCase() + clientName.slice(1);

    const clientSymbol = safeIdentifier(clientName);
    const importEffectGrpcClient = f.import("EffectGrpcClient", packageJson.name);
    const clientTagSymbol = safeIdentifier(clientName + "Tag");
    const clientLiveLayerSymbol = safeIdentifier(clientNameLower + "LiveLayer");
    const configTagSymbol = safeIdentifier(service.name + "ConfigTag");
    const makeClientTagSymbol = safeIdentifier("make" + clientName + "Tag");
    const makeClientLiveLayerSymbol = safeIdentifier("make" + clientName + "LiveLayer");

    // Generate comprehensive JSDoc for client interface
    f.print("/**");
    f.print(" * Client interface for making gRPC calls to ", service.name, " service.");
    f.print(" *");
    f.print(" * This interface defines the client-side methods for calling the gRPC service.");
    f.print(" * Each method accepts a request message and metadata, and returns an Effect that");
    f.print(" * produces the response or fails with an error.");
    f.print(" *");
    f.print(" * @typeParam Meta - The type of metadata to pass with each request. This can be used");
    f.print(" *                   for authentication tokens, tracing headers, or other per-request data.");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
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

    // Generate ClientTag type with JSDoc
    f.print("/**");
    f.print(" * Type alias for the client Context.Tag.");
    f.print(" *");
    f.print(" * Used to identify and retrieve the client from the Effect context.");
    f.print(" *");
    f.print(" * @typeParam Meta - The metadata type used by the client");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(
        f.export("type", clientTagSymbol), "<Meta = any>",
        " = ",
        importContext, ".Tag<", clientSymbol, "<Meta>, ", clientSymbol, "<Meta>>"
    );
    f.print();

    // Generate ClientTag constant with comprehensive JSDoc
    f.print("/**");
    f.print(" * Context.Tag for identifying the ", service.name, " client.");
    f.print(" *");
    f.print(" * This tag is used to provide and retrieve the gRPC client from the Effect context.");
    f.print(" * It supports both default (any) metadata and typed metadata via the function overload.");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as Layer from \"effect/Layer\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" * import { EffectGrpcClient } from \"@dr_nikson/effect-grpc\";");
    f.print(" *");
    f.print(" * // Use default metadata type");
    f.print(" * const ClientLayer = effectProto.", clientLiveLayerSymbol, "(effectProto.", clientTagSymbol, ");");
    f.print(" *");
    f.print(" * // Use the client");
    f.print(" * const program = Effect.gen(function* () {");
    f.print(" *   const client = yield* effectProto.", clientTagSymbol, ";");
    if (service.methods.length > 0 && service.methods[0] !== undefined) {
        const firstMethod = service.methods[0];
        f.print(" *   return yield* client.", firstMethod.localName, "({}, {});");
    }
    f.print(" * });");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as Layer from \"effect/Layer\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" *");
    f.print(" * // Create a typed metadata tag");
    f.print(" * interface RequestMeta {");
    f.print(" *   userId: string;");
    f.print(" *   traceId: string;");
    f.print(" * }");
    f.print(" *");
    f.print(" * const TypedClientTag = effectProto.", clientTagSymbol, "<RequestMeta>(\"RequestMeta\");");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(f.export("const", clientTagSymbol), ": ", clientTagSymbol, " & {");
    f.print("  <Meta>(metaKey: string): ", clientTagSymbol, "<Meta>;");
    f.print("} = Object.assign(", makeClientTagSymbol, "<any>(", f.string("any"), "), ", makeClientTagSymbol, ");");

    f.print();

    // Generate clientLiveLayer function with comprehensive JSDoc
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
    f.print(" * - Scope.Scope: For resource management");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as Layer from \"effect/Layer\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" * import { EffectGrpcClient } from \"@dr_nikson/effect-grpc\";");
    f.print(" *");
    f.print(" * // Simple usage with default metadata");
    f.print(" * const ClientLayer = effectProto.", clientLiveLayerSymbol, "(effectProto.", clientTagSymbol, ");");
    f.print(" *");
    f.print(" * // Configuration layer");
    f.print(" * const ConfigLayer = Layer.succeed(");
    f.print(" *   effectProto.", configTagSymbol, ",");
    f.print(" *   { baseUrl: new URL(\"http://localhost:50051\") }");
    f.print(" * );");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Effect from \"effect/Effect\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" *");
    f.print(" * // Advanced usage with metadata transformation");
    f.print(" * interface AppMeta {");
    f.print(" *   userId: string;");
    f.print(" *   authToken: string;");
    f.print(" * }");
    f.print(" *");
    f.print(" * const AppClientTag = effectProto.", clientTagSymbol, "<AppMeta>(\"AppMeta\");");
    f.print(" *");
    f.print(" * // Transform app metadata to gRPC headers");
    f.print(" * const ClientLayer = effectProto.", clientLiveLayerSymbol, "(");
    f.print(" *   (meta: AppMeta) => ({");
    f.print(" *     headers: {");
    f.print(" *       \"authorization\": `Bearer ${meta.authToken}`,");
    f.print(" *       \"x-user-id\": meta.userId");
    f.print(" *     }");
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
    f.print("    ", importContext, ".Tag.Identifier<Tag>,");
    f.print("    never,");
    f.print("    ", configTagSymbol, "[\"Identifier\"] | ", importEffectGrpcClient, ".GrpcClientRuntime | ", importScope, ".Scope");
    f.print("  >;");
    f.print();
    f.print("  <Tag extends ", clientTagSymbol, ">(");
    f.print("    tag: Tag,");
    f.print("  ): ", importLayer, ".Layer<");
    f.print("    ", importContext, ".Tag.Identifier<Tag>,");
    f.print("    never,");
    f.print("    ", configTagSymbol, "[\"Identifier\"] | ", importEffectGrpcClient, ".GrpcClientRuntime | ", importScope, ".Scope");
    f.print("  >;");
    f.print("} = ", makeClientLiveLayerSymbol, ";");
    f.print();

    // Generate ConfigTag type with JSDoc
    f.print("/**");
    f.print(" * Type alias for the client configuration Context.Tag.");
    f.print(" *");
    f.print(" * This tag provides the configuration required by the gRPC client,");
    f.print(" * such as the server URL and connection options.");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(
        f.export("type", configTagSymbol),
        " = ",
        importContext, ".Tag<", importEffectGrpcClient, ".GrpcClientConfig<", serviceIdSymbol, ">, ", importEffectGrpcClient, ".GrpcClientConfig<", serviceIdSymbol, ">>"
    );
    f.print();

    // Generate ConfigTag constant with comprehensive JSDoc
    f.print("/**");
    f.print(" * Context.Tag for the ", service.name, " client configuration.");
    f.print(" *");
    f.print(" * This tag is used to provide the gRPC client configuration, which includes:");
    f.print(" * - baseUrl: The URL of the gRPC server (e.g., \"http://localhost:50051\")");
    f.print(" * - Additional connection options (timeouts, interceptors, etc.)");
    f.print(" *");
    f.print(" * You must provide this configuration as a Layer when using the client.");
    f.print(" *");
    f.print(" * @example");
    f.print(" * ```typescript");
    f.print(" * import * as Layer from \"effect/Layer\";");
    f.print(" * import * as effectProto from \"./" + fileBasename + "_effect.js\";");
    f.print(" *");
    f.print(" * // Simple configuration with just the base URL");
    f.print(" * const ConfigLayer = Layer.succeed(");
    f.print(" *   effectProto.", configTagSymbol, ",");
    f.print(" *   { baseUrl: new URL(\"http://localhost:50051\") }");
    f.print(" * );");
    f.print(" * ```");
    f.print(" *");
    f.print(" * @generated from service ", service.typeName);
    f.print(" */");
    f.print(
        f.export("const", configTagSymbol), ": ", configTagSymbol,
        " = ", importEffectGrpcClient, ".GrpcClientConfig.makeTag(", serviceIdSymbol, ");"
    );

    f.print();

    // Generate makeClientTag helper function
    f.print("function ", makeClientTagSymbol, "<Meta>(metaKey: string): ", clientTagSymbol, "<Meta> {");
    f.print("  return ", importContext, ".GenericTag<", clientSymbol, "<Meta>>(`${", serviceIdSymbol, "}<${metaKey}>`);");
    f.print("}");

    f.print();

    // Generate client implementation function with overload handling
    f.print("function ", makeClientLiveLayerSymbol, "<Tag extends ", clientTagSymbol, "<Meta>, Meta = object>(");
    f.print("  ...args: readonly [(meta: Meta) => ", importEffectGrpcClient, ".RequestMeta, Tag] | readonly [Tag]");
    f.print(") {");
    f.print("  const [transformMeta, tag] =");
    f.print("    isDefaultMetaArguments(args) ?");
    f.print("      ([() => ({}) as ", importEffectGrpcClient, ".RequestMeta, args[0]] as const)");
    f.print("    : args;");
    f.print();
    f.print("  const prog = ", importEffect, ".gen(function* () {");
    f.print("    const config = yield* ", configTagSymbol, ";");
    f.print("    const grpcRuntime = yield* ", importEffectGrpcClient, ".GrpcClientRuntime;");

    // Collect method names for makeExecutor
    const methodNames = service.methods
        .filter(method => method.methodKind === "unary")
        .map(method => `"${method.localName}"`)
        .join(", ");

    f.print("    const executor = yield* grpcRuntime.makeExecutor(", importService, ", [", methodNames, "], config);");
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
    f.print("}")


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
                f.print("  // Method[", method.localName, "] wasn't generated: methodKind is not yet supported [", method.methodKind, "]");
                return;
        }
    }


    function generateServerMethod(method: DescMethod): void {
        const inputType = f.importShape(method.input);
        // const inputDesc = f.importSchema(method.input);
        // const outputType = f.importShape(method.output);
        const outputDesc = f.importSchema(method.output);
        const importMessageInitShape = f.import("MessageInitShape", "@bufbuild/protobuf", true);

        switch (method.methodKind) {
            case "unary":
                f.print();
                f.print(f.jsDoc(method, "  "));
                f.print("  ", method.localName, "(request: ", inputType, ", ctx: Ctx): ", importEffect, ".Effect<", importMessageInitShape, "<typeof ", outputDesc, ">, ", importGrpcException, ".GrpcException>;");
                return;
            default:
                f.print("// Method[", method.localName, "] wasn't generated: methodKind is not yet supported [", method.methodKind, "]");
                return;
        }
    }
}
