export class Token<T> {
  declare readonly _type: T;

  constructor(readonly name: string) {}

  toString(): string {
    return `Token(${this.name})`;
  }
}

export function token<T>(name: string): Token<T> {
  return new Token<T>(name);
}

export type ValueOf<K> = K extends Token<infer T> ? T : never;
