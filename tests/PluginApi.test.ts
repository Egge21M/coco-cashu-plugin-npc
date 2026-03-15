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
      },
    );

    await api.sync();

    expect(synced).toBe(true);
  });

  it("exposes plugin sync through the registered extension", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin("https://npc.example.com", createMockSigner(), {
      sinceStore,
    });

    const { calls, services } = createMockServices();
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

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
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
});
