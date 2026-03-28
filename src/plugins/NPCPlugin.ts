import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import type { SinceStore } from "../sync/sinceStore";
import { MemorySinceStore } from "../sync/sinceStore";
import {
  type StructuredLogger,
  type NPCQuote,
  type Signer,
  QUOTE_DEFAULTS,
  createChildLogger,
  formatLogMessage,
  isValidQuote,
  isValidUrl,
} from "../types";
import { PluginApi } from "../PluginApi";

const requiredServices = [
  "mintOperationService",
  "mintService",
  "paymentRequestService",
] as const;

/** Trigger types for sync operations */
type SyncTrigger = "manual" | "websocket" | "interval";

type QuoteSyncStatus = "imported" | "skipped" | "failed";

interface QuoteSyncResult {
  mintUrl: string;
  quoteId: string;
  paidAt: number;
  status: QuoteSyncStatus;
}

/** Default WebSocket reconnection settings */
const WEBSOCKET_DEFAULTS = {
  /** Initial delay before first reconnection attempt */
  INITIAL_DELAY_MS: 5000,
  /** Maximum delay between reconnection attempts */
  MAX_DELAY_MS: 60000,
  /** Multiplier for exponential backoff */
  BACKOFF_MULTIPLIER: 2,
} as const;

/**
 * Configuration options for NPCPlugin
 */
export interface NPCPluginOptions {
  /**
   * Interval in milliseconds between sync operations.
   * If not provided, interval-based syncing is disabled.
   */
  syncIntervalMs?: number;

  /**
   * Enable WebSocket subscription for real-time updates.
   * When enabled, the plugin will receive push notifications for new quotes.
   * @default false
   */
  useWebsocket?: boolean;

  /**
   * Custom store for persisting the last processed timestamp.
   * Defaults to in-memory storage (state lost on restart).
   */
  sinceStore?: SinceStore;

  /**
   * Logger instance for debugging and error reporting.
   * If the logger has a `child` method, it will be used to create
   * a child logger with module context.
   */
  logger?: Logger;
}

/**
 * Plugin status information
 */
export interface NPCPluginStatus {
  /** Whether the plugin has been initialized */
  isInitialized: boolean;
  /** Whether the plugin is ready to sync */
  isReady: boolean;
  /** Whether a sync operation is currently running */
  isSyncing: boolean;
  /** Whether WebSocket is connected */
  isWebSocketConnected: boolean;
}

/**
 * NPubCash plugin for coco-cashu-core.
 *
 * This plugin bridges an NPubCash server with the coco-cashu wallet,
 * polling for newly paid quotes and forwarding them to the mint operation service.
 */
export class NPCPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npc";
  readonly required = requiredServices;

  private readonly npcClient: NPCClient;
  private readonly sinceStore: SinceStore;
  private readonly logger?: StructuredLogger;
  private readonly intervalMs?: number;
  private readonly useWebsocket: boolean;

  private isRunning = false;
  private hasPendingUpdate = false;
  private runPromise?: Promise<void>;
  private unsubscribe?: () => void;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private isReady = false;
  private isWebSocketConnected = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer?: ReturnType<typeof setTimeout>;
  private ctx?: PluginContext<typeof requiredServices>;
  private isShuttingDown = false;
  private readyWaiters: Array<() => void> = [];

  /**
   * Creates a new NPCPlugin instance.
   *
   * @param baseUrl - The base URL of the NPubCash server
   * @param signer - Signer instance for JWT authentication
   * @param options - Plugin configuration options
   * @throws {Error} If baseUrl is not a valid URL
   */
  constructor(baseUrl: string, signer: Signer, options?: NPCPluginOptions) {
    if (!isValidUrl(baseUrl)) {
      throw new Error(`Invalid baseUrl: ${baseUrl}`);
    }

    const { syncIntervalMs, useWebsocket, sinceStore, logger } = options ?? {};

    this.sinceStore = sinceStore ?? new MemorySinceStore(0);
    this.logger = createChildLogger(logger as StructuredLogger, {
      module: "npc",
    });
    this.intervalMs = syncIntervalMs;
    this.useWebsocket = !!useWebsocket;

    const npcLogger = createChildLogger(logger as StructuredLogger, {
      module: "npc-client",
    });

    this.npcClient = new NPCClient(
      baseUrl,
      new JWTAuthProvider(baseUrl, signer, npcLogger),
    );
  }

  /**
   * Returns the current status of the plugin.
   */
  getStatus(): NPCPluginStatus {
    return {
      isInitialized: this.ctx !== undefined,
      isReady: this.isReady,
      isSyncing: this.isRunning,
      isWebSocketConnected: this.isWebSocketConnected,
    };
  }

  /**
   * Called by coco-cashu-core during plugin initialization.
   * @internal
   */
  onInit(ctx: PluginContext<typeof requiredServices>): () => Promise<void> {
    this.ctx = ctx;
    ctx.registerExtension(
      "npc",
      new PluginApi(
        ctx.services.paymentRequestService,
        this.npcClient,
        this.sync.bind(this),
      ),
    );
    return async () => {
      await this.shutdown();
    };
  }

  /**
   * Called by coco-cashu-core when the host is ready.
   * @internal
   */
  onReady(): void {
    this.isReady = true;
    this.resolveReadyWaiters();

    const ctx = this.ctx;
    if (!ctx) return;

    if (this.useWebsocket) {
      this.connectWebSocket();
    }

    if (this.intervalMs !== undefined) {
      this.armIntervalTimer();
    }
  }

  /**
   * Manually triggers a sync operation.
   * If a sync is already in progress, returns the existing promise.
   *
   * @returns Promise that resolves when the sync completes
   */
  async sync(): Promise<void> {
    const isReady = await this.waitUntilReady();
    if (!isReady) return;

    await this.requestSync("manual");
  }

  /**
   * Gracefully shuts down the plugin.
   * Waits for any in-flight sync operations to complete.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.resolveReadyWaiters();
    this.teardown();

    // Wait for in-flight sync to complete
    if (this.runPromise) {
      try {
        await this.runPromise;
      } catch {
        // Ignore errors during shutdown
      }
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
          }),
        );
      }
    }
  }

  private connectWebSocket(): void {
    if (this.isShuttingDown || this.unsubscribe) return;

    try {
      this.unsubscribe = this.npcClient.subscribe(
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
            }),
          );
          this.disposeWebSocketSubscription();
          this.scheduleWebSocketReconnect();
        },
      );
      this.isWebSocketConnected = true;
    } catch (err) {
      this.logger?.error?.(
        formatLogMessage("Failed to connect WebSocket", { err: String(err) }),
      );
      this.scheduleWebSocketReconnect();
    }
  }

  private scheduleWebSocketReconnect(): void {
    if (this.isShuttingDown || this.wsReconnectTimer) return;

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
      }),
    );

    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = undefined;
      this.connectWebSocket();
    }, delay);
  }

  private armIntervalTimer(): void {
    if (this.intervalMs === undefined || this.isShuttingDown) return;

    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }

    this.intervalTimer = setTimeout(() => {
      void this.requestSync("interval");
    }, this.intervalMs);
  }

  private async requestSync(trigger: SyncTrigger): Promise<void> {
    if (!this.isReady || this.isShuttingDown) return;

    // If already running, mark pending update and return existing promise
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
            trigger,
          });
        } while (this.hasPendingUpdate && !this.isShuttingDown);
      } catch (err) {
        this.logger?.error?.(
          formatLogMessage("Sync failed", { err: String(err), trigger }),
        );
      } finally {
        if (!this.isShuttingDown) {
          this.armIntervalTimer();
        }
        this.isRunning = false;
        this.runPromise = undefined;
      }
    })();
  }

  private async syncPaidQuotesOnce(options: {
    mintOperationService: PluginContext<
      typeof requiredServices
    >["services"]["mintOperationService"];
    mintService: PluginContext<
      typeof requiredServices
    >["services"]["mintService"];
    trigger: SyncTrigger;
  }): Promise<void> {
    const { mintOperationService, mintService, trigger } = options;
    const since = await this.sinceStore.get();

    this.logger?.debug?.(formatLogMessage("Starting sync", { since, trigger }));

    const rawQuotes = await this.npcClient.getQuotesSince(since);

    if (!rawQuotes || rawQuotes.length === 0) {
      this.logger?.debug?.("No new quotes");
      return;
    }

    // Validate and filter quotes
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
            }),
          );
        }
      } else {
        this.logger?.warn?.(
          formatLogMessage("Skipping invalid quote", {
            raw: JSON.stringify(raw),
          }),
        );
      }
    }

    if (staleQuoteCount > 0) {
      this.logger?.debug?.(
        formatLogMessage("Skipped already-processed quotes", {
          count: staleQuoteCount,
          since,
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

    // Group quotes by mintUrl
    const mintUrlToQuotes = new Map<string, NPCQuote[]>();
    for (const quote of quotes) {
      const existing = mintUrlToQuotes.get(quote.mintUrl);
      if (existing) {
        existing.push(quote);
      } else {
        mintUrlToQuotes.set(quote.mintUrl, [quote]);
      }
    }

    // Process each mint
    const mintResults = await Promise.all(
      Array.from(mintUrlToQuotes.entries()).map(async ([mintUrl, list]) => {
        const results: QuoteSyncResult[] = [];
        const transformedQuotes = list.map((quote) => ({
          ...quote,
          unit: QUOTE_DEFAULTS.UNIT,
          expiry: quote.expiresAt,
          state: QUOTE_DEFAULTS.STATE_PAID,
          quote: quote.quoteId,
          request: quote.request ?? "",
        }));

        try {
          await mintService.addMintByUrl(mintUrl, { trusted: true });
        } catch (err) {
          this.logger?.error?.(
            formatLogMessage("Failed to add trusted mint for quotes", {
              err: String(err),
              mintUrl,
              quoteCount: list.length,
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

        for (let i = 0; i < transformedQuotes.length; i++) {
          const transformedQuote = transformedQuotes[i];
          if (!transformedQuote) {
            continue;
          }

          const existing = await mintOperationService.getOperationByQuote(
            mintUrl,
            transformedQuote.quote,
          );

          if (
            existing &&
            existing.state !== "init" &&
            existing.state !== "pending"
          ) {
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
              }),
            );
            continue;
          }

          try {
            await mintOperationService.importQuote(mintUrl, transformedQuote);
            results.push({
              mintUrl,
              quoteId: transformedQuote.quoteId,
              paidAt: transformedQuote.paidAt,
              status: "imported",
            });
          } catch (err) {
            results.push({
              mintUrl,
              quoteId: transformedQuote.quoteId,
              paidAt: transformedQuote.paidAt,
              status: "failed",
            });
            this.logger?.error?.(
              formatLogMessage("Failed to import quote", {
                err: String(err),
                mintUrl,
                quoteId: transformedQuote.quoteId,
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

    // Update the since timestamp
    if (safeSince > since) {
      await this.sinceStore.set(safeSince);
      this.logger?.debug?.(
        formatLogMessage("Updated since timestamp", {
          oldSince: since,
          newSince: safeSince,
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
        }),
      );
    }
  }
}
