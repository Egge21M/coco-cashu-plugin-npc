import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  MemorySinceStore,
  LocalStorageSinceStore,
} from "../src/sync/sinceStore";

describe("MemorySinceStore", () => {
  it("get and set update the since value", async () => {
    const store = new MemorySinceStore(5);
    expect(await store.get()).toBe(5);
    await store.set(10);
    expect(await store.get()).toBe(10);
  });

  it("defaults to 0 if no initial value provided", async () => {
    const store = new MemorySinceStore();
    expect(await store.get()).toBe(0);
  });
});

describe("LocalStorageSinceStore", () => {
  // Mock localStorage for testing
  let mockStorage: Map<string, string>;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(() => {
    mockStorage = new Map();
    originalLocalStorage = globalThis.localStorage;

    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (key: string) => mockStorage.get(key) ?? null,
      setItem: (key: string, value: string) => mockStorage.set(key, value),
      removeItem: (key: string) => mockStorage.delete(key),
      clear: () => mockStorage.clear(),
      get length() {
        return mockStorage.size;
      },
      key: (index: number) => Array.from(mockStorage.keys())[index] ?? null,
    };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).localStorage = originalLocalStorage;
  });

  it("get and set update the since value", async () => {
    const store = new LocalStorageSinceStore("test-key");
    expect(await store.get()).toBe(0);
    await store.set(100);
    expect(await store.get()).toBe(100);
  });

  it("persists value to localStorage", async () => {
    const store = new LocalStorageSinceStore("test-key");
    await store.set(12345);
    expect(mockStorage.get("test-key")).toBe("12345");
  });

  it("returns fallback value when key not found", async () => {
    const store = new LocalStorageSinceStore("test-key", 999);
    expect(await store.get()).toBe(999);
  });

  it("returns fallback value for invalid stored value", async () => {
    mockStorage.set("test-key", "not-a-number");
    const store = new LocalStorageSinceStore("test-key", 42);
    expect(await store.get()).toBe(42);
  });

  it("clear removes the stored value", async () => {
    const store = new LocalStorageSinceStore("test-key");
    await store.set(100);
    expect(mockStorage.has("test-key")).toBe(true);
    await store.clear();
    expect(mockStorage.has("test-key")).toBe(false);
  });

  it("uses unique keys for different instances", async () => {
    const store1 = new LocalStorageSinceStore("key-1");
    const store2 = new LocalStorageSinceStore("key-2");

    await store1.set(100);
    await store2.set(200);

    expect(await store1.get()).toBe(100);
    expect(await store2.get()).toBe(200);
  });

  it("throws error when localStorage is not available", () => {
    (globalThis as Record<string, unknown>).localStorage = undefined;
    expect(() => {
      new LocalStorageSinceStore("test-key");
    }).toThrow("LocalStorageSinceStore requires localStorage to be available");
  });
});
