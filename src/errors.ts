import type { Token } from './token.js';

function names(path: readonly Token<unknown>[]): string {
  return path.map((token) => token.name).join(' -> ');
}

export class OstlerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnregisteredError extends OstlerError {
  constructor(readonly token: Token<unknown>, readonly path: readonly Token<unknown>[]) {
    super(path.length > 0 ? `no provider for "${token.name}" (needed by ${names(path)})` : `no provider for "${token.name}"`);
  }
}

export class DuplicateError extends OstlerError {
  constructor(readonly token: Token<unknown>) {
    super(`"${token.name}" is already registered`);
  }
}

export class CycleError extends OstlerError {
  constructor(readonly path: readonly Token<unknown>[]) {
    super(`dependency cycle: ${names(path)}`);
  }
}

export class ScopeError extends OstlerError {
  constructor(readonly token: Token<unknown>) {
    super(`"${token.name}" is scoped and can only be resolved from a scope`);
  }
}

export class CaptiveDependencyError extends OstlerError {
  constructor(readonly token: Token<unknown>, readonly path: readonly Token<unknown>[]) {
    super(`scoped "${token.name}" cannot be used by a singleton (${names([...path, token])})`);
  }
}

export class DisposedError extends OstlerError {
  constructor() {
    super('container has been disposed');
  }
}

