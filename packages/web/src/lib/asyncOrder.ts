/**
 * Monotonic request token: only the latest generation may commit results.
 */
export function createRevisionGate() {
  let rev = 0;
  return {
    next(): number {
      rev += 1;
      return rev;
    },
    /** True if this token is still the latest. */
    isCurrent(token: number): boolean {
      return token === rev;
    },
    /** Invalidate all outstanding tokens (session teardown). */
    invalidate(): void {
      rev += 1;
    },
    current(): number {
      return rev;
    },
  };
}

export type RevisionGate = ReturnType<typeof createRevisionGate>;

/**
 * Serialize async work in call order. A rejected task does not poison the queue.
 */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  let generation = 0;

  return {
    /** Enqueue work; returns a promise for this item only. */
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const gen = generation;
      const run = tail.then(
        () => {
          if (gen !== generation) {
            return Promise.reject(new Error("queue invalidated"));
          }
          return fn();
        },
        () => {
          // prior failure already handled; continue chain
          if (gen !== generation) {
            return Promise.reject(new Error("queue invalidated"));
          }
          return fn();
        },
      );
      // Keep queue alive regardless of this item's outcome
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    /** Drop pending chain (session change); in-flight item may still finish. */
    invalidate(): void {
      generation += 1;
      tail = Promise.resolve();
    },
  };
}

export type SerialQueue = ReturnType<typeof createSerialQueue>;
