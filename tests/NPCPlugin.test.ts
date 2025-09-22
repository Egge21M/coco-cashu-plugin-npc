import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";

function stubTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeouts: { fn: () => Promise<void> | void; ms: number }[] = [];
  let cleared = false;
  (globalThis as any).setTimeout = (fn: any, ms: number) => {
    timeouts.push({ fn, ms });
    return 888 as any;
  };
  (globalThis as any).clearTimeout = (_: any) => {
    cleared = true;
  };
  function restore() {
    (globalThis as any).setTimeout = originalSetTimeout;
    (globalThis as any).clearTimeout = originalClearTimeout;
  }
  return { timeouts, wasCleared: () => cleared, restore };
}

describe("NPCPlugin (interval)", () => {
  it("arms resettable timer, runs sync, and cleans up on shutdown", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin("https://npc.example.com", {} as any, {
      sinceStore,
      syncIntervalMs: 1000,
    });

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

    const t = stubTimeout();
    plugin.onReady();
    expect(t.timeouts.length).toBe(1);

    // run one interval tick
    await t.timeouts[0]!.fn();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.addExisting.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);

    // cleanup clears timeout
    await (initCleanup as any)?.();
    expect(t.wasCleared()).toBe(true);
    t.restore();
  });

  it("guards against overlapping timer triggers", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin: any = new NPCPlugin("https://npc.example.com", {} as any, {
      sinceStore,
      syncIntervalMs: 1000,
    });

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
        // No timer-based delay here, because setTimeout is stubbed in this test
        // and would otherwise prevent the promise from resolving.
        return [];
      },
    } as any;

    const t = stubTimeout();
    plugin.onReady();
    expect(t.timeouts.length).toBe(1);

    const p1 = t.timeouts[0]!.fn();
    const p2 = t.timeouts[0]!.fn();
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    await (initCleanup as any)?.();
    t.restore();
  });
});
