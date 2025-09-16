### coco-cashu-plugin-npc

NPC plugin for coco-cashu-core. It bridges an NPubCash (NPC) server into the coco lifecycle by polling for newly paid quotes, converting them to `MintQuote`s, and feeding them to the core `mintQuoteService`.

- **Polls NPC for paid quotes** since a persisted timestamp
- **Groups by `mintUrl`** and forwards via `mintQuoteService.addExistingMintQuotes`
- **Configurable polling** interval, lifecycle cleanup on shutdown

#### Installation

Install the plugin and its peer dependencies in your app:

```bash
# npm
npm install coco-cashu-plugin-npc coco-cashu-core@^1.0.0-rc6
```

This package uses [`npubcash-sdk`](https://www.npmjs.com/package/npubcash-sdk) under the hood for NPC API access and JWT auth.

#### Quick start (interval-based)

```ts
import { NPCPlugin, MemorySinceStore } from "coco-cashu-plugin-npc";
import type { Logger } from "coco-cashu-core";

// Optional: pass your own SinceStore; defaults to in-memory if omitted
const sinceStore = new MemorySinceStore(0);

// Provide a signer supported by npubcash-sdk's JWTAuthProvider
// See npubcash-sdk docs for signer options
const signer: any = /* your signer */ {};

const baseUrl = "https://npc.example.com";
const logger: Logger | undefined = undefined; // optional

const plugin = new NPCPlugin(
  baseUrl,
  signer,
  sinceStore, // optional; omit to use memory
  logger,
  25_000 // optional poll interval ms (default 25s)
);

// Register with coco-cashu-core (pseudo-code)
// core.use(plugin);
```

The core will call `onInit`, at which point the plugin starts polling. When the core shuts down, the plugin cleans up its timer via `registerCleanup`.

#### How it works

On each poll cycle the plugin:

- Loads the last processed timestamp via `SinceStore.get()`
- Calls the NPC server for paid quotes since that timestamp
- Groups by `mintUrl` and forwards to `mintQuoteService.addExistingMintQuotes(mintUrl, quotes)`
- Persists the latest `paidAt` back via `SinceStore.set()`

#### API

```ts
class NPCPlugin {
  constructor(
    baseUrl: string,
    signer: any,
    sinceStore?: SinceStore,
    logger?: Logger,
    pollIntervalMs = 25_000
  );

  // Called by the core to start polling and register cleanup
  onInit(ctx: PluginContext<["mintQuoteService"]>): void | Promise<void>;
  // Called when the host is fully ready; starts the interval
  onReady(): void | Promise<void>;

  // Metadata required by coco-cashu-core
  readonly name: "npubcashPlugin";
  readonly required: ["mintQuoteService"];
}
```

- **`baseUrl`**: NPC server base URL, e.g. `https://npc.example.com`
- **`signer`**: Signer instance compatible with `npubcash-sdk` `JWTAuthProvider`
- **`sinceStore`**: Optional store for last processed NPC `paidAt` (defaults to in-memory)
- **`logger`**: Optional logger (child loggers are derived if supported)
- **`pollIntervalMs`**: Polling interval in milliseconds (default 25_000)

Required service from the host core:

- **`mintQuoteService`**: must provide `addExistingMintQuotes(mintUrl, quotes)`

#### Notes

- A reentrancy guard prevents overlapping polls; slow requests won’t stack.
- Be sure to persist `since` durably (e.g., DB) for correct resume behavior.
- Errors during polling are logged through the provided `logger` if available.

#### Development

This is a TypeScript library. The public surface is exported from `src/index.ts`:

```ts
export * from "./plugins/NPCPlugin";
export * from "./plugins/NPCOnDemandPlugin";
export * from "./sync/sinceStore";
```

Run type checks or builds using your project’s toolchain (e.g., `tsc`, `tsdown`).

#### On-demand variant (no interval)

If you prefer to control when syncing happens (e.g., on a cron job, webhook, or manual trigger), use `NPCOnDemandPlugin`. It exposes a `syncOnce()` method instead of running on an interval.

```ts
import { NPCOnDemandPlugin, MemorySinceStore } from "coco-cashu-plugin-npc";
import type { Logger } from "coco-cashu-core";

const baseUrl = "https://npc.example.com";
const signer: any = /* your signer */ {};
const logger: Logger | undefined = undefined; // optional
const sinceStore = new MemorySinceStore(0); // optional; omit to use memory

const plugin = new NPCOnDemandPlugin(baseUrl, signer, sinceStore, logger);

// Register with coco-cashu-core (pseudo-code)
// core.use(plugin);

// Trigger on demand as needed
await plugin.syncOnce();
```

API additions:

```ts
class NPCOnDemandPlugin {
  constructor(
    baseUrl: string,
    signer: any,
    sinceStore?: SinceStore,
    logger?: Logger
  );

  onInit(ctx: PluginContext<["mintQuoteService"]>): void | Promise<void>;
  onReady(): void | Promise<void>;

  // Triggers a single sync cycle
  syncOnce(): Promise<void>;

  readonly name: "npubcashPluginOnDemand";
  readonly required: ["mintQuoteService"];
}
```
