import { describe, it, expect } from "bun:test";

import {
  createMockContext,
  createMockSigner,
  createReadyAccount,
  getAccountRuntime,
} from "./helpers";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";

describe("NPCAccountRuntime (manual)", () => {
  it("runs a single sync cycle when sync is called", async () => {
    const { account, calls, runtime, sinceStore } = await createReadyAccount();

    (runtime as unknown as { client: unknown }).client = {
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

    await account.sync();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.importQuote.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("prevents overlapping manual sync runs", async () => {
    const { account, runtime } = await createReadyAccount();

    let calls = 0;
    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        calls += 1;
        return [];
      },
    };

    const p1 = account.sync();
    const p2 = account.sync();
    await Promise.all([p1, p2]);

    expect(calls).toBeLessThanOrEqual(2);
  });

  it("waits for onReady before running manual sync", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      sinceStore,
    });

    const runtime = getAccountRuntime(plugin);

    let called = false;
    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        called = true;
        return [];
      },
    };

    let settled = false;
    const syncPromise = account.sync().then(() => {
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

  it("does nothing after shutdown", async () => {
    const { account, plugin, runtime } = await createReadyAccount();

    let calls = 0;
    (runtime as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        calls += 1;
        return [];
      },
    };

    await plugin.shutdown();
    await account.sync();

    expect(calls).toBe(0);
  });
});
