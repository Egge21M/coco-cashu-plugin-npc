/**
 * Interface for persisting the last processed timestamp.
 *
 * Implementations should store the timestamp durably to allow
 * resuming sync operations after restarts.
 */
export interface SinceStore {
  /**
   * Retrieves the last processed timestamp.
   * @returns The timestamp in milliseconds, or 0 if never set
   */
  get(): Promise<number>;

  /**
   * Stores the last processed timestamp.
   * @param since - The timestamp in milliseconds
   */
  set(since: number): Promise<void>;
}

/**
 * In-memory implementation of SinceStore.
 *
 * Note: State is lost on restart. Use a database-backed
 * implementation for production use cases that require durability.
 *
 * @example
 * ```typescript
 * const store = new MemorySinceStore(0);
 * await store.set(Date.now());
 * const since = await store.get(); // Returns the stored timestamp
 * ```
 */
export class MemorySinceStore implements SinceStore {
  private since: number;

  /**
   * Creates a new MemorySinceStore.
   * @param initialSince - Initial timestamp value (default: 0)
   */
  constructor(initialSince = 0) {
    this.since = initialSince;
  }

  async get(): Promise<number> {
    return this.since;
  }

  async set(since: number): Promise<void> {
    this.since = since;
  }
}

/**
 * LocalStorage-based implementation of SinceStore.
 *
 * Persists the timestamp to browser localStorage, allowing state
 * to survive page refreshes and browser restarts.
 *
 * Note: Only works in browser environments where localStorage is available.
 * Will throw an error if localStorage is not accessible.
 *
 * @example
 * ```typescript
 * const store = new LocalStorageSinceStore("my-app-npc-since");
 * await store.set(Date.now());
 * const since = await store.get(); // Returns the stored timestamp
 * ```
 */
export class LocalStorageSinceStore implements SinceStore {
  private readonly key: string;
  private readonly fallbackValue: number;

  /**
   * Creates a new LocalStorageSinceStore.
   * @param key - The localStorage key to use for storing the timestamp
   * @param fallbackValue - Value to return if no timestamp is stored (default: 0)
   * @throws {Error} If localStorage is not available
   */
  constructor(key: string, fallbackValue = 0) {
    if (typeof localStorage === "undefined") {
      throw new Error(
        "LocalStorageSinceStore requires localStorage to be available"
      );
    }
    this.key = key;
    this.fallbackValue = fallbackValue;
  }

  async get(): Promise<number> {
    const value = localStorage.getItem(this.key);
    if (value === null) {
      return this.fallbackValue;
    }
    const parsed = Number(value);
    return Number.isNaN(parsed) ? this.fallbackValue : parsed;
  }

  async set(since: number): Promise<void> {
    localStorage.setItem(this.key, String(since));
  }

  /**
   * Removes the stored timestamp from localStorage.
   */
  async clear(): Promise<void> {
    localStorage.removeItem(this.key);
  }
}
