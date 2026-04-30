import { describe, it, expect } from "bun:test";

import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import {
  createMockContext,
  createMockSigner,
  createReadyAccount,
  getAccountRuntime,
  stubTimeout,
} from "./helpers";

describe("NPCPlugin (registry)", () => {
  it("registers with no account", () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();

    expect(() => {
      plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
      plugin.onReady();
    }).not.toThrow();

    expect(plugin.getStatus().accountCount).toBe(0);
  });

  it("registers the root extension on init", () => {
    const plugin = new NPCPlugin();
    const { services } = createMockContext().ctx;
    let extension: unknown;

    plugin.onInit({
      services,
      registerExtension: (name: string, api: unknown) => {
        expect(name).toBe("npc");
        extension = api;
      },
    } as unknown as Parameters<typeof plugin.onInit>[0]);

    expect(extension).toBeDefined();
    expect(typeof (extension as { addAccount?: unknown }).addAccount).toBe(
      "function",
    );
  });

  it("starts previously added auto-start accounts on ready", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      syncIntervalMs: 1000,
    });

    const t = stubTimeout();
    try {
      plugin.onReady();

      expect(t.timeouts.length).toBe(1);
      expect(plugin.getStatus().runningAccountIds).toEqual(["account-1"]);
    } finally {
      t.restore();
    }
  });
});

describe("NPCPlugin (interval)", () => {
  it("arms resettable timer, runs sync, and cleans up on shutdown", async () => {
    const { account, calls, plugin, runtime, sinceStore } =
      await createReadyAccount({
        autoStart: false,
        syncIntervalMs: 1000,
      });

    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => [
        {
          mintUrl: "https://mint.a",
          expiresAt: 1,
          quoteId: "qa",
          paidAt: 10,
          amount: 100,
        },
      ],
    };

    const t = stubTimeout();
    try {
      account.start();
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();

      const runtimeInternal = runtime as unknown as { runPromise?: Promise<void> };
      while (runtimeInternal.runPromise) {
        await runtimeInternal.runPromise;
      }

      expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
      expect(calls.importQuote.length).toBe(1);
      expect(await sinceStore.get()).toBe(10);

      await plugin.shutdown();
      expect(t.wasCleared()).toBe(true);
    } finally {
      t.restore();
    }
  });

  it("guards against overlapping timer triggers", async () => {
    const { account, runtime } = await createReadyAccount({
      autoStart: false,
      syncIntervalMs: 1000,
    });

    let concurrentCalls = 0;
    let maxConcurrent = 0;
    let totalCalls = 0;

    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        concurrentCalls++;
        totalCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await Promise.resolve();
        concurrentCalls--;
        return [];
      },
    };

    const t = stubTimeout();
    try {
      account.start();
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();
      t.timeouts[0]!.fn();

      const runtimeInternal = runtime as unknown as { runPromise?: Promise<void> };
      while (runtimeInternal.runPromise) {
        await runtimeInternal.runPromise;
      }

      expect(maxConcurrent).toBe(1);
      expect(totalCalls).toBeLessThanOrEqual(2);
    } finally {
      t.restore();
    }
  });

  it("rearms the interval after sync completion", async () => {
    const { account, runtime } = await createReadyAccount({
      autoStart: false,
      syncIntervalMs: 1000,
    });

    let resolveSync: (() => void) | undefined;
    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        await new Promise<void>((resolve) => {
          resolveSync = resolve;
        });
        return [];
      },
    };

    const t = stubTimeout();
    try {
      account.start();
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();
      await Promise.resolve();

      expect(t.timeouts.length).toBe(1);

      resolveSync?.();

      const runtimeInternal = runtime as unknown as { runPromise?: Promise<void> };
      while (runtimeInternal.runPromise) {
        await runtimeInternal.runPromise;
      }

      expect(t.timeouts.length).toBe(2);
    } finally {
      t.restore();
    }
  });
});

describe("NPCPlugin (websocket)", () => {
  it("disposes the failed subscription before reconnecting", async () => {
    const { account, plugin, runtime } = await createReadyAccount({
      autoStart: false,
      useWebsocket: true,
    });

    const unsubscribeCalls: number[] = [];
    const subscriptions: Array<{ onError?: (error: unknown) => void }> = [];

    (runtime as unknown as { client: unknown }).client = {
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
      account.start();
      expect(subscriptions.length).toBe(1);

      subscriptions[0]?.onError?.("boom");

      expect(unsubscribeCalls[0]).toBe(1);
      expect(t.timeouts.length).toBe(1);

      t.timeouts[0]!.fn();
      expect(subscriptions.length).toBe(2);

      await plugin.shutdown();
      expect(unsubscribeCalls[0]).toBe(1);
      expect(unsubscribeCalls[1]).toBe(1);
    } finally {
      t.restore();
    }
  });
});

describe("NPCPlugin (constructor validation)", () => {
  it("throws on invalid defaultBaseUrl", () => {
    expect(() => {
      new NPCPlugin({ defaultBaseUrl: "not-a-url" });
    }).toThrow("Invalid defaultBaseUrl");
  });

  it("accepts absent defaultBaseUrl", () => {
    expect(() => {
      new NPCPlugin();
    }).not.toThrow();
  });

  it("accepts valid defaultBaseUrl", () => {
    expect(() => {
      new NPCPlugin({ defaultBaseUrl: "https://valid.example.com" });
    }).not.toThrow();
  });
});

describe("NPCPlugin (status)", () => {
  it("returns correct initial status", () => {
    const plugin = new NPCPlugin();
    const status = plugin.getStatus();

    expect(status.isInitialized).toBe(false);
    expect(status.isReady).toBe(false);
    expect(status.accountCount).toBe(0);
    expect(status.runningAccountIds).toEqual([]);
    expect(status.syncingAccountIds).toEqual([]);
    expect(status.websocketConnectedAccountIds).toEqual([]);
  });

  it("updates status after init, account add, and ready", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    expect(plugin.getStatus().isInitialized).toBe(true);
    expect(plugin.getStatus().isReady).toBe(false);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    plugin.onReady();
    expect(plugin.getStatus().isReady).toBe(true);
    expect(plugin.getStatus().accountCount).toBe(1);
    expect(plugin.getStatus().runningAccountIds).toEqual(["account-1"]);
  });
});

describe("NPCPlugin (shutdown)", () => {
  it("gracefully shuts down and waits for in-flight sync", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      sinceStore,
    });
    plugin.onReady();

    let syncStarted = false;
    let syncCompleted = false;
    const runtime = getAccountRuntime(plugin);

    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        syncStarted = true;
        await new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 10);
        });
        syncCompleted = true;
        return [];
      },
    };

    const syncPromise = account.sync();
    await new Promise((r) => setTimeout(r, 5));
    const shutdownPromise = plugin.shutdown();

    await Promise.all([syncPromise, shutdownPromise]);

    expect(syncStarted).toBe(true);
    expect(syncCompleted).toBe(true);
  });
});
