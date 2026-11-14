/** A store as callers see it: every method answers with a promise. */
export type Promised<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<Awaited<R>>
  : T extends object
    ? { [K in keyof T]: Promised<T[K]> }
    : T;

/**
 * The asynchronous face of a synchronous store, ahead of one that is
 * asynchronous throughout: each method still runs at once, in order, and
 * settles with its result or its error.
 */
export function promised<T extends object>(target: T): Promised<T> {
  const face: Record<string, unknown> = {};
  const entries: [string, unknown][] = Object.entries(target);
  for (const [key, value] of entries) {
    if (typeof value === 'function')
      face[key] = (...args: unknown[]) => {
        try {
          const result: unknown = Reflect.apply(value, target, args);
          return Promise.resolve(result);
        } catch (error) {
          return Promise.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      };
    else if (typeof value === 'object' && value !== null)
      face[key] = promised(value);
    else face[key] = value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- built key by key from T above; goes when the store is asynchronous throughout.
  return face as Promised<T>;
}
