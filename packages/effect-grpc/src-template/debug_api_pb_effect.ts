import type {HandlerContext, ServiceImpl} from "@connectrpc/connect";
import {createClient} from "@connectrpc/connect";

import {Context, Effect, Layer} from "effect";
import * as proto from "./debug_api_pb.js";

import * as EffectGrpcServer from "../src/effectGrpcServer.js";
import type {MessageInitShape} from "@bufbuild/protobuf";
import * as EffectGrpcClient from "../src/effectGrpcClient.js";
import {RequestMeta} from "../src/effectGrpcClient.js";

export interface DebugAPIService<Ctx> {
    getDebugInfo(
        request: proto.GetDebugInfoRequest,
        ctx: Ctx,
    ): Effect.Effect<MessageInitShape<typeof proto.GetDebugInfoResponseSchema>>;
}

export type DebugAPIGrpcService<Ctx = HandlerContext> = EffectGrpcServer.GrpcService<"DebugAPI", typeof proto.DebugAPI, Ctx>

export type DebugAPITag<Ctx> = Context.Tag<DebugAPIGrpcService<Ctx>, DebugAPIGrpcService<Ctx>>

export const DebugAPIService: {
    makeTag<Ctx>(ctxKey: string): DebugAPITag<Ctx>;

    liveLayer<Ctx>(service: DebugAPIService<Ctx>):
        <Tag extends DebugAPITag<Ctx>>(tag: Tag) => Layer.Layer<Context.Tag.Identifier<Tag>, never, never>;
} = {
    makeTag: makeDebugAPIServiceTag,
    liveLayer: makeDebugApiLiveLayer
};


function makeDebugAPIServiceTag<Ctx>(ctxKey: string & keyof Ctx): DebugAPITag<Ctx> {
    return Context.GenericTag<DebugAPIGrpcService<Ctx>, DebugAPIGrpcService<Ctx>>(`${proto.DebugAPI.typeName}<${ctxKey}}>`);
}

function makeDebugApiLiveLayer<Ctx>(service: DebugAPIService<Ctx>) {
    return <Tag extends DebugAPITag<Ctx>>(tag: Tag) => {
        type Proto = typeof proto.DebugAPI;

        const instance: DebugAPIGrpcService<Ctx> = EffectGrpcServer.GrpcService("DebugAPI" as const, proto.DebugAPI)(
            (executor: EffectGrpcServer.Executor<Ctx>): ServiceImpl<Proto> => {
                return {
                    getDebugInfo: (req: proto.GetDebugInfoRequest, ctx: HandlerContext) => {
                        return executor.unary(
                            req,
                            ctx,
                            (req, ctx) => service.getDebugInfo(req, ctx)
                        );
                    }
                } as ServiceImpl<Proto>;
            }
        );

        return Layer.succeed(tag, instance);

    }
}

export interface DebugAPIClient<Meta> {
    getDebugInfo(
        request: MessageInitShape<typeof proto.GetDebugInfoRequestSchema>,
        meta: Meta,
    ): Effect.Effect<proto.GetDebugInfoResponse>
}

export const DebugAPIClient: {
    makeTag<Meta>(metaKey: string): DebugAPIClientTag<Meta>

    liveLayer<Meta>(transformMeta: (meta: Meta) => RequestMeta):
        <Tag extends DebugAPIClientTag<Meta>>(tag: Tag) => Layer.Layer<Context.Tag.Identifier<Tag>, never, EffectGrpcClient.GrpcClient>
} = {
    makeTag: makeDebugAPIClientTag,
    liveLayer: makeDebugApiClientLiveLayer,
}

// export type DebugAPIGrpcService<Meta = {}> = EffectGrpcServer.GrpcService<"DebugAPI", typeof proto.DebugAPI, Ctx>

export type DebugAPIClientTag<Meta> = Context.Tag<DebugAPIClient<Meta>, DebugAPIClient<Meta>>

function makeDebugAPIClientTag<Meta>(metaKey: string): DebugAPIClientTag<Meta> {
    return Context.GenericTag<DebugAPIClient<Meta>, DebugAPIClient<Meta>>(`${proto.DebugAPI.typeName}<${metaKey}}>`)
}


function makeDebugApiClientLiveLayer<Meta>(transformMeta: (meta: Meta) => RequestMeta) {
    return <Tag extends DebugAPIClientTag<Meta>>(tag: Tag) => {
        const prog = Effect.gen(function* () {
            const grpcService = yield* EffectGrpcClient.GrpcClient
            const executor = grpcService.makeExecutor(proto.DebugAPI, ["getDebugInfo"]);

            return {
                getDebugInfo(req, meta) {
                    return executor.getDebugInfo(req, meta ?? transformMeta(meta));
                },
            } as DebugAPIClient<Meta>;
        });

        return Layer.effect(tag, prog);
    }
}
