/**
 * An in-process lock per key: withLock(key, task) runs task after every task taken earlier for
 * the same key has settled, and returns what task returns (or throws what it throws). Tasks for
 * other keys run concurrently.
 *
 * The service takes it per target organisation around reading the current values, the conflict
 * check, the writes and the apply, so a second request on the same organisation sees the effect
 * of the first. It serialises within one service instance only: two instances behind one
 * dispatcher would each have their own (app-rvs runs one).
 */
export function createLock() {
  const tails = new Map();
  return async function withLock(key, task) {
    const previous = tails.get(key) || Promise.resolve();
    let release;
    const done = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}
