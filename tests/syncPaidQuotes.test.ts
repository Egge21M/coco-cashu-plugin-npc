import { describe, it, expect } from "bun:test";
import { NPCPlugin } from "../src/plugins/NPCPlugin";

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

describe("NPCPlugin sync mapping", () => {
  it("groups quotes by mintUrl, forwards to services, and updates since", async () => {
    const calls: any = {
      addMintByUrl: [] as string[],
      addExisting: [] as { url: string; list: any[] }[],
      setSince: [] as number[],
    };

    const sinceStore = {
      get: async () => 0,
      set: async (since: number) => {
        calls.setSince.push(since);
      },
    } as any;

    const plugin: any = new NPCPlugin("https://npc.example.com", {} as any, {
      sinceStore,
    });

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
    plugin.onInit(ctx);
    plugin.onReady();

    plugin.npcClient = {
      getQuotesSince: async (_since: number) => makeQuotes(),
    } as any;

    await plugin.sync();

    expect(calls.addMintByUrl).toEqual(["https://mint.a", "https://mint.b"]);
    const groupA = calls.addExisting.find(
      (g: any) => g.url === "https://mint.a"
    );
    const groupB = calls.addExisting.find(
      (g: any) => g.url === "https://mint.b"
    );
    expect(groupA.list.length).toBe(2);
    expect(groupB.list.length).toBe(1);

    expect(groupA.list[0].unit).toBe("sat");
    expect(groupA.list[0].state).toBe("PAID");
    expect(groupA.list[0].expiry).toBe(groupA.list[0].expiresAt);
    expect(groupA.list[0].quote).toBe(groupA.list[0].quoteId);

    expect(calls.setSince).toEqual([200]);
  });

  it("no-op when no quotes returned", async () => {
    let setCalled = false;
    const sinceStore = {
      get: async () => 123,
      set: async (_: number) => {
        setCalled = true;
      },
    } as any;
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
    };
    plugin.onInit(ctx);
    plugin.onReady();

    plugin.npcClient = { getQuotesSince: async () => [] } as any;

    await plugin.sync();

    expect(setCalled).toBe(false);
  });
});
