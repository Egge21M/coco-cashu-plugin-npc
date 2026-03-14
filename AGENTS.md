# AGENTS.md

Guidance for coding agents working in `coco-cashu-plugin-npc`.

## Project Snapshot

- TypeScript library for integrating NPubCash with `coco-cashu-core`.
- Runtime/tooling is Bun-based; builds use `tsdown` and types use `tsc`.
- Main source lives in `src/`; tests live in `tests/`.
- Public exports are defined in `src/index.ts`.
- Build output goes to `dist/`; treat it as generated code.

## Source Of Truth

- Prefer current source and tests over README examples when they disagree.
- At the time of writing, README mentions `NPCOnDemandPlugin`, but the actual exported implementation is `NPCPlugin` plus supporting types/stores.
- Confirm behavior from `src/` and `tests/` before making API claims.

## Agent Rules Files

- No `.cursorrules` file was found.
- No `.cursor/rules/` directory was found.
- No `.github/copilot-instructions.md` file was found.
- Do not assume extra editor-specific rules exist beyond this file.

## Repository Layout

- `src/plugins/NPCPlugin.ts`: core plugin implementation.
- `src/PluginApi.ts`: host-facing API wrapper around payment and NPC clients.
- `src/sync/sinceStore.ts`: persistence abstractions and default store implementations.
- `src/types.ts`: shared types, validation helpers, logger helpers, constants.
- `src/index.ts`: package barrel exports and `coco-cashu-core` module augmentation.
- `tests/*.test.ts`: Bun tests for exports, sync behavior, stores, and plugin lifecycle.

## Install And Setup

- Install dependencies with `bun install --frozen-lockfile`.
- CI uses Bun and runs install plus `bun test`.
- Use Bun commands by default instead of npm.

## Build / Check / Test Commands

- Build package: `bun run build`
- Typecheck: `bun run typecheck`
- Test all: `bun test`
- Run one test file: `bun test tests/NPCPlugin.test.ts`
- Run multiple matching files: `bun test NPCPlugin sinceStore`
- Run one test by name regex: `bun test --test-name-pattern "returns correct initial status"`
- Run one file and one test name: `bun test tests/NPCPlugin.test.ts --test-name-pattern "gracefully shuts down"`
- Show Bun test options: `bun test --help`

## Linting Status

- There is currently no dedicated lint script in `package.json`.
- No ESLint, Biome, or Prettier config was found in the repo root.
- Treat `bun run typecheck` as the main static-quality gate unless asked to add linting.
- Do not invent a formatter or linter config unless the task explicitly requires it.

## Verified Commands

- `bun run build` succeeds.
- `bun run typecheck` succeeds.
- `bun test tests/index.test.ts` succeeds.
- If you make behavioral changes, rerun the narrowest relevant test first, then broader checks.

## General Coding Style

- Use TypeScript with strict typing in mind; `tsconfig.json` enables `strict` and other strictness flags.
- Use 2-space indentation.
- Use semicolons consistently.
- Use double quotes for strings.
- Use trailing commas in multiline literals, parameter lists, and imports.
- Keep one statement per line and prefer readable multiline wrapping over compressed expressions.
- Preserve existing blank-line rhythm between import groups and logical blocks.

## Imports

- Put external imports before local relative imports.
- Prefer `import type` for type-only imports.
- When mixing value and type imports from one module, follow the existing pattern: `import { value, type SomeType } from "pkg";`.
- Use extensionless relative imports such as `../types`, not `../types.ts`.
- Keep imports minimal and remove unused ones; `noUnusedLocals` and `noUnusedParameters` are enabled.

## Types And APIs

- Prefer explicit interfaces for public object shapes (`NPCQuote`, `MintQuote`, `NPCPluginOptions`).
- Use `type` aliases for unions, constructor-derived types, or helper shapes (`SyncTrigger`, `Signer`).
- Prefer `unknown` over `any` when a value is intentionally opaque.
- Narrow unknown data with guards before use; `isValidQuote()` is the pattern to follow.
- Use `as const` for literal configuration objects and constant groups.
- Keep public method return types explicit when they are part of the package contract.
- Use `readonly` for class fields and public constants that should not change after construction.

## Naming Conventions

- Classes, interfaces, and exported types use PascalCase.
- Functions, methods, local variables, and object properties use camelCase.
- Constant groups use descriptive upper-snake identifiers when exported (`QUOTE_DEFAULTS`, `WEBSOCKET_DEFAULTS`).
- File names generally follow the exported unit or existing convention; match surrounding files instead of renaming stylistically.
- Test files use `*.test.ts` and helper utilities live in `tests/helpers.ts`.

## Error Handling And Logging

- Validate invalid configuration early and throw plain `Error` with a direct message when appropriate.
- Catch errors when you can add context, recover, or log; otherwise let them surface.
- Re-throw unexpected errors after narrowing known cases, as in `PluginApi.setUsername()`.
- During shutdown/cleanup paths, swallowing errors is acceptable only when explicitly intentional and documented by code structure.
- Prefer structured logger helpers over ad hoc string concatenation; reuse `formatLogMessage()` and `createChildLogger()`.
- Use optional chaining for logger methods because logger support is intentionally partial.

## Control Flow Patterns

- Prefer early returns for guard clauses.
- Keep async methods small and purpose-specific.
- Batch related async work with `Promise.all()` only when operations are truly independent.
- Preserve reentrancy and lifecycle protections in `NPCPlugin`; avoid changes that reintroduce overlapping syncs.
- Respect shutdown flags and timer cleanup semantics when editing lifecycle code.

## Plugin-Specific Expectations

- `NPCPlugin` is the main integration surface; changes here can affect timers, WebSocket reconnects, syncing, and extension registration.
- Required services are declared via the `requiredServices` tuple; keep this accurate if dependencies change.
- `onInit()` registers the `npc` extension and returns async cleanup.
- `onReady()` only arms sync behavior after the host is ready.
- Sync logic must validate quotes, group by `mintUrl`, add trusted mints, forward transformed quotes, and then update `since`.
- Maintain the rule that `sinceStore` advances only after successful processing.

## Testing Conventions

- Tests use `bun:test` imports: `describe`, `it`, `expect`, and lifecycle hooks as needed.
- Prefer focused test files by feature area rather than giant integration-only suites.
- Use helpers from `tests/helpers.ts` for common mocks before introducing new inline test scaffolding.
- It is acceptable in tests to cast through `unknown` to stub private internals when there is no better seam.
- Test both happy-path behavior and lifecycle/error/no-op branches.
- For async plugin behavior, await the public method or tracked internal promise until state settles.

## Documentation And Comments

- Keep JSDoc on exported classes, interfaces, and non-obvious public methods.
- Do not add comments for obvious code.
- Prefer comments that explain lifecycle or protocol constraints, not line-by-line narration.
- If you change public behavior, update README only after confirming the implementation actually supports the documented API.

## When Editing

- Do not hand-edit `dist/`; regenerate it with `bun run build` if needed.
- Keep module augmentation in `src/index.ts` aligned with the extension name registered in `NPCPlugin`.
- Preserve compatibility with `coco-cashu-core` and `npubcash-sdk` peer/runtime expectations.
- Avoid broad refactors unless the task calls for them; this is a small library with tight behavior.
- Prefer small, explicit changes and keep tests close to the changed behavior.

## Suggested Agent Workflow

- Read the relevant source file and its paired tests first.
- Make the smallest change that satisfies the task.
- Run a targeted test file or `--test-name-pattern` command.
- Run `bun run typecheck` for any TypeScript edit.
- Run `bun test` and `bun run build` before finishing when the change affects public behavior or exports.
