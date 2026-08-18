# Migrating To v3

v3 changes `coco-cashu-plugin-npc` from a single-account plugin into an
account-aware plugin. The plugin can now be registered before signer material is
available, and one host manager can manage multiple NPubCash accounts.

This is a breaking change. The old constructor and root single-account methods
were removed.

v3 requires stable `@cashu/coco-core` v2. Upgrade the host application to
`@cashu/coco-core@^2.0.0`; Coco release candidates and the legacy
`coco-cashu-core` package are not supported.

## What Changed

In v2, one NPC account was part of plugin construction:

```ts
const plugin = new NPCPlugin(baseUrl, signer, {
  sinceStore,
  syncIntervalMs,
  useWebsocket,
});
```

In v3, the plugin is registered first, then accounts are added through the
`npc` extension:

```ts
const plugin = new NPCPlugin({
  defaultBaseUrl: "https://npubx.cash",
  syncIntervalMs: 25_000,
  useWebsocket: true,
});

// manager.use(plugin)

const account = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  sinceStore,
});
```

The root extension now manages accounts. Account-specific NPC methods moved to
the account API returned from `addAccount()` or `getAccount(id)`.

## Constructor Migration

Replace this:

```ts
const plugin = new NPCPlugin(baseUrl, signer, {
  sinceStore,
  syncIntervalMs: 25_000,
  useWebsocket: true,
});
```

With this:

```ts
const plugin = new NPCPlugin({
  defaultBaseUrl: baseUrl,
  syncIntervalMs: 25_000,
  useWebsocket: true,
});

// Register the plugin with the coco host first.
// manager.use(plugin)

const account = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  sinceStore,
});
```

`NPCPluginOptions` no longer accepts `sinceStore`. Provide an explicit
`sinceStore` to `addAccount()`, or configure a plugin-level
`sinceStoreFactory`.

## Extension API Migration

Root single-account methods were removed:

- `manager.ext.npc.getInfo()`
- `manager.ext.npc.setUsername(username, attemptPayment?)`
- `manager.ext.npc.getQuotesSince(sinceUnix)`
- `manager.ext.npc.sync()`

Use account-level methods instead:

```ts
const account = manager.ext.npc.getAccount("wallet-main");

await account?.getInfo();
await account?.getQuotesSince(0);
await account?.sync();
await account?.setUsername("alice", true);
```

If you already have the account returned by `addAccount()`, keep and reuse that
object:

```ts
const account = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl,
});

await account.sync();
```

## Account Ids

Every account needs a host-defined `id`:

```ts
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl: "https://npubx.cash",
});
```

The plugin does not derive account ids from signers. Use a stable id from your
app, such as a wallet id, profile id, npub, or account record id.

## Base URL Defaults

You can provide a plugin-level default:

```ts
const plugin = new NPCPlugin({
  defaultBaseUrl: "https://npubx.cash",
});

await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
});
```

Or provide the base URL per account:

```ts
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl: "https://npubx.cash",
});
```

If neither is provided, `addAccount()` throws.

## SinceStore Migration

In v2, `sinceStore` lived on the plugin:

```ts
new NPCPlugin(baseUrl, signer, {
  sinceStore,
});
```

In v3, `SinceStore` is account-scoped:

```ts
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl,
  sinceStore,
});
```

For multiple accounts, use one store per account. You can pass explicit stores
or configure a factory:

```ts
const plugin = new NPCPlugin({
  defaultBaseUrl: "https://npubx.cash",
  sinceStoreFactory: (accountId) =>
    new LocalStorageSinceStore(`npc:${accountId}:since`),
});
```

Fallback in-memory stores are created per account, so two accounts do not share
the same in-memory watermark.

## Account Metadata Persistence

v3 can persist account metadata through `NPCAccountStore`:

```ts
const plugin = new NPCPlugin({
  accountStore,
});
```

The account store only persists metadata such as account id, base URL, timer
settings, websocket settings, and `autoStart`. It does not persist signer
material.

The plugin does not automatically activate persisted records. On app startup,
load the records in your app, reconstruct or retrieve the signer for each
account, then call `addAccount()` for the accounts you want active.

## Idempotent Account Registration

Calling `addAccount()` again with the same id and matching configuration returns
the existing account API:

```ts
const first = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl,
});

const second = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl,
});

console.log(first === second); // true
```

The comparison uses reference equality for signers and explicit `SinceStore`
instances. Reusing an id with different configuration throws. Remove the
account before re-adding it with different settings:

```ts
await manager.ext.npc.removeAccount("wallet-main");
await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer: newSigner,
  baseUrl,
});
```

## Start, Stop, And Sync

Accounts start automatically after the host is ready unless `autoStart` is
`false`:

```ts
const account = await manager.ext.npc.addAccount({
  id: "wallet-main",
  signer,
  baseUrl,
  autoStart: false,
});

account.start();
```

Use `account.stop()` to stop that account's interval and websocket behavior
without removing it from the registry:

```ts
await account.stop();
```

Use `removeAccount(id)` to stop and remove the account:

```ts
await manager.ext.npc.removeAccount("wallet-main");
```

Use `syncAll()` to sync all registered accounts concurrently:

```ts
await manager.ext.npc.syncAll();
```

Each account still serializes overlapping sync requests internally.

## Username Behavior

Usernames remain optional. Only call `setUsername()` when your app wants to set
a custom alias:

```ts
const result = await account.setUsername("alice", true);
if (!result.success) {
  console.log(result.pr);
}
```

If your app uses the NPC default address behavior, you can add and sync the
account without calling `setUsername()`.

## Quick Checklist

- Replace `new NPCPlugin(baseUrl, signer, options)` with `new NPCPlugin(options)`.
- Move `signer`, `baseUrl`, and `sinceStore` into `addAccount()`.
- Choose a stable host-defined account id.
- Replace root `manager.ext.npc.sync()` calls with `account.sync()` or `syncAll()`.
- Replace root `getInfo()`, `setUsername()`, and `getQuotesSince()` calls with account-level calls.
- Use a separate `SinceStore` per account, or provide `sinceStoreFactory`.
- Persist account metadata separately from signer material if your app needs account restoration.
