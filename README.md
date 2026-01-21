<div align="center">

# ostler

A dependency-injection container for TypeScript with scopes, async factories and cycle detection. No decorators, no reflection, no dependencies, just typed tokens and functions.

![License](https://img.shields.io/badge/LICENSE-MIT-blue?style=for-the-badge)  ![Language](https://img.shields.io/badge/TYPESCRIPT-3178c6?style=for-the-badge&logo=typescript&logoColor=white)  ![Tests](https://img.shields.io/badge/TESTS-37-brightgreen?style=for-the-badge)

Refer to [LICENSE](LICENSE) for the legal bits.

</div>

## What's in it

- **Typed tokens.** `token<Db>('Db')` carries its type, so `await container.resolve(Db)` is a `Db` with no casts. Two tokens with the same name are still different tokens.
- **Async factories.** A factory can be sync or async and pulls in its own dependencies through a resolver. Independent dependencies can be fetched in parallel with `resolveMany`.
- **Three lifetimes.** `singleton` (the default), `scoped` and `transient`. Singletons are built once, even when many callers resolve them at the same moment.
- **Scopes.** `createScope()` gives you a child container, usually one per request. Scoped instances live and die with their scope.
- **Cycle detection.** A cycle gives you a readable path such as `A -> B -> A`, including cycles through transients and cycles that only show up when two resolutions race each other, which would otherwise deadlock.
- **Captive dependency checks.** A singleton that asks for a scoped dependency is rejected, so a request-scoped object can't be stuck inside something that outlives the request.
- **Disposal.** Optional `dispose` hooks run in reverse creation order, are awaited, and one failing hook doesn't stop the rest. Disposing waits for factories still in flight.
- A failed factory is not cached, so the next resolve can retry.

```ts
const Config = token<{ url: string }>('Config');
const Db = token<{ url: string; close(): void }>('Db');

const root = new Container()
  .registerValue(Config, { url: 'postgres://localhost/app' })
  .register(Db, {
    factory: async (r) => ({ url: (await r.resolve(Config)).url, close() {} }),
    dispose: (db) => db.close()
  });
```

## 🏗️ Architecture

```
 Container (root) ── entries: Token ─► { lifetime, factory, dispose }
   │  singleton cache, cleanups
   ├─ createScope() ─► Container (scope)  scoped cache, cleanups
   │
 resolve(token)
   1. check path for a direct cycle         A -> B -> A
   2. check lifetime rules                  scoped from root, singleton capturing scoped
   3. reuse the cached Slot, or create one  (Slot = in-flight promise + what it waits on)
   4. link slots, reject if the wait-for graph would loop
   5. run the factory with a Resolver bound to this path
```

- `src/container.ts` holds the container, the slot cache, scoping rules and disposal.
- `src/token.ts` has `Token<T>` and the `ValueOf` helper.
- `src/errors.ts` has the error classes: `UnregisteredError`, `DuplicateError`, `CycleError`, `ScopeError`, `CaptiveDependencyError` and `DisposedError`.
- Each in-flight resolution is a slot that records which other slots it is waiting on. That wait-for graph is what catches the racing case, because a plain "path of tokens" check can't see across two separate resolutions.

## 🚀 Quick start

```
npm install
npm run typecheck
npm test
```

A quick taste:

```ts
const Session = token<{ id: number }>('Session');
let sessions = 0;
root.register(Session, {
  lifetime: 'scoped',
  factory: async (r) => {
    await r.resolve(Db);
    return { id: (sessions += 1) };
  }
});

const one = root.createScope();
const two = root.createScope();
console.log((await one.resolve(Session)).id, (await one.resolve(Session)).id, (await two.resolve(Session)).id);
await root.dispose();
```

Which prints:

```
connecting to postgres://localhost/app
1 1 2
db closed
```

The first and last lines come from a `console.log` in the Db factory and in its dispose hook. The database is only built once, however many scopes ask for a session.

## 🧪 Testing

37 tests, all passing, and `tsc --noEmit` is clean under `strict`:

- Resolution (16): value and factory providers, compile-time typing of `resolve` and `resolveMany`, async factories, singleton sharing under concurrency, transients, unregistered tokens with the requesting path, duplicates, same-named tokens, optional resolution, retry after a failed factory, error propagation, root-only registration and use after disposal.
- Scopes and disposal (13): scoped sharing and isolation, singletons across scopes, transients inside scopes, scoped-from-root errors, captive dependencies (direct and through a transient), disposal order, scope versus root disposal, failing and async cleanups, waiting for in-flight factories and idempotent dispose.
- Cycles (8): self cycles, long paths, transient and scoped cycles, diamonds, no cached half-built singleton, racing resolutions and parallel independent branches.
