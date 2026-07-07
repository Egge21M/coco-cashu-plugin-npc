import { describe, expect, it } from "bun:test";
import { PluginApi } from "../src/PluginApi";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import { createMockServices, createMockSigner } from "./helpers";

describe("PluginApi", () => {
  it("delegates sync to the provided callback", async () => {
    let synced = false;
    const api = new PluginApi(
      {} as never,
      {} as never,
      async () => {
        synced = true;
        return {
          since: 0,
          newSince: 0,
          importedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          blockedQuotes: [],
          failedQuotes: [],
        };
      },
      () => ({
        isInitialized: true,
        isReady: true,
        isSyncing: false,
        isWebSocketConnected: false,
        blockedQuotes: [],
      }),
      () => ({
        since: 0,
        newSince: 0,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        blockedQuotes: [],
        failedQuotes: [],
      }),
    );

    await api.sync();

    expect(synced).toBe(true);
  });

  it("exposes plugin sync through the registered extension", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { calls, services } = createMockServices({
      trustedMintUrls: ["https://mint.a"],
    });
    let extension: PluginApi | undefined;
    const ctx = {
      services,
      registerExtension: (name: string, api: unknown) => {
        expect(name).toBe("npc");
        extension = api as PluginApi;
      },
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
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

    expect(extension).toBeDefined();

    await extension?.sync();

    expect(calls.addMintByUrl).toEqual([]);
    expect(calls.importQuote.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("waits for plugin readiness before running extension sync", async () => {
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner());

    const { services } = createMockServices();
    let extension: PluginApi | undefined;
    const ctx = {
      services,
      registerExtension: (_name: string, api: unknown) => {
        extension = api as PluginApi;
      },
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    let called = false;
    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => {
        called = true;
        return [];
      },
    };

    let settled = false;
    const syncPromise = extension?.sync().then(() => {
      settled = true;
    });

    await Promise.resolve();

    expect(called).toBe(false);
    expect(settled).toBe(false);

    plugin.onReady();

    await syncPromise;

    expect(called).toBe(true);
    expect(settled).toBe(true);
  });

  it("delegates NPC account settings updates to the SDK client", async () => {
    const calls = {
      setMintUrl: [] as string[],
      setLock: [] as boolean[],
    };
    const api = new PluginApi(
      {} as never,
      {
        settings: {
          setMintUrl: async (mintUrl: string) => {
            calls.setMintUrl.push(mintUrl);
            return { user: { mintUrl } };
          },
          setLock: async (lock: boolean) => {
            calls.setLock.push(lock);
            return { user: { lock } };
          },
        },
      } as never,
      async () => ({
        since: 0,
        newSince: 0,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        blockedQuotes: [],
        failedQuotes: [],
      }),
      () => ({
        isInitialized: true,
        isReady: true,
        isSyncing: false,
        isWebSocketConnected: false,
        blockedQuotes: [],
      }),
      () => ({
        since: 0,
        newSince: 0,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        blockedQuotes: [],
        failedQuotes: [],
      }),
    );

    const mintResult = await api.setMintUrl("https://mint.example.com");
    const lockResult = await api.setLockQuotes(true);

    expect(calls.setMintUrl).toEqual(["https://mint.example.com"]);
    expect(calls.setLock).toEqual([true]);
    expect(mintResult).toEqual({ user: { mintUrl: "https://mint.example.com" } });
    expect(lockResult).toEqual({ user: { lock: true } });
  });
});
