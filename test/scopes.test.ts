import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptiveDependencyError, Container, ScopeError, token } from '../src/index.js';

const Request = token<{ id: number }>('Request');
const Logger = token<{ name: string }>('Logger');
const Handler = token<{ request: { id: number }; logger: { name: string } }>('Handler');

function build() {
  let requests = 0;
  const log: string[] = [];
  const c = new Container()
    .register(Logger, { factory: () => ({ name: 'logger' }), dispose: () => void log.push('logger disposed') })
    .register(Request, {
      lifetime: 'scoped',
      factory: () => ({ id: (requests += 1) }),
      dispose: (r) => void log.push(`request ${r.id} disposed`)
    })
    .register(Handler, {
      lifetime: 'transient',
      factory: async (r) => ({ request: await r.resolve(Request), logger: await r.resolve(Logger) })
    });
  return { c, log };
}

test('scoped providers are shared within a scope and distinct across scopes', async () => {
  const { c } = build();
  const a = c.createScope();
  const b = c.createScope();
  assert.equal(await a.resolve(Request), await a.resolve(Request));
  assert.notEqual(await a.resolve(Request), await b.resolve(Request));
});

test('singletons are shared across scopes', async () => {
  const { c } = build();
  const a = c.createScope();
  const b = c.createScope();
  assert.equal(await a.resolve(Logger), await b.resolve(Logger));
  assert.equal(await a.resolve(Logger), await c.resolve(Logger));
});

test('a transient inside a scope sees that scope', async () => {
  const { c } = build();
  const a = c.createScope();
  const h1 = await a.resolve(Handler);
  const h2 = await a.resolve(Handler);
  assert.notEqual(h1, h2);
  assert.equal(h1.request, h2.request);
  const other = await c.createScope().resolve(Handler);
  assert.notEqual(other.request, h1.request);
});

test('scoped tokens cannot be resolved from the root', async () => {
  const { c } = build();
  await assert.rejects(() => c.resolve(Request), ScopeError);
  await assert.rejects(() => c.resolve(Handler), ScopeError);
});

test('a singleton may not capture a scoped dependency', async () => {
  const Cache = token<unknown>('Cache');
  const c = new Container()
    .register(Request, { lifetime: 'scoped', factory: () => ({ id: 1 }) })
    .register(Cache, { factory: (r) => r.resolve(Request) });
  const scope = c.createScope();
  await assert.rejects(
    () => scope.resolve(Cache),
    (error: unknown) => error instanceof CaptiveDependencyError && /Cache -> Request/.test(error.message)
  );
});

test('a transient used by a singleton cannot capture a scoped dependency either', async () => {
  const Wrapper = token<unknown>('Wrapper');
  const c = new Container()
    .register(Request, { lifetime: 'scoped', factory: () => ({ id: 1 }) })
    .register(Handler, { lifetime: 'transient', factory: async (r) => ({ request: await r.resolve(Request), logger: { name: 'x' } }) })
    .register(Wrapper, { factory: (r) => r.resolve(Handler) });
  await assert.rejects(() => c.createScope().resolve(Wrapper), CaptiveDependencyError);
});

test('disposing a scope disposes only its own instances', async () => {
  const { c, log } = build();
  const scope = c.createScope();
  await scope.resolve(Handler);
  await scope.dispose();
  assert.deepEqual(log, ['request 1 disposed']);
  assert.ok(!c.isDisposed);
  assert.equal((await c.resolve(Logger)).name, 'logger');
});

test('disposal runs in reverse creation order', async () => {
  const order: string[] = [];
  const A = token<string>('A');
  const B = token<string>('B');
  const c = new Container()
    .register(A, { factory: () => 'a', dispose: () => void order.push('A') })
    .register(B, {
      factory: async (r) => `b+${await r.resolve(A)}`,
      dispose: () => void order.push('B')
    });
  await c.resolve(B);
  await c.dispose();
  assert.deepEqual(order, ['B', 'A']);
});

test('disposing the root also disposes open scopes first', async () => {
  const { c, log } = build();
  const scope = c.createScope();
  await scope.resolve(Handler);
  await c.dispose();
  assert.deepEqual(log, ['request 1 disposed', 'logger disposed']);
  assert.ok(scope.isDisposed);
});

test('dispose keeps going after a failing cleanup and reports every error', async () => {
  const A = token<string>('A');
  const B = token<string>('B');
  const done: string[] = [];
  const c = new Container()
    .register(A, { factory: () => 'a', dispose: () => void done.push('A') })
    .register(B, {
      factory: () => 'b',
      dispose: () => {
        throw new Error('cleanup failed');
      }
    });
  await c.resolve(A);
  await c.resolve(B);
  await assert.rejects(
    () => c.dispose(),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 1
  );
  assert.deepEqual(done, ['A']);
});

test('dispose waits for factories that are still running', async () => {
  const order: string[] = [];
  const Slow = token<string>('Slow');
  const c = new Container().register(Slow, {
    factory: async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push('created');
      return 's';
    },
    dispose: () => void order.push('disposed')
  });
  const pending = c.resolve(Slow);
  await c.dispose();
  await pending;
  assert.deepEqual(order, ['created', 'disposed']);
});

test('dispose is idempotent', async () => {
  const { c, log } = build();
  await c.resolve(Logger);
  await c.dispose();
  await c.dispose();
  assert.deepEqual(log, ['logger disposed']);
});

test('async dispose hooks are awaited', async () => {
  const log: string[] = [];
  const A = token<string>('A');
  const c = new Container().register(A, {
    factory: () => 'a',
    dispose: async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.push('async done');
    }
  });
  await c.resolve(A);
  await c.dispose();
  assert.deepEqual(log, ['async done']);
});
