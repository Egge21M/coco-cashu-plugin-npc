import { describe, it, expect } from "bun:test";
import { MemorySinceStore } from "../src/sync/sinceStore";

describe("MemorySinceStore", () => {
  it("get and set update the since value", async () => {
    const store = new MemorySinceStore(5);
    expect(await store.get()).toBe(5);
    await store.set(10);
    expect(await store.get()).toBe(10);
  });
});
