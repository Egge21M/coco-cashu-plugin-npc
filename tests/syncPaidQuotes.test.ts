import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { createMockSigner, makeQuotes } from "./helpers";

describe("NPCPlugin sync mapping", () => {
  it("groups quotes by mintUrl, forwards to services, and updates since", async () => {
    const calls = {
      addMintByUrl: [] as string[],
      addExisting: [] as { url: string; list: unknown[] }[],
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
        mintQuoteService: {
          addExistingMintQuotes: async (url: string, list: unknown[]) => {
            calls.addExisting.push({ url, list });
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

    const groupA = calls.addExisting.find((g) => g.url === "https://mint.a");
    const groupB = calls.addExisting.find((g) => g.url === "https://mint.b");

    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();
    expect((groupA?.list ?? []).length).toBe(2);
    expect((groupB?.list ?? []).length).toBe(1);

    // Check transformed quote structure
    const firstQuote = (groupA?.list ?? [])[0] as Record<string, unknown>;
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
        mintQuoteService: {
          addExistingMintQuotes: async () => {},
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
      addExisting: [] as { url: string; list: unknown[] }[],
    };

    const ctx = {
      services: {
        mintService: { addMintByUrl: async () => {} },
        mintQuoteService: {
          addExistingMintQuotes: async (url: string, list: unknown[]) => {
            calls.addExisting.push({ url, list });
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
    expect(calls.addExisting.length).toBe(1);
    expect((calls.addExisting[0]?.list ?? []).length).toBe(1);

    // Should have logged warnings for invalid quotes
    expect(warnings.length).toBe(2);
  });
});
