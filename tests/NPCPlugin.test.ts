import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";

function stubTimers() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timers: { fn: () => Promise<void> | void; ms: number }[] = [];
  let clearedWith: any = undefined;
  (globalThis as any).setInterval = (fn: any, ms: number) => {
    timers.push({ fn, ms });
    return 777 as any;
  };
  (globalThis as any).clearInterval = (id: any) => {
    clearedWith = id;
  };
  function restore() {
    (globalThis as any).setInterval = originalSetInterval;
    (globalThis as any).clearInterval = originalClearInterval;
  }
  return { timers, cleared: () => clearedWith, restore };
}

describe("NPCPlugin", () => {
  it("starts interval on ready, runs sync, and cleans up on shutdown", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin(
      "https://npc.example.com",
      {} as any,
      sinceStore
    );

    // fake services & ctx
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
    };

    const initCleanup = plugin.onInit(ctx);

    // replace internal npc client with stub
    plugin.npcClient = {
      getQuotesSince: async () => [
        { mintUrl: "https://mint.a", expiresAt: 1, quoteId: "qa", paidAt: 10 },
      ],
    } as any;

    const t = stubTimers();
    plugin.onReady();
    expect(t.timers.length).toBe(1);

    // run one interval tick
    await t.timers[0]!.fn();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);

    // cleanup clears interval
    await (initCleanup as any)?.();
    expect(t.cleared()).toBe(777);
    t.restore();
  });

  it("guards against overlapping polls", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin(
      "https://npc.example.com",
      {} as any,
      sinceStore
    );

    const ctx: any = {
      services: {
        mintService: { addMintByUrl: async (_: string) => {} },
        mintQuoteService: {
          addExistingMintQuotes: async (_: string, __: any[]) => {},
        },
      },
    };
    const initCleanup = plugin.onInit(ctx);

    let calls = 0;
    plugin.npcClient = {
      getQuotesSince: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return [];
      },
    } as any;

    const t = stubTimers();
    plugin.onReady();
    expect(t.timers.length).toBe(1);

    const p1 = t.timers[0]!.fn();
    const p2 = t.timers[0]!.fn();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    await (initCleanup as any)?.();
    t.restore();
  });
});
