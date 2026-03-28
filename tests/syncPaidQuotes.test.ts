import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { createMockSigner, makeQuotes } from "./helpers";

describe("NPCPlugin sync mapping", () => {
  it("groups quotes by mintUrl, forwards to services, and updates since", async () => {
    const calls = {
      addMintByUrl: [] as string[],
      importQuote: [] as { url: string; quote: unknown }[],
      setSince: [] as number[],
    };

    const sinceStore = {
      get: async () => 0,
      set: async (since: number) => {
        calls.setSince.push(since);
      },
    };

    const plugin = new NPCPlugin(
      "https://npc.example.com",
      createMockSigner(),
      {
        sinceStore,
      },
    );

    const ctx = {
      services: {
        mintService: {
          addMintByUrl: async (url: string) => {
            calls.addMintByUrl.push(url);
          },
        },
        mintOperationService: {
          getOperationByQuote: async () => undefined,
          importQuote: async (url: string, quote: unknown) => {
            calls.importQuote.push({ url, quote });
          },
        },
        paymentRequestService: {},
      },
      registerExtension: () => {},
    };

    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => makeQuotes(),
    };

    await plugin.sync();

    // Both mints should be added (order may vary due to Promise.all)
    expect(calls.addMintByUrl.sort()).toEqual([
      "https://mint.a",
      "https://mint.b",
    ]);

    const groupA = calls.importQuote.filter((g) => g.url === "https://mint.a");
    const groupB = calls.importQuote.filter((g) => g.url === "https://mint.b");

    expect(groupA.length).toBe(2);
    expect(groupB.length).toBe(1);

    // Check transformed quote structure
    const firstQuote = groupA[0]?.quote as Record<string, unknown>;
    expect(firstQuote.unit).toBe("sat");
    expect(firstQuote.state).toBe("PAID");
    expect(firstQuote.expiry).toBe(firstQuote.expiresAt);
    expect(firstQuote.quote).toBe(firstQuote.quoteId);

    // Should update to the max paidAt value
    expect(calls.setSince).toEqual([200]);
  });

  it("no-op when no quotes returned", async () => {
    let setCalled = false;
    const sinceStore = {
      get: async () => 123,
      set: async () => {
        setCalled = true;
      },
    };

    const plugin = new NPCPlugin(
      "https://npc.example.com",
      createMockSigner(),
      {
        sinceStore,
      },
    );

    const ctx = {
      services: {
        mintService: { addMintByUrl: async () => {} },
        mintOperationService: {
          getOperationByQuote: async () => undefined,
          importQuote: async () => {},
        },
        paymentRequestService: {},
      },
      registerExtension: () => {},
    };

    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => [],
    };

    await plugin.sync();

    expect(setCalled).toBe(false);
  });

  it("skips invalid quotes and logs warning", async () => {
    const warnings: unknown[] = [];
    const sinceStore = {
      get: async () => 0,
      set: async () => {},
    };

    const plugin = new NPCPlugin(
      "https://npc.example.com",
      createMockSigner(),
      {
        sinceStore,
        logger: {
          warn: (data: unknown) => {
            warnings.push(data);
          },
          error: () => {},
          info: () => {},
          debug: () => {},
        },
      },
    );

    const calls = {
      importQuote: [] as { url: string; quote: unknown }[],
    };

    const ctx = {
      services: {
        mintService: { addMintByUrl: async () => {} },
        mintOperationService: {
          getOperationByQuote: async () => undefined,
          importQuote: async (url: string, quote: unknown) => {
            calls.importQuote.push({ url, quote });
          },
        },
        paymentRequestService: {},
      },
      registerExtension: () => {},
    };

    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => [
        // Valid quote
        {
          mintUrl: "https://mint.a",
          quoteId: "q1",
          paidAt: 100,
          expiresAt: 200,
          amount: 50,
        },
        // Invalid: missing quoteId
        { mintUrl: "https://mint.a", paidAt: 100 },
        // Invalid: bad mintUrl
        { mintUrl: "not-a-url", quoteId: "q2", paidAt: 100 },
      ],
    };

    await plugin.sync();

    // Only the valid quote should be processed
    expect(calls.importQuote.length).toBe(1);

    // Should have logged warnings for invalid quotes
    expect(warnings.length).toBe(2);
  });

  it("advances since only to the safe watermark and skips already-tracked retries", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const calls = {
      lookupQuote: [] as string[],
      importAttempt: [] as string[],
      importQuote: [] as { url: string; quote: Record<string, unknown> }[],
      setSince: [] as number[],
    };
    const trackedQuotes = new Map<
      string,
      { id: string; state: "finalized" | "failed" }
    >();

    const sinceStore = {
      current: 100,
      get: async () => sinceStore.current,
      set: async (since: number) => {
        sinceStore.current = since;
        calls.setSince.push(since);
      },
    };

    const plugin = new NPCPlugin(
      "https://npc.example.com",
      createMockSigner(),
      {
        sinceStore,
        logger: {
          warn: (data: unknown) => {
            warnings.push(String(data));
          },
          error: (data: unknown) => {
            errors.push(String(data));
          },
          info: () => {},
          debug: () => {},
        },
      },
    );

    const ctx = {
      services: {
        mintService: {
          addMintByUrl: async () => {},
        },
        mintOperationService: {
          getOperationByQuote: async (_url: string, quoteId: string) => {
            calls.lookupQuote.push(quoteId);
            return trackedQuotes.get(quoteId);
          },
          importQuote: async (url: string, quote: unknown) => {
            const record = quote as Record<string, unknown>;
            calls.importAttempt.push(String(record.quoteId));
            if (record.quoteId === "q2") {
              throw new Error("boom");
            }
            trackedQuotes.set(String(record.quoteId), {
              id: `op-${String(record.quoteId)}`,
              state: "finalized",
            });
            calls.importQuote.push({
              url,
              quote: record,
            });
          },
        },
        paymentRequestService: {},
      },
      registerExtension: () => {},
    };

    plugin.onInit(ctx as Parameters<typeof plugin.onInit>[0]);
    plugin.onReady();

    (plugin as unknown as { npcClient: unknown }).npcClient = {
      getQuotesSince: async () => [
        {
          mintUrl: "https://mint.a",
          expiresAt: 1,
          quoteId: "stale",
          paidAt: 100,
          amount: 25,
        },
        {
          mintUrl: "https://mint.a",
          expiresAt: 2,
          quoteId: "q1",
          paidAt: 110,
          amount: 100,
        },
        {
          mintUrl: "https://mint.a",
          expiresAt: 3,
          quoteId: "q2",
          paidAt: 150,
          amount: 200,
        },
        {
          mintUrl: "https://mint.b",
          expiresAt: 4,
          quoteId: "q3",
          paidAt: 200,
          amount: 300,
        },
      ],
    };

    await plugin.sync();

    expect(calls.importQuote.map((entry) => entry.quote.quoteId)).toEqual([
      "q1",
      "q3",
    ]);
    expect(calls.importAttempt.toSorted()).toEqual(["q1", "q2", "q3"]);
    expect(calls.lookupQuote.toSorted()).toEqual(["q1", "q2", "q3"]);
    expect(calls.setSince).toEqual([110]);
    expect(warnings.some((message) => message.includes("Sync completed with quote failures"))).toBe(true);
    expect(errors.some((message) => message.includes("Failed to import quote"))).toBe(true);

    calls.lookupQuote = [];
    calls.importAttempt = [];
    calls.importQuote = [];

    await plugin.sync();

    expect(calls.lookupQuote.toSorted()).toEqual(["q2", "q3"]);
    expect(calls.importAttempt).toEqual(["q2"]);
    expect(calls.importQuote).toEqual([]);
    expect(calls.setSince).toEqual([110]);
  });
});
