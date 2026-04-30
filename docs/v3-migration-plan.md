# NPC Plugin v3 Migration Plan

This plan turns the v3 design into an ordered implementation path. v3 is a hard
cut: the single-account constructor and root single-account extension methods are
removed rather than preserved behind a compatibility helper.

## Success Criteria

- `new NPCPlugin(options?)` can be registered without a signer, base URL, or
  account.
- `manager.ext.npc` exposes account-management methods, not single-account NPC
  methods.
- `addAccount()` creates account runtimes at runtime and is idempotent for
  matching account configuration.
- Each account owns its own signer, NPC client, sync runner, interval timer,
  websocket subscription, and `SinceStore`.
- Existing quote-sync safety semantics remain intact per account.
- `bun run typecheck`, `bun test`, and `bun run build` pass after the migration.

## Decisions Before Implementation

- Account ids are fully host-defined. v3 should not derive account ids from
  signers, even when a signer can expose a public key.
- Signers and explicit `SinceStore` instances are compared by reference for
  idempotent `addAccount()` checks. They are opaque objects and should not be
  deep-compared.
- Re-adding an account that used the fallback store or `sinceStoreFactory`
  matches when the account id, resolved base URL, signer reference, interval
  setting, websocket setting, and `autoStart` setting match. The existing runtime
  keeps its original store instance.
- Re-adding an account with a different explicit `SinceStore` reference is a
  conflicting configuration and throws.
- `syncAll()` runs account syncs concurrently with `Promise.all()`. Each account
  still serializes overlapping sync requests internally.
- `listAccounts()` returns all registered account runtimes, including stopped
  accounts. `removeAccount()` is the operation that removes an account from the
  registry.
- The plugin does not automatically load or activate persisted
  `NPCAccountStore` records. Hosts reconstruct signer material and call
  `addAccount()` for records they want active.

## Step 1: Add The v3 Public Types

Files:

- `src/types.ts`
- `src/plugins/NPCPlugin.ts`
- `src/PluginApi.ts`
- `src/index.ts`
- `tests/index.test.ts`

Work:

- Add `AddNPCAccountOptions`, `NPCAccountRecord`, `NPCAccountStore`,
  `NPCSinceStoreFactory`, `NPCAccountSummary`, `NPCAccountStatus`, and the v3
  `NPCPluginStatus`.
- Change `NPCPluginOptions` so it only accepts plugin-level defaults:
  `defaultBaseUrl`, `accountStore`, `sinceStoreFactory`, `syncIntervalMs`,
  `useWebsocket`, and `logger`.
- Keep `SinceStore`, `Signer`, `NPCQuote`, `MintQuote`, and `SetUsernameResult`
  available from public exports.
- Update module augmentation in `src/index.ts` so `npc` points at the new root
  extension API type.

Tests:

- Update export/type tests to compile against the new public shapes.
- Remove tests that assert the old `NPCPlugin(baseUrl, signer, options)`
  constructor type.

Validation:

```bash
bun run typecheck
```

## Step 2: Extract The Account Runtime

Files:

- `src/accounts/NPCAccountRuntime.ts`
- `src/plugins/NPCPlugin.ts`
- `tests/NPCAccountRuntime.test.ts`
- `tests/syncPaidQuotes.test.ts`

Work:

- Move the current per-account fields from `NPCPlugin` into
  `NPCAccountRuntime`: `NPCClient`, `SinceStore`, timers, websocket state,
  sync state, reconnect state, shutdown state, ready waiters, and account logger.
- Move `sync()`, `requestSync()`, `startRunner()`, `syncPaidQuotesOnce()`,
  interval handling, websocket handling, and account shutdown into the runtime.
- Pass host services into the runtime from the parent plugin after `onInit()`.
- Preserve the current quote processing algorithm exactly:
  read `since`, fetch quotes, validate, filter stale data, group by mint, add
  trusted mints, import quotes, and advance only to the safe watermark.
- Keep same-account overlapping syncs serialized with the existing
  `hasPendingUpdate` / `runPromise` model.

Tests:

- Move sync mapping tests from plugin-level setup to account-runtime or
  account-API setup.
- Keep coverage for invalid quotes, stale quotes, mint grouping, failed mint
  adds, import failures, already-tracked quotes, and safe `since` advancement.
- Keep coverage for manual sync waiting until readiness.

Validation:

```bash
bun test tests/syncPaidQuotes.test.ts
bun test tests/NPCAccountRuntime.test.ts
bun run typecheck
```

## Step 3: Rebuild `NPCPlugin` As A Host-Level Registry

Files:

- `src/plugins/NPCPlugin.ts`
- `tests/NPCPlugin.test.ts`

Work:

- Remove constructor parameters `baseUrl` and `signer`.
- Validate `defaultBaseUrl` only when it is provided.
- Keep `name = "npc"` and the existing `requiredServices` tuple.
- Make `onInit()` store the plugin context and register the root `npc`
  extension immediately, even with zero accounts.
- Make `onReady()` mark the plugin ready and start already-added accounts whose
  `autoStart !== false`.
- Make plugin shutdown call `shutdown()` on every account runtime and wait for
  all accounts to settle.
- Make plugin status summarize registry state: account count, running accounts,
  syncing account ids, and websocket-connected account ids.

Tests:

- Registering the plugin with no account succeeds.
- `onInit()` registers the root extension.
- `onReady()` starts previously added auto-start accounts.
- Shutdown waits for all account runtimes.
- Invalid `defaultBaseUrl` throws, but absent `defaultBaseUrl` is valid.

Validation:

```bash
bun test tests/NPCPlugin.test.ts
bun run typecheck
```

## Step 4: Implement The Root Extension API

Files:

- `src/PluginApi.ts`
- `src/plugins/NPCPlugin.ts`
- `tests/PluginApi.test.ts`

Work:

- Replace the current single-account `PluginApi` with the root account
  management API:
  `addAccount()`, `removeAccount()`, `getAccount()`, `listAccounts()`,
  `getStatus()`, `syncAll()`, and `shutdownAccount()`.
- Add account API objects that expose `getInfo()`, `setUsername()`,
  `getQuotesSince()`, `sync()`, `start()`, `stop()`, and `getStatus()` for one
  account runtime.
- Route `setUsername(..., true)` through the shared `paymentRequestService` just
  as the current API does.
- Keep account ids host-defined. Validate empty or whitespace-only ids before
  creating a runtime.

Tests:

- `addAccount()` returns an account API.
- `getAccount()` and `listAccounts()` reflect registered runtimes, including
  stopped accounts.
- `removeAccount()` stops and removes the runtime.
- `removeAccount()` is idempotent for missing ids.
- `syncAll()` starts account syncs concurrently and waits for all of them.
- Account `setUsername(..., true)` still handles the payment-required flow.

Validation:

```bash
bun test tests/PluginApi.test.ts
bun run typecheck
```

## Step 5: Implement Idempotent `addAccount()`

Files:

- `src/plugins/NPCPlugin.ts`
- `src/PluginApi.ts`
- `tests/PluginApi.test.ts`
- `tests/NPCPlugin.test.ts`

Work:

- Normalize the account config used for duplicate checks:
  account id, resolved base URL, resolved interval setting, resolved websocket
  setting, `autoStart`, explicit `SinceStore` identity, and signer identity.
- Run the duplicate check before creating a new fallback or factory-backed
  `SinceStore`, so idempotent re-adds cannot accidentally allocate replacement
  account state.
- If an account id already exists with matching normalized config, return the
  existing account API.
- Do not restart timers, replace the signer, reconnect websockets, or reset the
  `SinceStore` for idempotent re-adds.
- If the same id is reused with conflicting config, throw a direct error telling
  the host to remove the account before re-adding it.

Tests:

- Re-adding the same id with the same config returns the same account API.
- Idempotent re-add does not call runtime `start()` again.
- Idempotent re-add does not recreate the `SinceStore`.
- Re-adding with a different signer, base URL, timer setting, websocket setting,
  or `autoStart` value throws.

Validation:

```bash
bun test --test-name-pattern "addAccount"
bun run typecheck
```

## Step 6: Add Account-Scoped Persistence

Files:

- `src/plugins/NPCPlugin.ts`
- `src/sync/sinceStore.ts`
- `tests/sinceStore.test.ts`
- `tests/PluginApi.test.ts`

Work:

- Keep the existing `SinceStore` interface unchanged.
- Resolve each account's store in this order:
  explicit `AddNPCAccountOptions.sinceStore`, plugin `sinceStoreFactory`,
  fallback `new MemorySinceStore(0)`.
- Add optional account metadata persistence via `NPCAccountStore`.
- Persist account metadata on successful account add.
- Remove account metadata on `removeAccount()`.
- Do not persist signer material.
- Do not automatically activate persisted records unless the host supplies
  signers and calls `addAccount()`.

Tests:

- Explicit `sinceStore` is used for that account.
- `sinceStoreFactory` receives account id and base URL.
- Two accounts do not share in-memory fallback stores.
- Account metadata store receives `upsert()` and `remove()` calls.
- Store failures fail the account-add or account-remove operation clearly.

Validation:

```bash
bun test tests/sinceStore.test.ts
bun test tests/PluginApi.test.ts
bun run typecheck
```

## Step 7: Verify Multi-Account Runtime Behavior

Files:

- `tests/NPCAccountRuntime.test.ts`
- `tests/NPCPlugin.test.ts`
- `tests/syncPaidQuotes.test.ts`

Work:

- Add integration-style tests with two accounts under one plugin instance.
- Assert per-account sync state and `since` state remain independent.
- Assert one account's sync failure does not block another account.
- Assert two accounts can sync concurrently, while each account still serializes
  overlapping requests for itself.
- Assert duplicate quotes across accounts use the existing
  `getOperationByQuote(mintUrl, quote)` idempotency gate.

Validation:

```bash
bun test tests/NPCAccountRuntime.test.ts
bun test tests/syncPaidQuotes.test.ts
bun test tests/NPCPlugin.test.ts
bun run typecheck
```

## Step 8: Update Documentation For The Hard Cut

Files:

- `README.md`
- `docs/v3-design.md`
- `docs/v3-migration-plan.md`

Work:

- Replace the v2 quick start with the v3 flow:
  create plugin, register with host, then call `manager.ext.npc.addAccount()`.
- Document that root `manager.ext.npc.getInfo()`, `setUsername()`,
  `getQuotesSince()`, and `sync()` are removed.
- Document account-level replacements:
  `manager.ext.npc.getAccount(id)?.getInfo()` or the returned account API from
  `addAccount()`.
- Document that username remains optional; hosts only call `setUsername()` when
  they want to set a custom alias.
- Document that signers are host-owned and never persisted by the plugin.
- Document the per-account `SinceStore` behavior and the idempotent
  `addAccount()` contract.

Validation:

```bash
bun run typecheck
bun test tests/index.test.ts
```

## Step 9: Remove v2-Only Tests And Fixtures

Files:

- `tests/NPCOnDemandPlugin.test.ts`
- `tests/NPCPlugin.test.ts`
- `tests/PluginApi.test.ts`
- `tests/helpers.ts`

Work:

- Delete or rewrite tests that construct `NPCPlugin(baseUrl, signer, options)`.
- Rename `tests/NPCOnDemandPlugin.test.ts` if it only covers account manual sync
  after the migration.
- Update helpers so they create a zero-account plugin plus account runtime/API
  fixtures instead of stubbing a private plugin-level `npcClient`.
- Keep no tests asserting removed root single-account methods.

Validation:

```bash
bun test
bun run typecheck
```

## Step 10: Final Package Verification

Run the full project gates:

```bash
bun run typecheck
bun test
bun run build
```

Before finishing, inspect the public package surface:

- `src/index.ts` exports the new API types.
- `dist/` is regenerated by `bun run build`, not hand-edited.
- README examples match the actual exported implementation.
- No references to `NPCPlugin(baseUrl, signer, options)` remain outside
  historical design context.
- No root `manager.ext.npc.sync()` style examples remain in current usage docs.

## Suggested Commit Boundaries

1. Public v3 type contracts.
2. Account runtime extraction.
3. Root plugin registry and extension API.
4. Idempotent account registration and persistence.
5. Multi-account test coverage.
6. README and final package build output.
