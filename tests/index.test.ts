import { describe, it, expect } from "bun:test";
import { NPCPlugin, NPCOnDemandPlugin, MemorySinceStore } from "../src";

describe("index barrel exports", () => {
  it("exports NPCPlugin, NPCOnDemandPlugin, MemorySinceStore", () => {
    expect(typeof NPCPlugin).toBe("function");
    expect(typeof NPCOnDemandPlugin).toBe("function");
    expect(typeof MemorySinceStore).toBe("function");
  });

  it("MemorySinceStore works via index export", async () => {
    const store = new MemorySinceStore(7);
    expect(await store.get()).toBe(7);
    await store.set(99);
    expect(await store.get()).toBe(99);
  });
});
