import { describe, it, expect } from "bun:test";
import { syncPaidQuotesOnce } from "../src/sync/syncPaidQuotes";

function makeQuotes() {
  return [
    {
      mintUrl: "https://mint.a",
      expiresAt: 111,
      quoteId: "q1",
      paidAt: 50,
      extra: "x",
    },
    {
      mintUrl: "https://mint.b",
      expiresAt: 222,
      quoteId: "q2",
      paidAt: 200,
    },
    {
      mintUrl: "https://mint.a",
      expiresAt: 333,
      quoteId: "q3",
      paidAt: 150,
    },
  ];
}

describe("syncPaidQuotesOnce", () => {
  it("groups quotes by mintUrl, forwards to services, and updates since", async () => {
    const calls: any = {
      addMintByUrl: [] as string[],
      addExisting: [] as { url: string; list: any[] }[],
      setSince: [] as number[],
    };

    const npcClient = {
      getQuotesSince: async (_since: number) => makeQuotes(),
    } as any;

    const sinceStore = {
      get: async () => 0,
      set: async (since: number) => {
        calls.setSince.push(since);
      },
    } as any;

    const mintService = {
      addMintByUrl: async (url: string) => {
        calls.addMintByUrl.push(url);
      },
    } as any;

    const mintQuoteService = {
      addExistingMintQuotes: async (url: string, list: any[]) => {
        calls.addExisting.push({ url, list });
      },
    } as any;

    await syncPaidQuotesOnce({
      npcClient,
      sinceStore,
      mintQuoteService,
      mintService,
    });

    expect(calls.addMintByUrl).toEqual(["https://mint.a", "https://mint.b"]);
    const groupA = calls.addExisting.find(
      (g: any) => g.url === "https://mint.a"
    );
    const groupB = calls.addExisting.find(
      (g: any) => g.url === "https://mint.b"
    );
    expect(groupA.list.length).toBe(2);
    expect(groupB.list.length).toBe(1);

    // mapped fields
    expect(groupA.list[0].unit).toBe("sat");
    expect(groupA.list[0].state).toBe("PAID");
    expect(groupA.list[0].expiry).toBe(groupA.list[0].expiresAt);
    expect(groupA.list[0].quote).toBe(groupA.list[0].quoteId);

    // since updated to max paidAt (200)
    expect(calls.setSince).toEqual([200]);
  });

  it("no-op when no quotes returned", async () => {
    const npcClient = { getQuotesSince: async () => [] } as any;
    let setCalled = false;
    const sinceStore = {
      get: async () => 123,
      set: async (_: number) => {
        setCalled = true;
      },
    } as any;
    const mintService = { addMintByUrl: async (_: string) => {} } as any;
    const mintQuoteService = {
      addExistingMintQuotes: async (_: string, __: any[]) => {},
    } as any;

    await syncPaidQuotesOnce({
      npcClient,
      sinceStore,
      mintQuoteService,
      mintService,
    });

    expect(setCalled).toBe(false);
  });
});
