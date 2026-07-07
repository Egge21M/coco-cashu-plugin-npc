# coco-cashu-plugin-npc

`coco-cashu-plugin-npc` integrates an NPubCash account with `coco-cashu-core`.
It syncs paid quotes from an NPC server, converts them into coco mint quotes, and
forwards them through the host's `mintOperationService`.

- Polls NPC for paid quotes since a persisted timestamp
- Optionally listens for realtime websocket updates
- Groups quotes by `mintUrl` before forwarding them to coco
- Exposes an `npc` extension API for info, username management, quote inspection, and manual sync

## Installation

```bash
bun add coco-cashu-plugin-npc
```

Install the required peer dependencies in the host app as well:

```bash
bun add coco-cashu-core typescript
```

This package uses `npubcash-sdk` internally for NPC API access and JWT auth.

## Quick Start

```ts
import { NPCPlugin, MemorySinceStore } from "coco-cashu-plugin-npc";

const baseUrl = "https://npc.example.com";
const signer: any = /* signer supported by npubcash-sdk */ {};

const plugin = new NPCPlugin(baseUrl, signer, {
  sinceStore: new MemorySinceStore(0),
  syncIntervalMs: 25_000,
  useWebsocket: true,
});

// core.use(plugin)
```

The host calls `onInit()` during plugin registration and `onReady()` when services
are ready. Once ready, the plugin can sync from its interval timer, from websocket
notifications, or from the extension API's manual `sync()` call.

## Configuration

`NPCPlugin` accepts an options object:

```ts
interface NPCPluginOptions {
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  sinceStore?: SinceStore;
  logger?: Logger;
  quoteMintPolicy?: NPCQuoteMintPolicy;
}
```

- `syncIntervalMs`: interval in milliseconds for polling; omit to disable interval syncing
- `useWebsocket`: subscribe to realtime quote updates from NPC
- `sinceStore`: persistence for the last processed `paidAt` timestamp; defaults to in-memory storage
- `logger`: optional logger used by the plugin and derived child loggers
- `quoteMintPolicy`: controls which quote mints can be imported; defaults to `{ mode: "trusted-only" }`

Quote mint policy options:

```ts
type NPCQuoteMintPolicy =
  | { mode: "trusted-only" }
  | { mode: "allow-list"; mintUrls: readonly string[] }
  | { mode: "auto-trust" };
```

- `trusted-only`: import only quotes whose mint is already trusted by the host wallet
- `allow-list`: import only listed mint URLs and cache them as untrusted when needed
- `auto-trust`: legacy opt-in behavior that adds quote mints as trusted before import

## Extension API

When the plugin is initialized it registers the `npc` extension on the host.

```ts
const npc = core.extensions.npc;

await npc.getInfo();
await npc.getQuotesSince(0);
const report = await npc.sync();
console.log(report.blockedQuotes);

await npc.setMintUrl("https://mint.example.com");
await npc.setLockQuotes(true);

const result = await npc.setUsername("alice", true);
if (!result.success) {
  console.log(result.pr);
}
```

Available methods:

- `getInfo()`: fetch authenticated NPC account metadata
- `setUsername(username, attemptPayment?)`: set the NPC username and optionally handle the payment-required flow through coco
- `getQuotesSince(sinceUnix)`: inspect raw NPC quotes without importing them into coco
- `sync()`: manually trigger the plugin's quote sync pipeline and return an `NPCSyncReport`
- `getStatus()`: inspect lifecycle state and currently blocked quote mints
- `getLastSyncReport()`: return the most recent sync report without starting a new sync
- `setMintUrl(mintUrl)`: update the NPC account's server-side mint URL
- `setLockQuotes(lock)`: enable or disable NPC server-side quote locking

`sync()` uses the same guardrails as scheduled syncing: it waits for `onReady()`,
batches overlapping calls, respects shutdown, validates quotes, groups by mint,
applies quote mint policy, and advances `since` only to the highest safe
watermark after processing.

## Sync Behavior

Each sync cycle:

1. Reads the last processed timestamp from `SinceStore`
2. Fetches paid quotes from NPC with `getQuotesSince(since)`
3. Filters out already-processed timestamps, invalid quotes, and invalid mint URLs
4. Groups valid quotes by `mintUrl`
5. Applies `quoteMintPolicy` before forwarding transformed quotes to coco
6. Reports disallowed quote mints as `blockedQuotes`
7. Advances `since` to the highest contiguous `paidAt` watermark with no unresolved failures or blocked quotes

Important behaviors:

- overlapping sync requests are serialized
- interval polling rearms after the current sync finishes
- websocket failures are cleaned up before reconnect attempts are scheduled
- already-tracked quotes are skipped safely on retry
- `since` only advances to a safe watermark before the first unresolved failure or blocked quote
- the plugin does not trust new quote mints unless `quoteMintPolicy` is explicitly set to `auto-trust`

## Public Exports

The package exports:

```ts
export * from "./plugins/NPCPlugin";
export * from "./sync/sinceStore";
export * from "./types";
export * from "./PluginApi";
```

## Development

Useful commands:

```bash
bun run typecheck
bun test
bun run build
```
