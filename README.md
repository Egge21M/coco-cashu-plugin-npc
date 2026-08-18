# coco-cashu-plugin-npc

`coco-cashu-plugin-npc` integrates one or more NPubCash accounts with
`@cashu/coco-core`. It syncs paid quotes from NPC servers, imports them as
coco mint quotes, and redeems them through the host's mint operation service.

- Polls NPC for paid quotes since a per-account persisted timestamp
- Optionally listens for realtime websocket updates per account
- Groups quotes by `mintUrl` before importing and redeeming them through coco
- Exposes an account-aware `npc` extension API for account management, username
  management, quote inspection, and manual sync

## Installation

```bash
bun add coco-cashu-plugin-npc
```

Install the required peer dependencies in the host app as well:

```bash
bun add @cashu/coco-core@^2.0.0 typescript
```

This package uses `npubcash-sdk` internally for NPC API access and JWT auth.

Upgrading from v2? See [Migrating To v3](docs/migrating-to-v3.md).

## Quick Start

```ts
import { NPCPlugin, MemorySinceStore } from "coco-cashu-plugin-npc";

const plugin = new NPCPlugin({
  defaultBaseUrl: "https://npubx.cash",
  syncIntervalMs: 25_000,
  useWebsocket: true,
});

// core.use(plugin)

const account = await core.extensions.npc.addAccount({
  id: "wallet-main",
  signer,
  sinceStore: new MemorySinceStore(0),
});

await account.sync();
```

The host calls `onInit()` during plugin registration and `onReady()` when
services are ready. The plugin registers `manager.ext.npc` immediately, even
with zero accounts. Accounts can then sync from interval timers, websocket
notifications, or manual account-level `sync()` calls.

## Configuration

`NPCPlugin` accepts plugin-level defaults:

```ts
interface NPCPluginOptions {
  defaultBaseUrl?: string;
  accountStore?: NPCAccountStore;
  sinceStoreFactory?: NPCSinceStoreFactory;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  logger?: Logger;
}
```

- `defaultBaseUrl`: NPC server URL used when an account does not provide one
- `accountStore`: optional host-owned store for account metadata
- `sinceStoreFactory`: optional factory for per-account `SinceStore` instances
- `syncIntervalMs`: default polling interval in milliseconds; omit to disable interval syncing
- `useWebsocket`: default websocket setting for new account runtimes
- `logger`: optional logger used by the plugin and derived child loggers

`NPCPluginOptions` no longer accepts a signer or a single `sinceStore`. Signers
and explicit stores are supplied per account.

## Extension API

When the plugin is initialized it registers the root `npc` extension on the
host. The root extension manages accounts:

```ts
const npc = core.extensions.npc;

const account = await npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl: "https://npubx.cash",
  syncIntervalMs: 60_000,
  useWebsocket: true,
});

await npc.syncAll();

const sameAccount = npc.getAccount("wallet-main");
await sameAccount?.getInfo();
```

Available root methods:

- `addAccount(options)`: create or return an account runtime
- `removeAccount(accountId)`: stop and remove an account runtime
- `getAccount(accountId)`: return one account API if registered
- `listAccounts()`: list registered accounts, including stopped accounts
- `getStatus()`: summarize registry and runtime state
- `syncAll()`: run all account syncs concurrently
- `shutdownAccount(accountId)`: shut down one account runtime without removing it

Each account exposes the operations that were global in v2:

```ts
await account.getInfo();
await account.getQuotesSince(0);
await account.sync();

const result = await account.setUsername("alice", true);
if (!result.success) {
  console.log(result.pr);
}
```

Available account methods:

- `getInfo()`: fetch authenticated NPC account metadata
- `setUsername(username, attemptPayment?)`: set the NPC username and optionally handle the payment-required flow through coco
- `getQuotesSince(sinceUnix)`: inspect raw NPC quotes without importing them into coco
- `sync()`: manually trigger this account's quote sync pipeline
- `start()`: start this account's timer and websocket behavior
- `stop()`: stop this account's timer and websocket behavior
- `getStatus()`: inspect this account runtime state

The old root methods `manager.ext.npc.getInfo()`,
`manager.ext.npc.setUsername()`, `manager.ext.npc.getQuotesSince()`, and
`manager.ext.npc.sync()` were removed in v3. Use the account returned by
`addAccount()` or `manager.ext.npc.getAccount(id)`.

## Accounts And Persistence

Account ids are host-defined. The plugin does not derive ids from signers, even
when a signer can expose a public key.

```ts
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl: "https://npubx.cash",
  sinceStore,
  autoStart: true,
});
```

`addAccount()` is idempotent when the incoming configuration matches the
registered account: account id, resolved base URL, signer reference, explicit
`SinceStore` reference, interval setting, websocket setting, and `autoStart`
setting. Reusing an id with different configuration throws; remove the account
before re-adding it.

Each account resolves its `SinceStore` in this order:

1. `AddNPCAccountOptions.sinceStore`
2. plugin `sinceStoreFactory(accountId, baseUrl)`
3. a new in-memory `MemorySinceStore(0)`

`NPCAccountStore` persists account metadata only. It does not persist signer
material, and the plugin does not automatically activate stored records. Hosts
must reconstruct signer material and call `addAccount()` for the accounts they
want active.

## Sync Behavior

Each account sync cycle:

1. Reads the last processed timestamp from that account's `SinceStore`
2. Fetches paid quotes from NPC with `getQuotesSince(since)`
3. Filters out already-processed timestamps, invalid quotes, and invalid mint URLs
4. Groups valid quotes by `mintUrl`
5. Adds each mint as trusted and forwards transformed quotes to coco
6. Advances `since` to the highest contiguous `paidAt` watermark with no unresolved failures

Important behaviors:

- overlapping sync requests are serialized per account
- `syncAll()` runs accounts concurrently
- interval polling rearms after the current account sync finishes
- websocket failures are cleaned up before reconnect attempts are scheduled
- manager `pauseSubscriptions()` / `resumeSubscriptions()` lifecycle events pause
  and resume NPC websocket subscriptions for running accounts
- already-tracked quotes are skipped safely on retry
- `since` only advances to a safe watermark before the first unresolved failure

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
