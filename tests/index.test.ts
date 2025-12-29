import { describe, it, expect } from "bun:test";
import {
  NPCPlugin,
  MemorySinceStore,
  LocalStorageSinceStore,
  QUOTE_DEFAULTS,
  isValidQuote,
  isValidUrl,
  createChildLogger,
} from "../src";
import type { SinceStore, Signer, NPCQuote, NPCPluginStatus } from "../src";

describe("index barrel exports", () => {
  it("exports NPCPlugin and SinceStore implementations", () => {
    expect(typeof NPCPlugin).toBe("function");
    expect(typeof MemorySinceStore).toBe("function");
    expect(typeof LocalStorageSinceStore).toBe("function");
  });

  it("exports type utilities", () => {
    expect(typeof isValidQuote).toBe("function");
    expect(typeof isValidUrl).toBe("function");
    expect(typeof createChildLogger).toBe("function");
  });

  it("exports QUOTE_DEFAULTS constants", () => {
    expect(QUOTE_DEFAULTS.UNIT).toBe("sat");
    expect(QUOTE_DEFAULTS.STATE_PAID).toBe("PAID");
  });

  it("MemorySinceStore works via index export", async () => {
    const store = new MemorySinceStore(7);
    expect(await store.get()).toBe(7);
    await store.set(99);
    expect(await store.get()).toBe(99);
  });
});

describe("type exports (compile-time check)", () => {
  it("SinceStore interface is usable", () => {
    const store: SinceStore = {
      get: async () => 0,
      set: async () => {},
    };
    expect(store).toBeDefined();
  });

  it("Signer interface is usable", () => {
    const signer: Signer = {
      sign: async (msg: string) => `signed:${msg}`,
    };
    expect(signer).toBeDefined();
  });

  it("NPCQuote interface is usable", () => {
    const quote: NPCQuote = {
      quoteId: "q1",
      mintUrl: "https://mint.example.com",
      amount: 100,
      expiresAt: 123456,
      paidAt: 123456,
    };
    expect(quote.quoteId).toBe("q1");
  });

  it("NPCPluginStatus interface is usable", () => {
    const status: NPCPluginStatus = {
      isInitialized: true,
      isReady: true,
      isSyncing: false,
      isWebSocketConnected: false,
    };
    expect(status.isReady).toBe(true);
  });
});

describe("isValidQuote", () => {
  it("returns true for valid quotes", () => {
    expect(
      isValidQuote({
        quoteId: "q1",
        mintUrl: "https://mint.example.com",
        paidAt: 123,
      })
    ).toBe(true);
  });

  it("returns false for null/undefined", () => {
    expect(isValidQuote(null)).toBe(false);
    expect(isValidQuote(undefined)).toBe(false);
  });

  it("returns false for missing required fields", () => {
    expect(isValidQuote({ mintUrl: "https://mint.example.com", paidAt: 123 })).toBe(false);
    expect(isValidQuote({ quoteId: "q1", paidAt: 123 })).toBe(false);
    expect(isValidQuote({ quoteId: "q1", mintUrl: "https://mint.example.com" })).toBe(false);
  });

  it("returns false for wrong types", () => {
    expect(isValidQuote({ quoteId: 123, mintUrl: "https://mint.example.com", paidAt: 123 })).toBe(false);
    expect(isValidQuote({ quoteId: "q1", mintUrl: 123, paidAt: 123 })).toBe(false);
    expect(isValidQuote({ quoteId: "q1", mintUrl: "https://mint.example.com", paidAt: "123" })).toBe(false);
  });
});

describe("isValidUrl", () => {
  it("returns true for valid URLs", () => {
    expect(isValidUrl("https://example.com")).toBe(true);
    expect(isValidUrl("http://localhost:3000")).toBe(true);
    expect(isValidUrl("https://mint.example.com/api/v1")).toBe(true);
  });

  it("returns false for invalid URLs", () => {
    expect(isValidUrl("not-a-url")).toBe(false);
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("example.com")).toBe(false);
  });
});

describe("createChildLogger", () => {
  it("returns undefined for undefined logger", () => {
    expect(createChildLogger(undefined, { module: "test" })).toBeUndefined();
  });

  it("returns original logger if no child method", () => {
    const logger = { info: () => {}, error: () => {} };
    expect(createChildLogger(logger as never, { module: "test" })).toBe(logger);
  });

  it("calls child method if available", () => {
    const childLogger = { info: () => {}, error: () => {} };
    const logger = {
      info: () => {},
      error: () => {},
      child: (bindings: Record<string, unknown>) => {
        expect(bindings.module).toBe("test");
        return childLogger;
      },
    };
    expect(createChildLogger(logger, { module: "test" })).toBe(childLogger);
  });
});
