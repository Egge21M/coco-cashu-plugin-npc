import type { NPCAccountRuntime } from "../src/accounts/NPCAccountRuntime";
import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import type { Signer } from "../src/types";

/**
 * Creates a mock signer for testing
 */
export function createMockSigner(): Signer {
  return {
    sign: async (message: string) => `signed:${message}`,
  };
}

/**
 * Creates mock services for testing
 */
export function createMockServices() {
  const calls = {
    addMintByUrl: [] as string[],
    importQuote: [] as { url: string; quote: unknown }[],
    prepareMintOperation: [] as { quoteId: string; amount: unknown }[],
    executeMintOperation: [] as string[],
  };
  const eventHandlers = new Map<string, Set<(payload?: unknown) => void>>();
  const eventBus = {
    on: (event: string, handler: (payload?: unknown) => void) => {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);

      return () => {
        handlers.delete(handler);
        if (handlers.size === 0) {
          eventHandlers.delete(event);
        }
      };
    },
    emit: async (event: string, payload?: unknown) => {
      for (const handler of eventHandlers.get(event) ?? []) {
        await handler(payload);
      }
    },
    listenerCount: (event: string) => eventHandlers.get(event)?.size ?? 0,
  };

  const services = {
    mintService: {
      addMintByUrl: async (url: string) => {
        calls.addMintByUrl.push(url);
      },
    },
    mintOperationService: {
      getOperationByQuote: async () => undefined,
      prepare: async (
        quoteRef: { quoteId: string },
        amount: unknown,
      ) => {
        calls.prepareMintOperation.push({
          quoteId: quoteRef.quoteId,
          amount,
        });
        return { id: `op-${quoteRef.quoteId}`, state: "pending" };
      },
      execute: async (operationId: string) => {
        calls.executeMintOperation.push(operationId);
        return { id: operationId, state: "finalized" };
      },
    },
    quotes: {
      mint: {
        import: async (input: { mintUrl: string; quote: unknown }) => {
          calls.importQuote.push({
            url: input.mintUrl,
            quote: input.quote,
          });
        },
      },
    },
    paymentRequestService: {},
    eventBus,
  };

  return { calls, services };
}

/**
 * Creates a mock plugin context
 */
export function createMockContext() {
  const { calls, services } = createMockServices();
  return {
    calls,
    ctx: {
      services,
      registerExtension: () => {},
    },
  };
}

export function getAccountRuntime(
  plugin: NPCPlugin,
  accountId = "account-1",
): NPCAccountRuntime {
  const accounts = (
    plugin as unknown as {
      accounts: Map<string, { runtime: NPCAccountRuntime }>;
    }
  ).accounts;
  const runtime = accounts.get(accountId)?.runtime;
  if (!runtime) {
    throw new Error(`Missing runtime for ${accountId}`);
  }
  return runtime;
}

export async function createReadyAccount(options?: {
  accountId?: string;
  baseUrl?: string;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  autoStart?: boolean;
}) {
  const accountId = options?.accountId ?? "account-1";
  const sinceStore = new MemorySinceStore(0);
  const plugin = new NPCPlugin();
  const { calls, ctx } = createMockContext();

  plugin.onInit(ctx as unknown as Parameters<typeof plugin.onInit>[0]);
  const account = await plugin.addAccount({
    id: accountId,
    signer: createMockSigner(),
    baseUrl: options?.baseUrl ?? "https://npc.example.com",
    sinceStore,
    syncIntervalMs: options?.syncIntervalMs,
    useWebsocket: options?.useWebsocket,
    autoStart: options?.autoStart,
  });
  plugin.onReady();

  return {
    account,
    accountId,
    calls,
    ctx,
    plugin,
    runtime: getAccountRuntime(plugin, accountId),
    sinceStore,
  };
}

/**
 * Stubs setTimeout/clearTimeout for testing timers
 */
export function stubTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timeouts: { fn: () => Promise<void> | void; ms: number }[] = [];
  let cleared = false;

  (globalThis as Record<string, unknown>).setTimeout = (
    fn: () => void,
    ms: number
  ) => {
    timeouts.push({ fn, ms });
    return 888 as unknown as ReturnType<typeof setTimeout>;
  };

  (globalThis as Record<string, unknown>).clearTimeout = () => {
    cleared = true;
  };

  function restore() {
    (globalThis as Record<string, unknown>).setTimeout = originalSetTimeout;
    (globalThis as Record<string, unknown>).clearTimeout = originalClearTimeout;
  }

  return { timeouts, wasCleared: () => cleared, restore };
}

/**
 * Creates test quotes with valid structure
 */
export function makeQuotes() {
  return [
    {
      mintUrl: "https://mint.a",
      expiresAt: 111,
      quoteId: "q1",
      paidAt: 50,
      amount: 100,
      extra: "x",
    },
    {
      mintUrl: "https://mint.b",
      expiresAt: 222,
      quoteId: "q2",
      paidAt: 200,
      amount: 200,
    },
    {
      mintUrl: "https://mint.a",
      expiresAt: 333,
      quoteId: "q3",
      paidAt: 150,
      amount: 300,
    },
  ];
}
