import { describe, it, expect } from "bun:test";
import { NPCOnDemandPlugin } from "../src/plugins/NPCOnDemandPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";

describe("NPCOnDemandPlugin", () => {
  it("runs a single sync cycle when syncOnce is called", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCOnDemandPlugin(
      "https://npc.example.com",
      {} as any,
      sinceStore,
    );

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

    await plugin.syncOnce();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("prevents overlapping syncOnce runs", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCOnDemandPlugin(
      "https://npc.example.com",
      {} as any,
      sinceStore,
    );

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
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    } as any;

    const p1 = plugin.syncOnce();
    const p2 = plugin.syncOnce();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });
});
