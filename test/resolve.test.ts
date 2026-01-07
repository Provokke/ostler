import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Container,
  DisposedError,
  DuplicateError,
  UnregisteredError,
  token,
  type Token,
  type ValueOf
} from '../src/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectType<_T extends true>(): void {}

const Config = token<{ url: string }>('Config');
const Db = token<{ url: string; id: number }>('Db');
const Repo = token<{ db: { url: string; id: number } }>('Repo');

const tick = (ms = 1) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('resolves a value registration', async () => {
  const c = new Container().registerValue(Config, { url: 'db://x' });
  assert.deepEqual(await c.resolve(Config), { url: 'db://x' });
});

test('resolve is typed from the token', async () => {
  const c = new Container().registerValue(Config, { url: 'a' });
  const config = await c.resolve(Config);
  expectType<Equal<typeof config, { url: string }>>();
  expectType<Equal<ValueOf<Token<number>>, number>>();
  assert.equal(config.url, 'a');
});

test('factories can depend on other tokens', async () => {
  let ids = 0;
  const c = new Container()
    .registerValue(Config, { url: 'db://x' })
    .register(Db, { factory: async (r) => ({ url: (await r.resolve(Config)).url, id: (ids += 1) }) })
    .register(Repo, { factory: async (r) => ({ db: await r.resolve(Db) }) });
  const repo = await c.resolve(Repo);
  assert.deepEqual(repo.db, { url: 'db://x', id: 1 });
});

test('async factories are awaited', async () => {
  const Slow = token<string>('Slow');
  const c = new Container().register(Slow, {
    factory: async () => {
      await tick(5);
      return 'ready';
    }
  });
  assert.equal(await c.resolve(Slow), 'ready');
});

test('singletons are created once, even under concurrent resolves', async () => {
  let created = 0;
  const c = new Container().register(Db, {
    factory: async () => {
      created += 1;
      await tick(5);
      return { url: 'x', id: created };
    }
  });
  const results = await Promise.all([c.resolve(Db), c.resolve(Db), c.resolve(Db)]);
  assert.equal(created, 1);
  assert.equal(results[0], results[1]);
  assert.equal(results[1], results[2]);
});

test('transients are created on every resolve', async () => {
  let created = 0;
  const c = new Container().register(Db, { lifetime: 'transient', factory: () => ({ url: 'x', id: (created += 1) }) });
  const a = await c.resolve(Db);
  const b = await c.resolve(Db);
  assert.notEqual(a, b);
  assert.equal(created, 2);
});

test('unregistered tokens report who needed them', async () => {
  const c = new Container().register(Repo, { factory: async (r) => ({ db: await r.resolve(Db) }) });
  await assert.rejects(
    () => c.resolve(Repo),
    (error: unknown) => error instanceof UnregisteredError && /"Db" \(needed by Repo\)/.test(error.message)
  );
  await assert.rejects(() => c.resolve(Config), UnregisteredError);
});

test('registering a token twice is an error', () => {
  const c = new Container().registerValue(Config, { url: 'a' });
  assert.throws(() => c.registerValue(Config, { url: 'b' }), DuplicateError);
});

test('different tokens with the same name stay separate', async () => {
  const a = token<string>('same');
  const b = token<string>('same');
  const c = new Container().registerValue(a, 'first').registerValue(b, 'second');
  assert.equal(await c.resolve(a), 'first');
  assert.equal(await c.resolve(b), 'second');
});

test('resolveOptional returns undefined for missing providers', async () => {
  const c = new Container().registerValue(Config, { url: 'a' });
  assert.equal(await c.resolveOptional(Db), undefined);
  assert.deepEqual(await c.resolveOptional(Config), { url: 'a' });
});

test('resolveMany resolves a typed tuple', async () => {
  const Name = token<string>('Name');
  const Count = token<number>('Count');
  const c = new Container().registerValue(Name, 'x').registerValue(Count, 3);
  const [name, count] = await c.resolveMany(Name, Count);
  expectType<Equal<typeof name, string>>();
  expectType<Equal<typeof count, number>>();
  assert.deepEqual([name, count], ['x', 3]);
});

test('a failing factory rejects and is retried on the next resolve', async () => {
  let attempts = 0;
  const c = new Container().register(Config, {
    factory: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return { url: 'ok' };
    }
  });
  await assert.rejects(() => c.resolve(Config), /boom/);
  assert.deepEqual(await c.resolve(Config), { url: 'ok' });
  assert.equal(attempts, 2);
});

test('an error in a dependency propagates to the dependent', async () => {
  const c = new Container()
    .register(Config, { factory: async () => Promise.reject(new Error('no config')) })
    .register(Db, { factory: async (r) => ({ url: (await r.resolve(Config)).url, id: 1 }) });
  await assert.rejects(() => c.resolve(Db), /no config/);
});

test('providers can only be registered on the root', () => {
  const scope = new Container().createScope();
  assert.throws(() => scope.registerValue(Config, { url: 'a' }), /root container/);
});

test('has reports registrations', () => {
  const c = new Container().registerValue(Config, { url: 'a' });
  assert.ok(c.has(Config));
  assert.ok(!c.has(Db));
});

test('a disposed container refuses further work', async () => {
  const c = new Container().registerValue(Config, { url: 'a' });
  await c.dispose();
  await assert.rejects(() => c.resolve(Config), DisposedError);
  assert.throws(() => c.createScope(), DisposedError);
  assert.ok(c.isDisposed);
});
