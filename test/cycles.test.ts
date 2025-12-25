import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, CycleError, token } from '../src/index.js';

const A = token<unknown>('A');
const B = token<unknown>('B');
const C = token<unknown>('C');

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('a token that depends on itself is a cycle', async () => {
  const c = new Container().register(A, { factory: (r) => r.resolve(A) });
  await assert.rejects(
    () => c.resolve(A),
    (error: unknown) => error instanceof CycleError && error.message === 'dependency cycle: A -> A'
  );
});

test('the error shows the whole path of a longer cycle', async () => {
  const c = new Container()
    .register(A, { factory: (r) => r.resolve(B) })
    .register(B, { factory: (r) => r.resolve(C) })
    .register(C, { factory: (r) => r.resolve(A) });
  await assert.rejects(
    () => c.resolve(A),
    (error: unknown) => error instanceof CycleError && error.message === 'dependency cycle: A -> B -> C -> A'
  );
});

test('cycles through transient providers are caught instead of recursing forever', async () => {
  const c = new Container()
    .register(A, { lifetime: 'transient', factory: (r) => r.resolve(B) })
    .register(B, { lifetime: 'transient', factory: (r) => r.resolve(A) });
  await assert.rejects(() => c.resolve(A), CycleError);
});

test('cycles inside a scope are caught', async () => {
  const c = new Container()
    .register(A, { lifetime: 'scoped', factory: (r) => r.resolve(B) })
    .register(B, { lifetime: 'scoped', factory: (r) => r.resolve(A) });
  await assert.rejects(() => c.createScope().resolve(A), CycleError);
});

test('a diamond is not a cycle', async () => {
  const D = token<string>('D');
  const c = new Container()
    .register(D, { factory: () => 'd' })
    .register(B, { factory: (r) => r.resolve(D) })
    .register(C, { factory: (r) => r.resolve(D) })
    .register(A, { factory: async (r) => (await r.resolveMany(B, C)).join('+') });
  assert.equal(await c.resolve(A), 'd+d');
});

test('a cycle never leaves a cached half-built singleton behind', async () => {
  let broken = true;
  const c = new Container()
    .register(A, { factory: (r) => (broken ? r.resolve(B) : 'fine') })
    .register(B, { factory: (r) => r.resolve(A) });
  await assert.rejects(() => c.resolve(A), CycleError);
  broken = false;
  assert.equal(await c.resolve(A), 'fine');
});

test('two resolutions racing through a cycle both reject instead of deadlocking', async () => {
  const c = new Container()
    .register(A, {
      factory: async (r) => {
        await delay(5);
        return r.resolve(B);
      }
    })
    .register(B, {
      factory: async (r) => {
        await delay(5);
        return r.resolve(A);
      }
    });
  const results = await Promise.allSettled([c.resolve(A), c.resolve(B)]);
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.ok(results.some((r) => r.status === 'rejected' && r.reason instanceof CycleError));
});

test('independent branches resolved in parallel do not trip the cycle check', async () => {
  const E = token<string>('E');
  const F = token<string>('F');
  const c = new Container()
    .register(E, {
      factory: async () => {
        await delay(2);
        return 'e';
      }
    })
    .register(F, {
      factory: async (r) => {
        await delay(1);
        return `f${await r.resolve(E)}`;
      }
    })
    .register(A, { factory: async (r) => `${await r.resolve(E)}${await r.resolve(F)}` });
  const [a, f] = await Promise.all([c.resolve(A), c.resolve(F)]);
  assert.equal(a, 'efe');
  assert.equal(f, 'fe');
});
