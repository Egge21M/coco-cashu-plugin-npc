# NPC Plugin v3 Design

## Summary

v3 separates the coco plugin lifecycle from the NPubCash account lifecycle.
Registering the plugin with a coco host should only install the `npc` extension
and capture the required host services. It must not create an authenticated
NPubCash client, start sync timers, open websockets, or require a signer.

Accounts are added, removed, enabled, disabled, and synced at runtime through the
extension API. Each account owns its authenticated NPC client, signer, `since`
watermark, sync runner, interval timer, websocket subscription, and shutdown
state. This allows one host manager to support zero, one, or many NPC accounts
without unregistering and re-registering the plugin.

## Current v2 Constraints

The current implementation makes one account part of plugin construction:

```ts
const plugin = new NPCPlugin(baseUrl, signer, {
  sinceStore,
  syncIntervalMs,
  useWebsocket,
});
```

That shape has a few consequences:

- a signer is required before the plugin can be registered with the host
- changing the signer requires replacing the plugin instance
- multiple keys require multiple plugin instances, but the host extension name is
  singular (`npc`)
- sync status, websocket status, and the `sinceStore` are global even though they
  really belong to one NPC account
- `manager.ext.npc` exposes single-account methods (`getInfo()`,
  `setUsername()`, `getQuotesSince()`, `sync()`)

## Goals

- Allow `new NPCPlugin(options?)` to be registered with no key, signer, or
  account.
- Support multiple concurrent accounts under one `manager.ext.npc` extension.
- Make account add/remove/switch operations runtime operations, not host plugin
  lifecycle operations.
- Preserve the current sync safety guarantees per account: no overlapping syncs,
  safe `since` advancement, trusted mint registration, quote validation, and
  retry of unresolved failures.
- Keep payment flows host-integrated through `paymentRequestService`.
- Make persistence pluggable so apps can store account metadata and per-account
  `since` values in their own database.
- Provide a clear v2 to v3 migration path.

## Non-Goals

- v3 does not define secure secret storage for signers. Host apps remain
  responsible for deriving or retrieving signer material and passing a signer to
  `addAccount()`.
- v3 does not choose a UI model for account switching. It provides account
  identifiers and status so hosts can build their own UX.
- v3 does not require persisted accounts. A host can add accounts on every app
  start from its own state.
- v3 does not merge quotes across accounts before import. Each account syncs
  independently against the same coco mint services.

## Public API

### Plugin Construction

```ts
const plugin = new NPCPlugin({
  defaultBaseUrl: "https://npubx.cash",
  accountStore,
  sinceStoreFactory,
  syncIntervalMs: 25_000,
  useWebsocket: true,
  logger,
});

manager.use(plugin);
```

`NPCPluginOptions` no longer accepts a signer or a single `sinceStore`.

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

### Account Registration

Account ids are explicit. The plugin should not assume every signer can reveal a
public key, and it should not derive persistence keys from opaque signer objects.
Host apps can use an npub, wallet id, profile id, or any other stable string.

```ts
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl: "https://npubx.cash",
  syncIntervalMs: 60_000,
  useWebsocket: true,
  autoStart: true,
});
```

```ts
interface AddNPCAccountOptions {
  id: string;
  signer: Signer;
  baseUrl?: string;
  sinceStore?: SinceStore;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  autoStart?: boolean;
}
```

The required fields are `id` and `signer`. `baseUrl` defaults to
`plugin.defaultBaseUrl`; if neither is present, `addAccount()` throws.

### Extension Shape

The extension becomes account-aware:

```ts
interface NPCPluginApi {
  addAccount(options: AddNPCAccountOptions): Promise<NPCAccountApi>;
  removeAccount(accountId: string): Promise<void>;
  getAccount(accountId: string): NPCAccountApi | undefined;
  listAccounts(): NPCAccountSummary[];
  getStatus(): NPCPluginStatus;
  syncAll(): Promise<void>;
  shutdownAccount(accountId: string): Promise<void>;
}
```

Each account exposes the operations that are currently global:

```ts
interface NPCAccountApi {
  readonly id: string;

  getInfo(): Promise<unknown>;
  setUsername(
    username: string,
    attemptPayment?: boolean,
  ): Promise<SetUsernameResult>;
  getQuotesSince(sinceUnix: number): Promise<unknown[]>;
  sync(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  getStatus(): NPCAccountStatus;
}
```

The old single-account methods should not remain on the root API. Keeping them
on the root API would make multi-account behavior ambiguous. v3 is a hard cut to
the account-aware API.

## Internal Architecture

### `NPCPlugin`

`NPCPlugin` owns only host-level state:

- plugin name and required service tuple
- `PluginContext`
- readiness and shutdown flags
- account registry
- root extension registration
- default options shared by accounts

It does not own an `NPCClient`, signer, interval timer, websocket subscription,
or `sinceStore`.

`onInit()` registers the root `npc` extension immediately. `onReady()` marks the
plugin ready and starts accounts whose `autoStart` flag is enabled. If accounts
were added before readiness, their `sync()` calls should wait in the same way the
current v2 plugin waits for `onReady()`.

### `NPCAccountRuntime`

Introduce an internal runtime class per account:

```ts
class NPCAccountRuntime {
  readonly id: string;

  start(): void;
  stop(): Promise<void>;
  shutdown(): Promise<void>;
  sync(trigger?: SyncTrigger): Promise<void>;
  getStatus(): NPCAccountStatus;
}
```

The account runtime owns the pieces currently stored on `NPCPlugin`:

- `NPCClient`
- `SinceStore`
- child logger with `{ module: "npc", accountId }`
- interval timer
- websocket subscription and reconnect timer
- `isRunning`, `hasPendingUpdate`, and `runPromise`
- per-account ready waiters
- shutdown flag

`syncPaidQuotesOnce()` should move almost unchanged into this runtime. Its host
service dependencies are passed from the parent plugin after `onInit()`.

### Account Registry

The plugin maintains:

```ts
private readonly accounts = new Map<string, NPCAccountRuntime>();
```

`addAccount()` validates the id, resolves account-level options, creates the
runtime, stores it, persists metadata if an account store is configured, and
starts it if the plugin is ready and `autoStart !== false`.

`addAccount()` should be idempotent for an already-registered account id when the
incoming account configuration matches the existing runtime configuration. In
that case it returns the existing `NPCAccountApi` and should not restart timers,
replace the signer, reset the websocket, or mutate the `sinceStore`. If the same
id is reused with conflicting configuration, it should throw and require the host
to call `removeAccount(id)` or an explicit future `updateAccount()` API first.

`removeAccount()` stops the runtime, removes it from the map, and removes
metadata from the account store if configured. Removing an account must not
delete host-owned signer secrets because the plugin should not own those secrets.

## Persistence Model

### Account Metadata Store

Account metadata persistence is optional and host-owned:

```ts
interface NPCAccountRecord {
  id: string;
  baseUrl: string;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  autoStart: boolean;
  createdAt: number;
  updatedAt: number;
}

interface NPCAccountStore {
  list(): Promise<NPCAccountRecord[]>;
  upsert(record: NPCAccountRecord): Promise<void>;
  remove(accountId: string): Promise<void>;
}
```

The store intentionally excludes `signer`. On app startup, the host can load its
own signer material and call `addAccount()` for every account record it wants to
activate.

### Since Store Factory

The single global `sinceStore` becomes account-scoped:

```ts
type NPCSinceStoreFactory = (account: {
  id: string;
  baseUrl: string;
}) => SinceStore;
```

If no factory or explicit account `sinceStore` is provided, the account uses a
new `MemorySinceStore(0)`. Browser hosts can use stable keys such as
`npc:${account.id}:${new URL(baseUrl).host}:since`.

The existing `SinceStore` interface can stay unchanged.

## Sync Semantics

Sync behavior remains per account:

1. Read that account's `since`.
2. Fetch that account's NPC quotes with its authenticated client.
3. Validate quotes and filter stale timestamps.
4. Group valid quotes by `mintUrl`.
5. Add mints as trusted through the shared host `mintService`.
6. Import transformed quotes through the shared host `mintOperationService`.
7. Advance only that account's `since` to the highest safe watermark.

Overlapping sync requests for the same account are serialized exactly as today.
Different accounts may sync concurrently because their NPC clients and
watermarks are independent. This means host services must remain the only shared
coordination boundary.

If two accounts return the same mint quote, the existing
`getOperationByQuote(mintUrl, quote)` check remains the idempotency gate. A
second account should skip an already-tracked non-`init` operation and advance
its own `since` as a successful skip.

## WebSocket And Interval Behavior

`useWebsocket` and `syncIntervalMs` can be configured at both plugin and account
level. Account-level values override plugin defaults.

Starting an account arms only that account's realtime behavior. Stopping or
removing an account must:

- clear its interval timer
- clear its websocket reconnect timer
- unsubscribe its websocket subscription
- resolve its ready waiters
- wait for its in-flight sync to settle

Plugin shutdown calls `shutdown()` on every account runtime and waits for all of
them to finish.

## Status Model

Plugin status should summarize the registry:

```ts
interface NPCPluginStatus {
  isInitialized: boolean;
  isReady: boolean;
  accountCount: number;
  runningAccountCount: number;
  syncingAccountIds: string[];
  websocketAccountIds: string[];
}
```

Account status carries the fields that currently live on `NPCPluginStatus`:

```ts
interface NPCAccountStatus {
  id: string;
  baseUrl: string;
  isStarted: boolean;
  isReady: boolean;
  isSyncing: boolean;
  isWebSocketConnected: boolean;
  lastSyncStartedAt?: number;
  lastSyncCompletedAt?: number;
  lastSyncError?: string;
}
```

## Error Handling

- Invalid plugin `defaultBaseUrl` throws during construction.
- Missing account `baseUrl` throws in `addAccount()` when no plugin default is
  available.
- Invalid account ids throw before any runtime is created.
- Re-adding an existing account id with matching configuration returns the
  existing account API.
- Re-adding an existing account id with conflicting configuration throws.
- Runtime sync failures are logged and reflected in account status, but they do
  not remove or stop the account.
- `removeAccount()` should be idempotent: removing a missing account is a no-op.

## Migration Plan

See [v3-migration-plan.md](./v3-migration-plan.md) for the step-by-step
implementation plan. The migration is a hard cut to the account-aware API.

## Test Plan

Add focused tests for:

- registering `NPCPlugin` without signer or base URL when no account is added
- `manager.ext.npc.addAccount()` creates an account runtime and exposes account
  methods
- adding an account before `onReady()` does not sync until readiness
- adding an account after `onReady()` can start immediately
- repeated `addAccount()` calls with matching account configuration are
  idempotent and do not restart the account
- repeated `addAccount()` calls with conflicting account configuration are
  rejected
- removing an account clears timers, websocket subscriptions, and pending ready
  waiters
- two accounts can sync without sharing `sinceStore` state
- one account's failed sync does not block another account
- `syncAll()` waits for all account syncs
- plugin shutdown waits for all in-flight account syncs
- `setUsername(..., true)` still uses the shared `paymentRequestService`

Existing v2 tests should be split so plugin lifecycle tests assert root registry
behavior and account lifecycle tests assert the current sync safety behavior.

## Implementation Decisions

- Account ids are fully host-defined. The plugin should not derive ids from
  signers, even when a signer can expose a public key.
- Persisted account metadata is not automatically loaded or activated by the
  plugin. Hosts reconstruct signer material and call `addAccount()` for records
  they want active.
- `syncAll()` runs account syncs concurrently. Each account still serializes
  overlapping sync requests internally.
- `listAccounts()` returns all registered account runtimes, including stopped
  accounts. `removeAccount()` is the operation that removes an account from the
  registry.
