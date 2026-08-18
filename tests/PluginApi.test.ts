import { describe, expect, it } from "bun:test";
import { PaymentRequiredError } from "npubcash-sdk";

import { NPCPluginApi } from "../src/PluginApi";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import {
  createMockContext,
  createMockServices,
  createMockSigner,
  getAccountRuntime,
  stubTimeout,
} from "./helpers";

describe("NPCPluginApi", () => {
  function makePaymentRequiredError(): PaymentRequiredError {
    return new PaymentRequiredError("payment required", {
      toEncodedRequest: () => "creq-test",
    } as unknown as ConstructorParameters<typeof PaymentRequiredError>[1]);
  }

  it("adds an account and returns an account API", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    expect(account.id).toBe("account-1");
    expect(typeof account.sync).toBe("function");
  });

  it("forces username payment requests through inband execution and submits the token", async () => {
    const plugin = new NPCPlugin();
    const { services } = createMockServices();
    const prepareRequests: unknown[] = [];
    const submittedTokens: string[] = [];

    services.paymentRequestService = {
      parse: async () => ({
        paymentRequest: {},
        payableMints: ["https://mint.a"],
        allowedMints: [],
        unit: "sat",
        transport: { type: "http", url: "https://merchant.example.com/pr" },
      }),
      prepare: async (request: unknown) => {
        prepareRequests.push(request);
        return { request, sendOperation: { id: "send-1" } };
      },
      execute: async (tx: { request: unknown }) => {
        expect(tx.request).toMatchObject({ transport: { type: "inband" } });
        return {
          type: "inband",
          token: { mint: "https://mint.a", proofs: [] },
          operation: { id: "send-1", state: "pending" },
          request: tx.request,
        };
      },
    };

    const ctx = {
      services,
      registerExtension: () => {},
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    const runtime = getAccountRuntime(plugin);
    let calls = 0;
    (runtime as unknown as { client: unknown }).client = {
      setUsername: async (_username: string, token?: string) => {
        calls += 1;
        if (!token) {
          throw makePaymentRequiredError();
        }
        submittedTokens.push(token);
      },
    };

    await expect(account.setUsername("alice", true)).resolves.toEqual({
      success: true,
    });

    expect(calls).toBe(2);
    expect(prepareRequests).toHaveLength(1);
    expect(prepareRequests[0]).toMatchObject({
      transport: { type: "inband" },
    });
    expect(submittedTokens).toEqual([
      "cashuBo2Ftbmh0dHBzOi8vbWludC5hYXVjc2F0YXSA",
    ]);
  });

  it("does not execute username payment requests when no payable mint exists", async () => {
    const plugin = new NPCPlugin();
    const { services } = createMockServices();
    let prepared = false;
    let executed = false;

    services.paymentRequestService = {
      parse: async () => ({
        paymentRequest: {},
        payableMints: [],
        allowedMints: [],
        unit: "sat",
        transport: { type: "inband" },
      }),
      prepare: async () => {
        prepared = true;
        return {};
      },
      execute: async () => {
        executed = true;
        return {};
      },
    };

    const ctx = {
      services,
      registerExtension: () => {},
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    const runtime = getAccountRuntime(plugin);
    (runtime as unknown as { client: unknown }).client = {
      setUsername: async () => {
        throw makePaymentRequiredError();
      },
    };

    const result = await account.setUsername("alice", true);

    expect(result.success).toBe(false);
    expect(prepared).toBe(false);
    expect(executed).toBe(false);
  });

  it("exposes account management through the registered extension", async () => {
    const sinceStore = new MemorySinceStore(0);
    const plugin = new NPCPlugin();

    const { calls, services } = createMockServices();
    let extension: NPCPluginApi | undefined;
    const ctx = {
      services,
      registerExtension: (name: string, api: unknown) => {
        expect(name).toBe("npc");
        extension = api as NPCPluginApi;
      },
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await extension?.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      sinceStore,
    });
    plugin.onReady();

    const runtime = getAccountRuntime(plugin);
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

    expect(extension).toBeDefined();

    await account?.sync();

    expect(calls.addMintByUrl).toEqual(["https://mint.a"]);
    expect(calls.importQuote.length).toBe(1);
    expect(await sinceStore.get()).toBe(10);
  });

  it("waits for plugin readiness before running account sync", async () => {
    const plugin = new NPCPlugin();

    const { services } = createMockServices();
    let extension: NPCPluginApi | undefined;
    const ctx = {
      services,
      registerExtension: (_name: string, api: unknown) => {
        extension = api as NPCPluginApi;
      },
    };

    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const account = await extension?.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
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
    const syncPromise = account?.sync().then(() => {
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

  it("lists registered accounts including stopped accounts", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    const account = await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    plugin.onReady();

    await account.stop();

    expect(plugin.getAccount("account-1")).toBe(account);
    expect(plugin.listAccounts()).toEqual([
      {
        id: "account-1",
        baseUrl: "https://npc.example.com",
        autoStart: true,
        isReady: true,
        isRunning: false,
        isSyncing: false,
        isWebSocketConnected: false,
        isShutdown: false,
        useWebsocket: false,
      },
    ]);
  });

  it("removeAccount stops and removes the runtime", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    plugin.onReady();

    await plugin.removeAccount("account-1");

    expect(plugin.getAccount("account-1")).toBeUndefined();
    expect(plugin.listAccounts()).toEqual([]);
  });

  it("removeAccount is idempotent for missing ids", async () => {
    const plugin = new NPCPlugin();

    await expect(plugin.removeAccount("missing")).resolves.toBeUndefined();
  });

  it("syncAll starts account syncs concurrently and waits for all of them", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    await plugin.addAccount({
      id: "account-2",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    plugin.onReady();

    const active: string[] = [];
    const completed: string[] = [];
    const runtime1 = getAccountRuntime(plugin, "account-1");
    const runtime2 = getAccountRuntime(plugin, "account-2");

    (runtime1 as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        active.push("account-1");
        await Promise.resolve();
        completed.push("account-1");
        return [];
      },
    };
    (runtime2 as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        active.push("account-2");
        await Promise.resolve();
        completed.push("account-2");
        return [];
      },
    };

    await plugin.syncAll();

    expect(active.toSorted()).toEqual(["account-1", "account-2"]);
    expect(completed.toSorted()).toEqual(["account-1", "account-2"]);
  });

  it("syncAll lets one account fail without blocking another account", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    await plugin.addAccount({
      id: "account-2",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    plugin.onReady();

    const completed: string[] = [];
    const runtime1 = getAccountRuntime(plugin, "account-1");
    const runtime2 = getAccountRuntime(plugin, "account-2");

    (runtime1 as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        throw new Error("boom");
      },
    };
    (runtime2 as unknown as { client: unknown }).client = {
      getQuotesSince: async () => {
        completed.push("account-2");
        return [];
      },
    };

    await plugin.syncAll();

    expect(completed).toEqual(["account-2"]);
  });

  it("re-adding the same id with the same config returns the same account API", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    const signer = createMockSigner();
    const sinceStore = new MemorySinceStore(0);
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    const first = await plugin.addAccount({
      id: "account-1",
      signer,
      baseUrl: "https://npc.example.com",
      sinceStore,
      syncIntervalMs: 1000,
      useWebsocket: true,
      autoStart: false,
    });
    const second = await plugin.addAccount({
      id: "account-1",
      signer,
      baseUrl: "https://npc.example.com",
      sinceStore,
      syncIntervalMs: 1000,
      useWebsocket: true,
      autoStart: false,
    });

    expect(second).toBe(first);
  });

  it("idempotent re-add does not restart timers", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    const signer = createMockSigner();
    const sinceStore = new MemorySinceStore(0);
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    await plugin.addAccount({
      id: "account-1",
      signer,
      baseUrl: "https://npc.example.com",
      sinceStore,
      syncIntervalMs: 1000,
    });

    const t = stubTimeout();
    try {
      plugin.onReady();
      expect(t.timeouts.length).toBe(1);

      await plugin.addAccount({
        id: "account-1",
        signer,
        baseUrl: "https://npc.example.com",
        sinceStore,
        syncIntervalMs: 1000,
      });

      expect(t.timeouts.length).toBe(1);
    } finally {
      t.restore();
    }
  });

  it("idempotent re-add does not recreate factory since stores", async () => {
    let factoryCalls = 0;
    const signer = createMockSigner();
    const plugin = new NPCPlugin({
      defaultBaseUrl: "https://npc.example.com",
      sinceStoreFactory: () => {
        factoryCalls += 1;
        return new MemorySinceStore(0);
      },
    });
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({ id: "account-1", signer });
    await plugin.addAccount({ id: "account-1", signer });

    expect(factoryCalls).toBe(1);
  });

  it("throws when the same id is re-added with conflicting config", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    const signer = createMockSigner();

    await plugin.addAccount({
      id: "account-1",
      signer,
      baseUrl: "https://npc.example.com",
    });

    await expect(
      plugin.addAccount({
        id: "account-1",
        signer: createMockSigner(),
        baseUrl: "https://npc.example.com",
      }),
    ).rejects.toThrow("already exists with different configuration");
    await expect(
      plugin.addAccount({
        id: "account-1",
        signer,
        baseUrl: "https://other.example.com",
      }),
    ).rejects.toThrow("already exists with different configuration");
    await expect(
      plugin.addAccount({
        id: "account-1",
        signer,
        baseUrl: "https://npc.example.com",
        autoStart: false,
      }),
    ).rejects.toThrow("already exists with different configuration");
  });

  it("uses explicit sinceStore for one account", async () => {
    const sinceStore = new MemorySinceStore(42);
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      sinceStore,
    });

    expect(getAccountRuntime(plugin).sinceStore).toBe(sinceStore);
  });

  it("sinceStoreFactory receives account id and base URL", async () => {
    const calls: Array<{ id: string; baseUrl: string }> = [];
    const plugin = new NPCPlugin({
      sinceStoreFactory: (id, baseUrl) => {
        calls.push({ id, baseUrl });
        return new MemorySinceStore(0);
      },
    });
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    expect(calls).toEqual([
      {
        id: "account-1",
        baseUrl: "https://npc.example.com",
      },
    ]);
  });

  it("two accounts do not share fallback stores", async () => {
    const plugin = new NPCPlugin();
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });
    await plugin.addAccount({
      id: "account-2",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    const store1 = getAccountRuntime(plugin, "account-1").sinceStore;
    const store2 = getAccountRuntime(plugin, "account-2").sinceStore;

    expect(store1).not.toBe(store2);
  });

  it("persists account metadata on add and remove", async () => {
    const records: unknown[] = [];
    const removed: string[] = [];
    const plugin = new NPCPlugin({
      accountStore: {
        list: async () => [],
        upsert: async (record) => {
          records.push(record);
        },
        remove: async (accountId) => {
          removed.push(accountId);
        },
      },
    });
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await plugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
      syncIntervalMs: 1000,
      useWebsocket: true,
      autoStart: false,
    });
    await plugin.removeAccount("account-1");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "account-1",
      baseUrl: "https://npc.example.com",
      syncIntervalMs: 1000,
      useWebsocket: true,
      autoStart: false,
    });
    expect(removed).toEqual(["account-1"]);
  });

  it("store failures fail add and remove clearly", async () => {
    const plugin = new NPCPlugin({
      accountStore: {
        list: async () => [],
        upsert: async () => {
          throw new Error("upsert failed");
        },
        remove: async () => {},
      },
    });
    const { ctx } = createMockContext();
    plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);

    await expect(
      plugin.addAccount({
        id: "account-1",
        signer: createMockSigner(),
        baseUrl: "https://npc.example.com",
      }),
    ).rejects.toThrow("upsert failed");
    expect(plugin.getAccount("account-1")).toBeUndefined();

    const removePlugin = new NPCPlugin({
      accountStore: {
        list: async () => [],
        upsert: async () => {},
        remove: async () => {
          throw new Error("remove failed");
        },
      },
    });
    removePlugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
    await removePlugin.addAccount({
      id: "account-1",
      signer: createMockSigner(),
      baseUrl: "https://npc.example.com",
    });

    await expect(removePlugin.removeAccount("account-1")).rejects.toThrow(
      "remove failed",
    );
    expect(removePlugin.getAccount("account-1")).toBeDefined();
  });
});
