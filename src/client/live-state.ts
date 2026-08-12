export function createLiveState<T extends object>(current: () => T): T {
  return new Proxy({} as T, {
    get: (_target, key: PropertyKey) => Reflect.get(current(), key),
    set: (_target, key: PropertyKey, value: unknown) => Reflect.set(current(), key, value),
  });
}
