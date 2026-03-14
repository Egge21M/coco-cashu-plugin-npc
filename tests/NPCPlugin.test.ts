import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import { createMockSigner, createMockContext, stubTimeout } from "./helpers";

describe("NPCPlugin (interval)", () => {
  it("arms resettable timer, runs sync, and cleans up on shutdown", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
      syncIntervalMs: 1000,
    });

    const { calls, ctx } = createMockContext();
    const cleanup = plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    // Replace internal npc client with stub
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => [
        { mintUrl: "https://mint.a", expiresAt: 1, quoteId: "qa", paidAt: 10, amount: 100 },
      ],
    };

    const t = stubTimeout();
    try {
      plugin.onReady();
      expect(t.timeouts.length).toBe(1);

      // Run one interval tick - triggers sync asynchronously
      t.timeouts[0]!.fn();

      // Wait for the sync to complete by polling runPromise
      const pluginInternal = plugin as unknown as { runPromise?: Promise<void> };
      while (pluginInternal.runPromise) {
        await pluginInternal.runPromise;
      }

      expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
      expect(calls.addExisting.length).toBe(1);
      expect(await sinceStore.get()).toBe(10);

      // Cleanup clears timeout
      await cleanup();
      expect(t.wasCleared()).toBe(true);
    } finally {
      t.restore();
    }
  });

  it("guards against overlapping timer triggers", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
      syncIntervalMs: 1000,
    });

    const { ctx } = createMockContext();
    const cleanup = plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        concurrentCalls++;
        totalCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        // Small delay to allow potential concurrent calls
        await Promise.resolve();
        concurrentCalls--;
        return [];
      },
    };

    const t = stubTimeout();
    try {
      plugin.onReady();
      expect(t.timeouts.length).toBe(1);

      // Trigger twice quickly
      t.timeouts[0]!.fn();
      t.timeouts[0]!.fn();

      // Wait for syncs to complete
      const pluginInternal = plugin as unknown as { runPromise?: Promise<void> };
      while (pluginInternal.runPromise) {
        await pluginInternal.runPromise;
      }

      // Key assertion: syncs should NEVER run concurrently
      expect(maxConcurrent).toBe(1);
      // The pending update mechanism may trigger 1-2 syncs, but not concurrent
      expect(totalCalls).toBeLessThanOrEqual(2);
      await cleanup();
    } finally {
      t.restore();
    }
  });

  it("rearms the interval after sync completion", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
      syncIntervalMs: 1000,
    });

    const { ctx } = createMockContext();
    const cleanup = plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    let resolveSync: (() => void) | undefined;
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        await new Promise<void>((resolve) => {
          resolveSync = resolve;
        });
        return [];
      },
    };

    const t = stubTimeout();
    try {
      plugin.onReady();
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();
      await Promise.resolve();

      expect(t.timeouts.length).toBe(1);

      resolveSync?.();

      const pluginInternal = plugin as unknown as { runPromise?: Promise<void> };
      while (pluginInternal.runPromise) {
        await pluginInternal.runPromise;
      }

      expect(t.timeouts.length).toBe(2);
      await cleanup();
    } finally {
      t.restore();
    }
  });
});

describe("NPCPlugin (websocket)", () => {
  it("disposes the failed subscription before reconnecting", async () => {
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      useWebsocket: true,
    });

    const { ctx } = createMockContext();
    const cleanup = plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    const unsubscribeCalls: number[] = [];
    const subscriptions: Array<{ onError?: (error: unknown) => void }> = [];

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      subscribe: (
        _onUpdate: (quoteId: string) => void,
        onError?: (error: unknown) => void,
      ) => {
        const index = subscriptions.length;
        subscriptions.push({ onError });
        unsubscribeCalls[index] = 0;

        return () => {
          unsubscribeCalls[index] += 1;
        };
      },
    };

    const t = stubTimeout();
    try {
      plugin.onReady();
      expect(subscriptions.length).toBe(1);

      subscriptions[0]?.onError?.("boom");

      expect(unsubscribeCalls[0]).toBe(1);
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();
      expect(subscriptions.length).toBe(2);

      await cleanup();
      expect(unsubscribeCalls[0]).toBe(1);
      expect(unsubscribeCalls[1]).toBe(1);
    } finally {
      t.restore();
    }
  });
});

describe("NPCPlugin (constructor validation)", () => {
  it("throws on invalid baseUrl", () => {
    expect(() => {
      new NPCPlugin("not-a-url", createMockSigner());
    }).toThrow("Invalid baseUrl");
  });

  it("accepts valid baseUrl", () => {
    expect(() => {
      new NPCPlugin("https://valid.example.com", createMockSigner());
    }).not.toThrow();
  });
});

describe("NPCPlugin (status)", () => {
  it("returns correct initial status", () => {
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner());
    const status = plugin.getStatus();

    expect(status.isInitialized).toBe(false);
    expect(status.isReady).toBe(false);
    expect(status.isSyncing).toBe(false);
    expect(status.isWebSocketConnected).toBe(false);
  });

  it("updates status after init and ready", () => {
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner());
    const { ctx } = createMockContext();

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    expect(plugin.getStatus().isInitialized).toBe(true);
    expect(plugin.getStatus().isReady).toBe(false);

    plugin.onReady();
    expect(plugin.getStatus().isReady).toBe(true);
  });
});

describe("NPCPlugin (shutdown)", () => {
  it("gracefully shuts down and waits for in-flight sync", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    let syncStarted = false;
    let syncCompleted = false;

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        syncStarted = true;
        // Small delay to simulate async work
        await new Promise<void>((resolve) => {
          const id = setTimeout(() => resolve(), 10);
          // Ensure native setTimeout is used
          if (typeof id === "number") clearTimeout(id);
          setTimeout(() => resolve(), 10);
        });
        syncCompleted = true;
        return [];
      },
    };

    // Start sync
    const syncPromise = plugin.sync();

    // Give sync a moment to start
    await new Promise((r) => setTimeout(r, 5));

    // Start shutdown (should wait for sync)
    const shutdownPromise = plugin.shutdown();

    // Both should complete
    await Promise.all([syncPromise, shutdownPromise]);

    expect(syncStarted).toBe(true);
    expect(syncCompleted).toBe(true);
  });
});
