import { afterEach, describe, expect, it } from "bun:test";
import {
  createBlindSignature,
  createNewMintKeys,
  pointFromHex,
} from "@cashu/cashu-ts";
import {
  Amount,
  initializeCoco,
  MemoryRepositories,
  type InitMintOperation,
} from "@cashu/coco-core";

import { NPCPlugin } from "../src/plugins/NPCPlugin";
import { MemorySinceStore } from "../src/sync/sinceStore";
import type { Signer } from "../src/types";

const NPC_BASE_URL = "https://npc.test";
const MINT_URL = "https://mint.test";
const QUOTE_ID = "npc-quote-1";

const originalFetch = globalThis.fetch;

interface MintOutput {
  amount: number;
  B_: string;
  id: string;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function createSigner(): Signer {
  return async (template) => ({
    ...template,
    pubkey: "0".repeat(64),
    id: "1".repeat(64),
    sig: "2".repeat(128),
  });
}

function parseMintOutputs(body: unknown): MintOutput[] {
  if (
    typeof body !== "object" ||
    body === null ||
    !("outputs" in body) ||
    !Array.isArray(body.outputs)
  ) {
    throw new Error("Invalid mint request: missing outputs array");
  }

  return body.outputs.map((output, index) => {
    if (
      typeof output !== "object" ||
      output === null ||
      !("amount" in output) ||
      typeof output.amount !== "number" ||
      !Number.isSafeInteger(output.amount) ||
      output.amount <= 0 ||
      !("B_" in output) ||
      typeof output.B_ !== "string" ||
      !("id" in output) ||
      typeof output.id !== "string"
    ) {
      throw new Error(`Invalid mint request output at index ${index}`);
    }

    return {
      amount: output.amount,
      B_: output.B_,
      id: output.id,
    };
  });
}

function createTestMintFetch(): typeof fetch {
  const keyset = createNewMintKeys(6, new Uint8Array(32).fill(9));
  const keys = Object.fromEntries(
    Object.entries(keyset.pubKeys).map(([amount, key]) => [
      amount,
      Buffer.from(key).toString("hex"),
    ]),
  );
  let isIssued = false;

  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? input.toString());
    const method = request?.method ?? init?.method ?? "GET";

    if (url.pathname === "/v1/info") {
      return jsonResponse({
        name: "NPC integration test mint",
        version: "test/1.0.0",
        nuts: {
          4: {
            methods: [
              {
                method: "bolt11",
                unit: "sat",
                min_amount: 1,
                max_amount: 1_000,
              },
            ],
          },
        },
      });
    }

    if (url.pathname === "/v1/keysets") {
      return jsonResponse({
        keysets: [
          {
            id: keyset.keysetId,
            unit: "sat",
            active: true,
            input_fee_ppk: 0,
          },
        ],
      });
    }

    if (url.pathname.startsWith("/v1/keys")) {
      return jsonResponse({
        keysets: [
          {
            id: keyset.keysetId,
            unit: "sat",
            keys,
          },
        ],
      });
    }

    if (
      method === "GET" &&
      url.pathname === `/v1/mint/quote/bolt11/${QUOTE_ID}`
    ) {
      return jsonResponse({
        quote: QUOTE_ID,
        request: "lnbc-test",
        amount: 32,
        unit: "sat",
        state: isIssued ? "ISSUED" : "PAID",
        expiry: 2_000,
      });
    }

    if (method === "POST" && url.pathname === "/v1/mint/bolt11") {
      const body: unknown = request
        ? await request.json()
        : JSON.parse(String(init?.body));
      const outputs = parseMintOutputs(body);
      const signatures = outputs.map((output) => {
        const privateKey = keyset.privKeys[String(output.amount)];
        if (!privateKey) {
          throw new Error(`Missing mint key for amount ${output.amount}`);
        }

        const signature = createBlindSignature(
          pointFromHex(output.B_),
          privateKey,
          output.amount,
          keyset.keysetId,
        );

        return {
          id: signature.id,
          amount: signature.amount,
          C_: signature.C_.toHex(true),
        };
      });

      isIssued = true;
      return jsonResponse({ signatures });
    }

    throw new Error(`Unexpected mint request: ${method} ${url}`);
  };
}

function installExternalFetch(): {
  authRequests: number;
  quoteRequests: number;
} {
  const mintFetch = createTestMintFetch();
  const npcRequests = {
    authRequests: 0,
    quoteRequests: 0,
  };

  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(
      request?.url ?? input.toString(),
    );
    const headers = new Headers(request?.headers ?? init?.headers);

    if (url.origin === NPC_BASE_URL) {
      if (url.pathname === "/api/v2/auth/nip98") {
        if (!headers.get("authorization")?.startsWith("Nostr ")) {
          return jsonResponse({ message: "Unauthorized" }, { status: 401 });
        }

        npcRequests.authRequests++;
        return jsonResponse({ data: { token: "test-token" } });
      }

      if (url.pathname === "/api/v2/wallet/quotes") {
        if (headers.get("authorization") !== "Bearer test-token") {
          return jsonResponse({ message: "Unauthorized" }, { status: 401 });
        }

        npcRequests.quoteRequests++;
        return jsonResponse({
          data: {
            quotes: [
              {
                quoteId: QUOTE_ID,
                mintUrl: MINT_URL,
                amount: 32,
                expiresAt: 2_000,
                paidAt: 1_000,
                request: "lnbc-test",
              },
            ],
          },
          metadata: { total: 1 },
        });
      }
    }

    if (url.origin === MINT_URL) {
      return mintFetch(input, init);
    }

    throw new Error(`Unexpected external request: ${url}`);
  };

  return npcRequests;
}

async function createIntegrationContext(
  repo = new MemoryRepositories(),
) {
  const npcRequests = installExternalFetch();

  const plugin = new NPCPlugin();
  const manager = await initializeCoco({
    repo,
    seedGetter: async () => new Uint8Array(64).fill(7),
    plugins: [plugin],
    watchers: {
      mintOperationWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
    },
  });
  const sinceStore = new MemorySinceStore();
  const account = await manager.ext.npc.addAccount({
    id: "wallet-main",
    signer: createSigner(),
    baseUrl: NPC_BASE_URL,
    sinceStore,
  });

  return { account, manager, npcRequests, sinceStore };
}

describe("Coco v2 integration", () => {
  it("imports and redeems an NPC quote through a real Coco manager", async () => {
    const { account, manager, npcRequests, sinceStore } =
      await createIntegrationContext();

    try {
      await account.sync();

      const quote = await manager.quotes.mint.get({
        mintUrl: MINT_URL,
        quoteId: QUOTE_ID,
      });
      const operations = await manager.ops.mint.listByQuote({
        mintUrl: MINT_URL,
        quoteId: QUOTE_ID,
      });
      const balances = await manager.wallet.balances.byMint();

      expect(quote?.state).toBe("ISSUED");
      expect(operations.map((operation) => operation.state)).toEqual([
        "finalized",
      ]);
      expect(balances[MINT_URL]?.spendable.toNumberUnsafe()).toBe(32);
      expect(npcRequests).toEqual({
        authRequests: 1,
        quoteRequests: 1,
      });
      expect(await sinceStore.get()).toBe(1_000);
    } finally {
      await manager.dispose();
    }
  });

  it("redeems a quote that already has an init mint operation", async () => {
    const repo = new MemoryRepositories();
    const existingOperation: InitMintOperation<"bolt11"> = {
      id: "existing-init-operation",
      mintUrl: MINT_URL,
      method: "bolt11",
      methodData: {},
      state: "init",
      quoteId: QUOTE_ID,
      amount: Amount.from(32),
      unit: "sat",
      createdAt: 100,
      updatedAt: 100,
    };
    const { account, manager, sinceStore } =
      await createIntegrationContext(repo);

    try {
      await repo.mintOperationRepository.create(existingOperation);
      await account.sync();

      const operation = await manager.ops.mint.get(existingOperation.id);

      expect(operation?.state).toBe("finalized");
      expect(await sinceStore.get()).toBe(1_000);
    } finally {
      await manager.dispose();
    }
  });
});
