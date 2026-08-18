import { Amount } from "@cashu/coco-core";
import type { PluginContext } from "@cashu/coco-core/plugin";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";

import type { SinceStore } from "../sync/sinceStore";
import {
  type NPCAccountStatus,
  type NPCAccountSummary,
  type NPCQuote,
  type Signer,
  type StructuredLogger,
  QUOTE_DEFAULTS,
  createChildLogger,
  formatLogMessage,
  isValidQuote,
  isValidUrl,
} from "../types";

export const npcRequiredServices = [
  "mintOperationService",
  "mintService",
  "quotes",
  "paymentRequestService",
  "eventBus",
] as const;

export type NPCPluginContext = PluginContext<typeof npcRequiredServices>;

export type SyncTrigger = "manual" | "websocket" | "interval";

type QuoteSyncStatus = "imported" | "skipped" | "failed";

interface QuoteSyncResult {
  mintUrl: string;
  quoteId: string;
  paidAt: number;
  status: QuoteSyncStatus;
}

export interface NPCAccountRuntimeOptions {
  id: string;
  baseUrl: string;
  signer: Signer;
  sinceStore: SinceStore;
  syncIntervalMs?: number;
  useWebsocket: boolean;
  autoStart: boolean;
  logger?: StructuredLogger;
  client?: NPCClient;
}

const WEBSOCKET_DEFAULTS = {
  INITIAL_DELAY_MS: 5000,
  MAX_DELAY_MS: 60000,
  BACKOFF_MULTIPLIER: 2,
} as const;

/**
 * Owns the authenticated NPC client and sync lifecycle for one account.
 */
export class NPCAccountRuntime {
  readonly id: string;
  readonly baseUrl: string;
  readonly signer: Signer;
  readonly sinceStore: SinceStore;
  readonly syncIntervalMs?: number;
  readonly useWebsocket: boolean;
  readonly autoStart: boolean;
  readonly client: NPCClient;

  private readonly logger?: StructuredLogger;
  private isStarted = false;
  private isRunning = false;
  private hasPendingUpdate = false;
  private runPromise?: Promise<void>;
  private unsubscribe?: () => void;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private isReady = false;
  private isWebSocketConnected = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer?: ReturnType<typeof setTimeout>;
  private ctx?: NPCPluginContext;
  private isShuttingDown = false;
  private areSubscriptionsPaused = false;
  private readyWaiters: Array<() => void> = [];

  constructor(options: NPCAccountRuntimeOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl;
    this.signer = options.signer;
    this.sinceStore = options.sinceStore;
    this.syncIntervalMs = options.syncIntervalMs;
    this.useWebsocket = options.useWebsocket;
    this.autoStart = options.autoStart;

    this.logger = createChildLogger(options.logger, {
      module: "npc",
      accountId: options.id,
    });

    const npcLogger = createChildLogger(options.logger, {
      module: "npc-client",
      accountId: options.id,
    });

    this.client =
      options.client ??
      new NPCClient(
        options.baseUrl,
        new JWTAuthProvider(options.baseUrl, options.signer, npcLogger),
      );
  }

  attachContext(ctx: NPCPluginContext): void {
    this.ctx = ctx;
  }

  markReady(): void {
    if (this.isReady) return;

    this.isReady = true;
    this.resolveReadyWaiters();

    if (this.isStarted) {
      if (this.useWebsocket) {
        this.connectWebSocket();
      }

      if (this.syncIntervalMs !== undefined) {
        this.armIntervalTimer();
      }
    }
  }

  getStatus(): NPCAccountStatus {
    return {
      id: this.id,
      isReady: this.isReady,
      isRunning: this.isStarted,
      isSyncing: this.isRunning,
      isWebSocketConnected: this.isWebSocketConnected,
      isShutdown: this.isShuttingDown,
    };
  }

  getSummary(): NPCAccountSummary {
    return {
      ...this.getStatus(),
      baseUrl: this.baseUrl,
      autoStart: this.autoStart,
      syncIntervalMs: this.syncIntervalMs,
      useWebsocket: this.useWebsocket,
    };
  }

  start(): void {
    if (this.isStarted || this.isShuttingDown) return;

    this.isStarted = true;

    if (!this.isReady) return;

    if (this.useWebsocket) {
      this.connectWebSocket();
    }

    if (this.syncIntervalMs !== undefined) {
      this.armIntervalTimer();
    }
  }

  async stop(): Promise<void> {
    this.isStarted = false;
    this.teardown();

    if (this.runPromise) {
      await this.runPromise;
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.isStarted = false;
    this.resolveReadyWaiters();
    this.teardown();

    if (this.runPromise) {
      try {
        await this.runPromise;
      } catch {
        // Ignore errors during shutdown.
      }
    }
  }

  async sync(trigger: SyncTrigger = "manual"): Promise<void> {
    const isReady = await this.waitUntilReady();
    if (!isReady) return;

    await this.requestSync(trigger);
  }

  pauseSubscriptions(): void {
    this.areSubscriptionsPaused = true;

    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = undefined;
    }

    this.disposeWebSocketSubscription();
  }

  resumeSubscriptions(): void {
    if (!this.areSubscriptionsPaused) return;

    this.areSubscriptionsPaused = false;

    if (this.useWebsocket) {
      this.connectWebSocket();
    }
  }

  private teardown(): void {
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }

    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = undefined;
    }

    this.disposeWebSocketSubscription();
  }

  private async waitUntilReady(): Promise<boolean> {
    if (this.isReady) return true;
    if (this.isShuttingDown) return false;

    await new Promise<void>((resolve) => {
      this.readyWaiters.push(resolve);
    });

    return this.isReady && !this.isShuttingDown;
  }

  private resolveReadyWaiters(): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];

    for (const resolve of waiters) {
      resolve();
    }
  }

  private disposeWebSocketSubscription(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    this.isWebSocketConnected = false;

    if (unsubscribe) {
      try {
        unsubscribe();
      } catch (err) {
        this.logger?.warn?.(
          formatLogMessage("Error during WebSocket unsubscribe", {
            err: String(err),
            accountId: this.id,
          }),
        );
      }
    }
  }

  private connectWebSocket(): void {
    if (
      this.isShuttingDown ||
      this.areSubscriptionsPaused ||
      !this.isReady ||
      !this.isStarted ||
      this.unsubscribe
    ) {
      return;
    }

    try {
      this.unsubscribe = this.client.subscribe(
        () => {
          this.isWebSocketConnected = true;
          this.wsReconnectAttempts = 0;
          void this.requestSync("websocket");
        },
        (error) => {
          this.logger?.error?.(
            formatLogMessage("WebSocket error", {
              err: String(error),
              attempts: this.wsReconnectAttempts,
              accountId: this.id,
            }),
          );
          this.disposeWebSocketSubscription();
          this.scheduleWebSocketReconnect();
        },
      );
      this.isWebSocketConnected = true;
    } catch (err) {
      this.logger?.error?.(
        formatLogMessage("Failed to connect WebSocket", {
          err: String(err),
          accountId: this.id,
        }),
      );
      this.scheduleWebSocketReconnect();
    }
  }

  private scheduleWebSocketReconnect(): void {
    if (
      this.isShuttingDown ||
      this.areSubscriptionsPaused ||
      !this.isStarted ||
      this.wsReconnectTimer
    ) {
      return;
    }

    this.disposeWebSocketSubscription();

    const delay = Math.min(
      WEBSOCKET_DEFAULTS.INITIAL_DELAY_MS *
        Math.pow(
          WEBSOCKET_DEFAULTS.BACKOFF_MULTIPLIER,
          this.wsReconnectAttempts,
        ),
      WEBSOCKET_DEFAULTS.MAX_DELAY_MS,
    );

    this.wsReconnectAttempts++;
    this.logger?.info?.(
      formatLogMessage("Scheduling WebSocket reconnect", {
        delay,
        attempt: this.wsReconnectAttempts,
        accountId: this.id,
      }),
    );

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = undefined;
      this.connectWebSocket();
    }, delay);
  }

  private armIntervalTimer(): void {
    if (
      this.syncIntervalMs === undefined ||
      this.isShuttingDown ||
      !this.isStarted
    ) {
      return;
    }

    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }

    this.intervalTimer = setTimeout(() => {
      void this.requestSync("interval");
    }, this.syncIntervalMs);
  }

  private async requestSync(trigger: SyncTrigger): Promise<void> {
    if (!this.isReady || this.isShuttingDown) return;

    if (this.isRunning) {
      this.hasPendingUpdate = true;
      return this.runPromise ?? Promise.resolve();
    }

    this.hasPendingUpdate = true;
    this.startRunner(trigger);
    return this.runPromise ?? Promise.resolve();
  }

  private startRunner(trigger: SyncTrigger): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.isRunning = true;
    this.runPromise = (async () => {
      try {
        do {
          this.hasPendingUpdate = false;
          await this.syncPaidQuotesOnce({
            mintOperationService: ctx.services.mintOperationService,
            mintService: ctx.services.mintService,
            quoteApi: ctx.services.quotes,
            trigger,
          });
        } while (this.hasPendingUpdate && !this.isShuttingDown);
      } catch (err) {
        this.logger?.error?.(
          formatLogMessage("Sync failed", {
            err: String(err),
            trigger,
            accountId: this.id,
          }),
        );
      } finally {
        if (!this.isShuttingDown && this.isStarted) {
          this.armIntervalTimer();
        }
        this.isRunning = false;
        this.runPromise = undefined;
      }
    })();
  }

  private async syncPaidQuotesOnce(options: {
    mintOperationService: NPCPluginContext["services"]["mintOperationService"];
    mintService: NPCPluginContext["services"]["mintService"];
    quoteApi: NPCPluginContext["services"]["quotes"];
    trigger: SyncTrigger;
  }): Promise<void> {
    const { mintOperationService, mintService, quoteApi, trigger } = options;
    const since = await this.sinceStore.get();

    this.logger?.debug?.(
      formatLogMessage("Starting sync", {
        since,
        trigger,
        accountId: this.id,
      }),
    );

    const rawQuotes = await this.client.getQuotesSince(since);

    if (!rawQuotes || rawQuotes.length === 0) {
      this.logger?.debug?.("No new quotes");
      return;
    }

    const quotes: NPCQuote[] = [];
    let staleQuoteCount = 0;
    for (const raw of rawQuotes) {
      if (isValidQuote(raw)) {
        if (raw.paidAt <= since) {
          staleQuoteCount++;
          continue;
        }

        if (isValidUrl(raw.mintUrl)) {
          quotes.push(raw);
        } else {
          this.logger?.warn?.(
            formatLogMessage("Skipping quote with invalid mintUrl", {
              quoteId: raw.quoteId,
              mintUrl: raw.mintUrl,
              accountId: this.id,
            }),
          );
        }
      } else {
        this.logger?.warn?.(
          formatLogMessage("Skipping invalid quote", {
            raw: JSON.stringify(raw),
            accountId: this.id,
          }),
        );
      }
    }

    if (staleQuoteCount > 0) {
      this.logger?.debug?.(
        formatLogMessage("Skipped already-processed quotes", {
          count: staleQuoteCount,
          since,
          accountId: this.id,
        }),
      );
    }

    if (quotes.length === 0) {
      this.logger?.debug?.("No valid quotes after filtering");
      return;
    }

    quotes.sort((a, b) => {
      if (a.paidAt !== b.paidAt) {
        return a.paidAt - b.paidAt;
      }
      if (a.quoteId !== b.quoteId) {
        return a.quoteId.localeCompare(b.quoteId);
      }
      return a.mintUrl.localeCompare(b.mintUrl);
    });

    const mintUrlToQuotes = new Map<string, NPCQuote[]>();
    for (const quote of quotes) {
      const existing = mintUrlToQuotes.get(quote.mintUrl);
      if (existing) {
        existing.push(quote);
      } else {
        mintUrlToQuotes.set(quote.mintUrl, [quote]);
      }
    }

    const mintResults = await Promise.all(
      Array.from(mintUrlToQuotes.entries()).map(async ([mintUrl, list]) => {
        const results: QuoteSyncResult[] = [];

        try {
          await mintService.addMintByUrl(mintUrl, { trusted: true });
        } catch (err) {
          this.logger?.error?.(
            formatLogMessage("Failed to add trusted mint for quotes", {
              err: String(err),
              mintUrl,
              quoteCount: list.length,
              accountId: this.id,
            }),
          );
          for (const quote of list) {
            results.push({
              mintUrl,
              quoteId: quote.quoteId,
              paidAt: quote.paidAt,
              status: "failed",
            });
          }
          return results;
        }

        for (const quote of list) {
          try {
            const transformedQuote = {
              ...quote,
              amount: Amount.from(quote.amount),
              unit: QUOTE_DEFAULTS.UNIT,
              expiry: quote.expiresAt,
              state: QUOTE_DEFAULTS.STATE_PAID,
              quote: quote.quoteId,
              request: quote.request ?? "",
            };

            const existing = await mintOperationService.getOperationByQuote(
              mintUrl,
              "bolt11",
              transformedQuote.quote,
            );

            if (existing && existing.state !== "init") {
              results.push({
                mintUrl,
                quoteId: transformedQuote.quoteId,
                paidAt: transformedQuote.paidAt,
                status: "skipped",
              });
              this.logger?.debug?.(
                formatLogMessage("Skipping already-tracked quote", {
                  mintUrl,
                  quoteId: transformedQuote.quoteId,
                  operationId: existing.id,
                  state: existing.state,
                  accountId: this.id,
                }),
              );
              continue;
            }

            await quoteApi.mint.import({
              mintUrl,
              method: "bolt11",
              quote: transformedQuote,
            });
            const operation =
              existing?.state === "init"
                ? await this.prepareExistingMintOperation(existing.id)
                : await mintOperationService.prepare(
                    {
                      mintUrl,
                      method: "bolt11",
                      quoteId: transformedQuote.quote,
                    },
                    transformedQuote.amount,
                  );
            await mintOperationService.execute(operation.id);
            results.push({
              mintUrl,
              quoteId: transformedQuote.quoteId,
              paidAt: transformedQuote.paidAt,
              status: "imported",
            });
          } catch (err) {
            results.push({
              mintUrl,
              quoteId: quote.quoteId,
              paidAt: quote.paidAt,
              status: "failed",
            });
            this.logger?.error?.(
              formatLogMessage("Failed to import quote", {
                err: String(err),
                mintUrl,
                quoteId: quote.quoteId,
                accountId: this.id,
              }),
            );
          }
        }

        this.logger?.debug?.(
          formatLogMessage("Processed quotes for mint", {
            mintUrl,
            count: list.length,
            imported: results.filter((result) => result.status === "imported")
              .length,
            skipped: results.filter((result) => result.status === "skipped")
              .length,
            failed: results.filter((result) => result.status === "failed")
              .length,
            accountId: this.id,
          }),
        );

        return results;
      }),
    );

    const quoteResults = mintResults.flat();
    const failedPaidAt = quoteResults
      .filter((result) => result.status === "failed")
      .reduce<number | undefined>((min, result) => {
        if (min === undefined) {
          return result.paidAt;
        }
        return Math.min(min, result.paidAt);
      }, undefined);

    let safeSince = since;
    for (const result of quoteResults) {
      if (failedPaidAt !== undefined && result.paidAt >= failedPaidAt) {
        continue;
      }
      safeSince = Math.max(safeSince, result.paidAt);
    }

    if (safeSince > since) {
      await this.sinceStore.set(safeSince);
      this.logger?.debug?.(
        formatLogMessage("Updated since timestamp", {
          oldSince: since,
          newSince: safeSince,
          accountId: this.id,
        }),
      );
    }

    const importedCount = quoteResults.filter(
      (result) => result.status === "imported",
    ).length;
    const skippedCount = quoteResults.filter(
      (result) => result.status === "skipped",
    ).length;
    const failedCount = quoteResults.filter(
      (result) => result.status === "failed",
    ).length;

    if (failedCount > 0) {
      this.logger?.warn?.(
        formatLogMessage("Sync completed with quote failures", {
          trigger,
          imported: importedCount,
          skipped: skippedCount,
          failed: failedCount,
          safeSince,
          accountId: this.id,
        }),
      );
    }
  }

  private async prepareExistingMintOperation(
    operationId: string,
  ): Promise<{ id: string }> {
    const service = this.ctx?.services.mintOperationService as unknown as {
      prepareInitOperation?: (operationId: string) => Promise<{ id: string }>;
    };

    if (typeof service.prepareInitOperation !== "function") {
      throw new Error(
        "Mint operation service cannot prepare existing init operations with this @cashu/coco-core version",
      );
    }

    return service.prepareInitOperation(operationId);
  }
}
