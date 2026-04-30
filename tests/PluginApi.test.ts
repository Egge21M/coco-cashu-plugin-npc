import { describe, expect, it } from "bun:test";

import { NPCPluginApi } from "../src/PluginApi";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import {
  createMockContext,
  createMockServices,
  createMockSigner,
  getAccountRuntime,
} from "./helpers";

describe("NPCPluginApi", () => {
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
});
