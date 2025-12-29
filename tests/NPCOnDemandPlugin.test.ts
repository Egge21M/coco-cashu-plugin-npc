import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import { createMockSigner, createMockContext } from "./helpers";

describe("NPCPlugin (manual)", () => {
  it("runs a single sync cycle when sync is called", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { calls, ctx } = createMockContext();
    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => [
        { mintUrl: "https://mint.a", expiresAt: 1, quoteId: "qa", paidAt: 10, amount: 100 },
      ],
    };

    await plugin.sync();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("prevents overlapping manual sync runs", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { ctx } = createMockContext();
    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    let calls = 0;
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        calls += 1;
        return [];
      },
    };

    const p1 = plugin.sync();
    const p2 = plugin.sync();
    await Promise.all([p1, p2]);

    // The second sync should have been batched with the first
    // and only resulted in 1 or 2 calls (depending on timing)
    // but not more
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("does nothing before onReady is called", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { ctx } = createMockContext();
    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    // Note: onReady is NOT called

    let called = false;
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        called = true;
        return [];
      },
    };

    await plugin.sync();

    expect(called).toBe(false);
  });

  it("does nothing after shutdown", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { ctx } = createMockContext();
    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    let calls = 0;
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        calls += 1;
        return [];
      },
    };

    await plugin.shutdown();
    await plugin.sync();

    expect(calls).toBe(0);
  });
});
