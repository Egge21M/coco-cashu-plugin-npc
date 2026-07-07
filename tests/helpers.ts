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
export function createMockServices(options?: {
  trustedMintUrls?: readonly string[];
}) {
  const trustedMintUrls = new Set(options?.trustedMintUrls ?? []);
  const calls = {
    addMintByUrl: [] as string[],
    addMintByUrlOptions: [] as { url: string; trusted?: boolean }[],
    ensureUpdatedMint: [] as string[],
    isTrustedMint: [] as string[],
    importQuote: [] as { url: string; quote: unknown }[],
  };

  const services = {
    mintService: {
      addMintByUrl: async (url: string, addOptions?: { trusted?: boolean }) => {
        calls.addMintByUrl.push(url);
        calls.addMintByUrlOptions.push({ url, trusted: addOptions?.trusted });
        if (addOptions?.trusted) {
          trustedMintUrls.add(url);
        }
      },
      ensureUpdatedMint: async (url: string) => {
        calls.ensureUpdatedMint.push(url);
      },
      isTrustedMint: async (url: string) => {
        calls.isTrustedMint.push(url);
        return trustedMintUrls.has(url);
      },
    },
    mintOperationService: {
      getOperationByQuote: async () => undefined,
      importQuote: async (url: string, quote: unknown) => {
        calls.importQuote.push({ url, quote });
      },
    },
    paymentRequestService: {},
  };

  return { calls, services };
}

/**
 * Creates a mock plugin context
 */
export function createMockContext(options?: {
  trustedMintUrls?: readonly string[];
}) {
  const { calls, services } = createMockServices(options);
  return {
    calls,
    ctx: {
      services,
      registerExtension: () => {},
    },
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
