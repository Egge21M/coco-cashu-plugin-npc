import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";

describe("NPCPlugin (manual)", () => {
  it("runs a single sync cycle when sync is called", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin("https://npc.example.com", {} as any, {
      sinceStore,
    });

    const calls: any = {
      addMintByUrl: [] as string[],
      addExisting: [] as any[],
    };
    const ctx: any = {
      services: {
        mintService: {
          addMintByUrl: async (url: string) => calls.addMintByUrl.push(url),
        },
        mintQuoteService: {
          addExistingMintQuotes: async (url: string, list: any[]) =>
            calls.addExisting.push({ url, list }),
        },
      },
      registerCleanup: () => {},
    };
    plugin.onInit(ctx);
    plugin.onReady();

    plugin.npcClient = {
      getQuotesSince: async () => [
        { mintUrl: "https://mint.a", expiresAt: 1, quoteId: "qa", paidAt: 10 },
      ],
    } as any;

    await plugin.sync();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("prevents overlapping manual sync runs", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin("https://npc.example.com", {} as any, {
      sinceStore,
    });

    const ctx: any = {
      services: {
        mintService: { addMintByUrl: async (_: string) => {} },
        mintQuoteService: {
          addExistingMintQuotes: async (_: string, __: any[]) => {},
        },
      },
      registerCleanup: () => {},
    };
    plugin.onInit(ctx);
    plugin.onReady();

    let calls = 0;
    plugin.npcClient = {
      getQuotesSince: async () => {
        calls += 1;
        return [];
      },
    } as any;

    const p1 = plugin.sync();
    const p2 = plugin.sync();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
