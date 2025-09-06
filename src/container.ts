import {
  CaptiveDependencyError,
  CycleError,
  DisposedError,
  DuplicateError,
  ScopeError,
  UnregisteredError
} from './errors.js';
import type { Token, ValueOf } from './token.js';

export type Lifetime = 'singleton' | 'scoped' | 'transient';

export interface Resolver {
  resolve<T>(token: Token<T>): Promise<T>;
  resolveOptional<T>(token: Token<T>): Promise<T | undefined>;
  resolveMany<const T extends readonly Token<unknown>[]>(...tokens: T): Promise<{ -readonly [K in keyof T]: ValueOf<T[K]> }>;
}

export interface Registration<T> {
  readonly lifetime?: Lifetime;
  readonly factory: (resolver: Resolver) => T | Promise<T>;
  readonly dispose?: (value: T) => void | Promise<void>;
}

interface Entry<T> {
  readonly lifetime: Lifetime;
  readonly factory: (resolver: Resolver) => T | Promise<T>;
  readonly dispose: ((value: T) => void | Promise<void>) | undefined;
}

interface Slot {
  readonly token: Token<unknown>;
  readonly waitsOn: Set<Slot>;
  settled: boolean;
  promise: Promise<unknown>;
}

interface Context {
  readonly path: readonly Token<unknown>[];
  readonly slot: Slot | null;
  readonly captive: boolean;
}

const ROOT_CONTEXT: Context = { path: [], slot: null, captive: false };

function findWaitPath(from: Slot, target: Slot, seen = new Set<Slot>()): Slot[] | null {
  if (from === target) return [from];
  if (from.settled || seen.has(from)) return null;
  seen.add(from);
  for (const next of from.waitsOn) {
    const rest = findWaitPath(next, target, seen);
    if (rest) return [from, ...rest];
  }
  return null;
}

export class Container implements Resolver {
  private readonly entries: Map<Token<unknown>, Entry<unknown>>;
  private readonly root: Container;
  private readonly cache = new Map<Token<unknown>, Slot>();
  private readonly cleanups: (() => void | Promise<void>)[] = [];
  private readonly scopes = new Set<Container>();
  private disposed = false;

  constructor();
  constructor(parent: Container);
  constructor(parent?: Container) {
    this.root = parent ? parent.root : this;
    this.entries = parent ? parent.entries : new Map();
    parent?.root.scopes.add(this);
  }

  get isRoot(): boolean {
    return this.root === this;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  register<T>(token: Token<T>, registration: Registration<T>): this {
    if (!this.isRoot) throw new Error('providers can only be registered on the root container');
    if (this.entries.has(token)) throw new DuplicateError(token);
    this.entries.set(token, {
      lifetime: registration.lifetime ?? 'singleton',
      factory: registration.factory,
      dispose: registration.dispose as Entry<unknown>['dispose']
    });
    return this;
  }

  registerValue<T>(token: Token<T>, value: T): this {
    return this.register(token, { factory: () => value });
  }

  has(token: Token<unknown>): boolean {
    return this.entries.has(token);
  }

  createScope(): Container {
    this.assertLive();
    return new Container(this.root);
  }

  resolve<T>(token: Token<T>): Promise<T> {
    return this.resolveIn(token, ROOT_CONTEXT);
  }

  async resolveOptional<T>(token: Token<T>): Promise<T | undefined> {
    return this.has(token) ? this.resolve(token) : undefined;
  }

  resolveMany<const T extends readonly Token<unknown>[]>(...tokens: T): Promise<{ -readonly [K in keyof T]: ValueOf<T[K]> }> {
    return Promise.all(tokens.map((t) => this.resolve(t))) as Promise<{ -readonly [K in keyof T]: ValueOf<T[K]> }>;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const scope of [...this.scopes]) {
      if (scope !== this) await scope.dispose().catch((error: unknown) => errors.push(error));
    }
    await Promise.allSettled([...this.cache.values()].map((slot) => slot.promise));
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cache.clear();
    this.root.scopes.delete(this);
    if (errors.length > 0) throw new AggregateError(errors, 'errors while disposing');
  }

  private assertLive(): void {
    if (this.disposed || this.root.disposed) throw new DisposedError();
  }

  private resolverFor(context: Context, container: Container): Resolver {
    return {
      resolve: (token) => container.resolveIn(token, context),
      resolveOptional: async (token) => (container.has(token) ? container.resolveIn(token, context) : undefined),
      resolveMany: ((...tokens: Token<unknown>[]) =>
        Promise.all(tokens.map((t) => container.resolveIn(t, context)))) as Resolver['resolveMany']
    };
  }

  private link(parent: Slot | null, child: Slot): void {
    if (parent === null) return;
    const loop = findWaitPath(child, parent);
    if (loop) throw new CycleError([parent.token, ...loop.map((slot) => slot.token)]);
    parent.waitsOn.add(child);
  }

  private resolveIn<T>(token: Token<T>, context: Context): Promise<T> {
    try {
      return this.start(token, context);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private start<T>(token: Token<T>, context: Context): Promise<T> {
    this.assertLive();
    const entry = this.entries.get(token) as Entry<T> | undefined;
    if (!entry) throw new UnregisteredError(token, context.path);
    if (context.path.includes(token)) throw new CycleError([...context.path, token]);
    if (entry.lifetime === 'scoped') {
      if (context.captive) throw new CaptiveDependencyError(token, context.path);
      if (this.isRoot) throw new ScopeError(token);
    }

    const owner = entry.lifetime === 'singleton' ? this.root : this;
    if (entry.lifetime !== 'transient') {
      const existing = owner.cache.get(token);
      if (existing) {
        this.link(context.slot, existing);
        return existing.promise as Promise<T>;
      }
    }

    const slot: Slot = { token, waitsOn: new Set(), settled: false, promise: Promise.resolve() };
    this.link(context.slot, slot);
    if (entry.lifetime !== 'transient') owner.cache.set(token, slot);

    const childContext: Context = {
      path: [...context.path, token],
      slot,
      captive: context.captive || entry.lifetime === 'singleton'
    };
    const resolver = this.resolverFor(childContext, owner);

    slot.promise = Promise.resolve()
      .then(async () => {
        const value = await entry.factory(resolver);
        if (entry.dispose) {
          const dispose = entry.dispose;
          owner.cleanups.push(() => dispose(value));
        }
        return value;
      })
      .then(
        (value) => {
          slot.settled = true;
          slot.waitsOn.clear();
          return value;
        },
        (error: unknown) => {
          slot.settled = true;
          slot.waitsOn.clear();
          if (owner.cache.get(token) === slot) owner.cache.delete(token);
          throw error;
        }
      );
    return slot.promise as Promise<T>;
  }
}
