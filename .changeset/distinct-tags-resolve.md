---
"@dr_nikson/effect-grpc": major
---

Make the generated typed tags work, and give the default service tag and the default client tag their own keys (#55)

**Breaking.** A generated tag constant is no longer callable. `XServiceTag<Ctx>(key)` and `XClientTag<Meta>(key)` compiled, but they threw `TypeError: ... is not a function` at runtime, so no working program calls them. They now fail to compile. Make a typed tag with the new exports `makeXServiceTag<Ctx>(key)` and `makeXClientTag<Meta>(key)`:

```diff
- const AuthClientTag = effectProto.HelloWorldAPIClientTag<AuthMeta>("AuthMeta");
+ const AuthClientTag = effectProto.makeHelloWorldAPIClientTag<AuthMeta>("AuthMeta");
```

Each factory is named `make` plus its tag's name, so `service UserService` gives `makeUserServiceTag` and `makeUserServiceClientTag`. The key is the typed tag's identity: tags made with the same key share one Context slot, whatever their type argument.

**Breaking.** The tag keys change. The default service tag has the key `<ProtoId>/Service`, the default client tag has `<ProtoId>/Client`, and a factory's tag has `<ProtoId>/Service<key>` or `<ProtoId>/Client<key>`. Both default tags had the key `<ProtoId><any>`. A Context given both a service and a client of one proto service kept only the one added last, and both tags returned it. Code that uses the default tags needs no change. Regenerate every package that shares these tags, so that all of them use the new keys.

The live layers now spell their provided type `Tag["Identifier"]` instead of `Context.Tag.Identifier<Tag>`. On Effect 3 both named the same type. Effect 4 has no `Context.Tag`.
