// #!/usr/bin/env -S node
import { createEcmaScriptPlugin, GeneratedFile, safeIdentifier, type Schema } from "@bufbuild/protoplugin";
import { DescMethod, DescService } from "@bufbuild/protobuf";
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

        file.services.forEach(service => generateEffectService(f, service));
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

function generateEffectService(
    f: GeneratedFile,
    service: DescService,
): void {
    const importEffect = f.import("Effect", "effect");
    const importContext = f.import("Context", "effect");
    const importLayer = f.import("Layer", "effect");
    const importHandlerContext = f.import("HandlerContext", "@connectrpc/connect");
    const importEffectGrpcService = f.import("Server", "@whisklabs/effect-protobuf");

    const importService = f.importSchema(service);

    const serviceSymbol = safeIdentifier(service.name + "Service")
    const grpcServiceSymbol = safeIdentifier(service.name + "GrpcService");
    const serviceTagSymbol = safeIdentifier(service.name + "Tag");
    const makeTagSymbol = safeIdentifier("make" + service.name + "ServiceTag");
    const makeLiveLayerSymbol = safeIdentifier("make" + service.name + "LiveLayer");

    f.print(f.jsDoc(service));
    f.print(f.export("interface", serviceSymbol), "<Ctx> {");

    service.methods.forEach(generateServerMethod);

    f.print("}");

    /**
     * @example
     * ```typescript
     * export const DebugAPIService: {
     *     makeTag<Ctx>(ctxKey: string): DebugAPITag<Ctx>;
     *
     *     liveLayer<Ctx>(service: DebugAPIService<Ctx>):
     *         <Tag extends DebugAPITag<Ctx>>(tag: Tag) => Layer.Layer<Context.Tag.Identifier<Tag>, never, never>;
     * } = {
     *     makeTag: makeDebugAPIServiceTag,
     *     liveLayer: makeDebugApiLiveLayer
     * };
     * ```
     */
    f.print(f.export("const", serviceSymbol), ": {")
    f.print("  makeTag<Ctx>(ctxKey: string): ", serviceTagSymbol, "<Ctx>;");
    f.print();
    f.print("  liveLayer<Ctx>(");
    f.print("    service: ", serviceSymbol, "<Ctx>");
    f.print(
        "  ): <Tag extends ", serviceTagSymbol, "<Ctx>>(tag: Tag) => ", importLayer, ".Layer<", importContext, ".Tag.Identifier<Tag>, never, never>;"
    );
    f.print("} = {");
    f.print("    makeTag: ", makeTagSymbol, ",")
    f.print("    liveLayer: ", makeLiveLayerSymbol);
    f.print("};");

    f.print();

    // export type DebugAPIGrpcService<Ctx = HandlerContext> = EffectGrpcServer.GrpcService<"DebugAPI", typeof proto.DebugAPI, Ctx>
    f.print(
        f.export("type", grpcServiceSymbol), "<Ctx = ", importHandlerContext, ">",
        " = ", importEffectGrpcService, `.GrpcService<"`, service.typeName, `", typeof `, importService, ", Ctx>"
    )

    // export type DebugAPITag<Ctx> = Context.Tag<DebugAPIGrpcService<Ctx>, DebugAPIGrpcService<Ctx>>
    f.print(
        f.export("type", serviceTagSymbol), "<Ctx>",
        " = ",
        importContext, ".Tag<", grpcServiceSymbol, "<Ctx>, ", grpcServiceSymbol, "<Ctx>>"
    );


    /**
     * @example
     * ```typescript
     * function makeDebugAPIServiceTag<Ctx>(ctxKey: string & keyof Ctx): DebugAPITag<Ctx> {
     *     return Context.GenericTag<DebugAPIGrpcService<Ctx>, DebugAPIGrpcService<Ctx>>(`${proto.DebugAPI.typeName}<${ctxKey}}>`);
     * }
     * ```
     */
    f.print( "function ", makeTagSymbol, "<Ctx>(ctxKey: string): ", serviceTagSymbol, "<Ctx> {");
    f.print("  return ", importContext, ".GenericTag<", grpcServiceSymbol, "<Ctx>>(`", service.typeName, "<${ctxKey}>`);")
    f.print("}")

    f.print();
    /**
     * @example
     * ```typescript
     * function makeDebugApiLiveLayer<Ctx>(service: DebugAPIService<Ctx>) {
     *     return <Tag extends DebugAPITag<Ctx>>(tag: Tag) => {
     *         type Proto = typeof proto.DebugAPI;
     *
     *         const instance: DebugAPIGrpcService<Ctx> = EffectGrpcServer.GrpcService("DebugAPI" as const, proto.DebugAPI)(
     *             (executor: EffectGrpcServer.Executor<Ctx>): ServiceImpl<Proto> => {
     *                 return {
     *                     getDebugInfo: (req: proto.GetDebugInfoRequest, ctx: HandlerContext) => {
     *                         return executor.unary(
     *                             req,
     *                             ctx,
     *                             (req, ctx) => service.getDebugInfo(req, ctx)
     *                         );
     *                     }
     *                 } as ServiceImpl<Proto>;
     *             }
     *         );
     *
     *         return Layer.succeed(tag, instance);
     *
     *     }
     * }
     * ```
     */
    f.print("function ", makeLiveLayerSymbol, "<Ctx>(service: ", serviceSymbol, "<Ctx>) {");
    f.print("  return <Tag extends ", serviceTagSymbol, "<Ctx>>(tag: Tag) => {");
    f.print();
    f.print("    const instance: ", grpcServiceSymbol, "<Ctx> = ", importEffectGrpcService, '.GrpcService("', service.typeName, '" as const, ', importService, ")(");
    f.print("      (executor) => ({");

    service.methods.forEach((method) => {
        if (method.methodKind === "unary") {
            f.print("        ", method.localName, ": (req, ctx) => executor.unary(req, ctx, (req, ctx) => service.", method.localName, "(req, ctx))", ",");
        }
    });

    f.print("      })");
    f.print("    );");
    f.print();
    f.print("    return ", importLayer, ".succeed(tag, instance);");
    f.print("  };");
    f.print("}");

    f.print();

    const clientSymbol = safeIdentifier(service.name + "Client");

    /**
     * @example
     * ```typescript
     * export interface DebugAPIClient<Meta> {
     *     getDebugInfo(
     *         request: MessageInitShape<typeof proto.GetDebugInfoRequestSchema>,
     *         meta: Meta,
     *     ): Effect.Effect<proto.GetDebugInfoResponse>
     * }
     * ```
     */
    f.print(f.jsDoc(service));
    f.print(f.export("interface", clientSymbol), "<Meta> {");

    service.methods.forEach(generateClientMethod);

    f.print("}");

    /**
     * @example
     * ```typescript
     * export const DebugAPIClient: {
     *     makeTag<Meta>(metaKey: string): DebugAPIClientTag<Meta>
     *
     *     liveLayer<Meta>(transformMeta: (meta: Meta) => RequestMeta):
     *         <Tag extends DebugAPIClientTag<Meta>>(tag: Tag) => Layer.Layer<Context.Tag.Identifier<Tag>, never, EffectGrpcClient.GrpcClient>
     * } = {
     *     makeTag: makeDebugAPIClientTag,
     *     liveLayer: makeDebugApiClientLiveLayer,
     * }
     * ```
     */
    const importEffectGrpcClient = f.import("Client", "@whisklabs/effect-protobuf");

    const clientTagSymbol = safeIdentifier(service.name + "ClientTag");
    const makeClientTagSymbol = safeIdentifier("make" + service.name + "ClientTag");
    const makeClientLiveLayerSymbol = safeIdentifier("make" + service.name + "ClientLiveLayer");

    f.print(f.export("const", clientSymbol), ": {")
    f.print("  makeTag<Meta>(metaKey: string): ", clientTagSymbol, "<Meta>;");
    f.print();
    f.print("  liveLayer<Meta>(transformMeta: (meta: Meta) => ", importEffectGrpcClient, ".RequestMeta):");
    f.print("    <Tag extends ", clientTagSymbol, "<Meta>>(tag: Tag) => ", importLayer, ".Layer<", importContext, ".Tag.Identifier<Tag>, never, ", importEffectGrpcClient, ".GrpcClient>;");
    f.print("} = {");
    f.print("  makeTag: ", makeClientTagSymbol, ",");
    f.print("  liveLayer: ", makeClientLiveLayerSymbol, ",");
    f.print("};");

    f.print();

    // export type DebugAPIClientTag<Meta> = Context.Tag<DebugAPIClient<Meta>, DebugAPIClient<Meta>>
    f.print(
        f.export("type", clientTagSymbol), "<Meta>",
        " = ",
        importContext, ".Tag<", clientSymbol, "<Meta>, ", clientSymbol, "<Meta>>"
    );

    f.print();

    // function makeDebugAPIClientTag<Meta>(metaKey: string): DebugAPIClientTag<Meta>
    f.print("function ", makeClientTagSymbol, "<Meta>(metaKey: string): ", clientTagSymbol, "<Meta> {");
    f.print("  return ", importContext, ".GenericTag<", clientSymbol, "<Meta>>(`", service.typeName, "Client<${metaKey}>`);");
    f.print("}");

    f.print();

    /**
     * @example
     * ```typescript
     * function makeDebugApiClientLiveLayer<Meta>(transformMeta: (meta: Meta) => RequestMeta) {
     *     return <Tag extends DebugAPIClientTag<Meta>>(tag: Tag) => {
     *         const prog = Effect.gen(function* () {
     *             const grpcService = yield* EffectGrpcClient.GrpcClient
     *             const executor = grpcService.makeExecutor(proto.DebugAPI, ["getDebugInfo"]);
     *
     *             return {
     *                 getDebugInfo(req, meta) {
     *                     return executor.getDebugInfo(req, meta ?? transformMeta(meta));
     *                 },
     *             } as DebugAPIClient<Meta>;
     *         });
     *
     *         return Layer.effect(tag, prog);
     *     }
     * }
     * ```
     */
    // function makeDebugAPIClientLiveLayer<Meta>(transformMeta: (meta: Meta) => RequestMeta)
    f.print("function ", makeClientLiveLayerSymbol, "<Meta>(transformMeta: (meta: Meta) => ", importEffectGrpcClient, ".RequestMeta) {");
    f.print("  return <Tag extends ", clientTagSymbol, "<Meta>>(tag: Tag) => {");
    f.print("    const prog = ", importEffect, ".gen(function* () {");
    f.print("      const grpcService = yield* ", importEffectGrpcClient, ".GrpcClient;");

    // Collect method names for makeExecutor
    const methodNames = service.methods
        .filter(method => method.methodKind === "unary")
        .map(method => `"${method.localName}"`)
        .join(", ");

    f.print("      const executor = grpcService.makeExecutor(", importService, ", [", methodNames, "]);");
    f.print();
    f.print("      return {");

    service.methods.forEach((method, index) => {
        if (method.methodKind === "unary") {
            f.print("        ", method.localName, "(req, meta) {");
            f.print("          return executor.", method.localName, "(req, transformMeta(meta));");
            f.print("        }", index === service.methods.length - 1 ? "" : ",");
        }
    });

    f.print("      } as ", clientSymbol, "<Meta>;");
    f.print("    });");
    f.print();
    f.print("    return ", importLayer, ".effect(tag, prog);");
    f.print("  };");
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
                f.print("  ", method.localName, "(request: ", inputType, ", ctx: Ctx): ", importEffect, ".Effect<", importMessageInitShape, "<typeof ", outputDesc, ">>;");
                return;
            default:
                f.print("// Method[", method.localName, "] wasn't generated: methodKind is not yet supported [", method.methodKind, "]");
                return;
        }
    }
}
