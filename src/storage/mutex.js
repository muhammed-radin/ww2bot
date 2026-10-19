/**
 * Keyed async mutex.
 *
 * Serialises read-modify-write cycles for the same key (a file path, an
 * instance id, ...) inside one process. It is intentionally small and has no
 * timers: a task always releases the key from a `finally` block, and the chain
 * for a key is dropped once the last waiter finishes so the map never grows
 * without bound.
 */
export function createMutex() {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();

  /**
   * Run `fn` once every previously queued task for `key` has settled.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  function run(key, fn) {
    const previous = tails.get(key) ?? Promise.resolve();

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // The next waiter only proceeds once this task's gate opens.
    const tail = previous.then(
      () => gate,
      () => gate,
    );
    tails.set(key, tail);

    const finish = () => {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    };

    return previous.then(
      async () => {
        try {
          return await fn();
        } finally {
          finish();
        }
      },
      async () => {
        // A previous task rejecting must not block (or poison) this one.
        try {
          return await fn();
        } finally {
          finish();
        }
      },
    );
  }

  return {
    run,
    size: () => tails.size,
  };
}
