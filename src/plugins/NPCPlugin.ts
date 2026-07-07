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

type QuoteSyncStatus = "imported" | "skipped" | "failed" | "blocked";

/**
 * Policy controlling which quote mints the plugin may import into coco.
 */
export type NPCQuoteMintPolicy =
  | { mode: "trusted-only" }
  | { mode: "allow-list"; mintUrls: readonly string[] }
  | { mode: "auto-trust" };

/**
 * A paid NPC quote that was not imported because host mint policy blocked it.
 */
export interface NPCBlockedQuote {
  mintUrl: string;
  quoteId: string;
  paidAt: number;
}

/**
 * A paid NPC quote that failed during import.
 */
export interface NPCFailedQuote {
  mintUrl: string;
  quoteId: string;
  paidAt: number;
  error: string;
}

/**
 * Report from the most recent sync cycle.
 */
export interface NPCSyncReport {
  since: number;
  newSince: number;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
  blockedQuotes: NPCBlockedQuote[];
  failedQuotes: NPCFailedQuote[];
}

interface QuoteSyncResult {
  mintUrl: string;
  quoteId: string;
  paidAt: number;
  status: QuoteSyncStatus;
  error?: string;
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

  /**
   * Policy controlling which quote mints the plugin may import.
   * Defaults to requiring a mint that the host wallet already trusts.
   */
  quoteMintPolicy?: NPCQuoteMintPolicy;
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
  /** Paid quotes currently blocked by quote mint policy */
  blockedQuotes: NPCBlockedQuote[];
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
  private readonly quoteMintPolicy: NPCQuoteMintPolicy;

  private isRunning = false;
  private hasPendingUpdate = false;
  private runPromise?: Promise<NPCSyncReport>;
  private unsubscribe?: () => void;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private isReady = false;
  private isWebSocketConnected = false;
  private wsReconnectAttempts = 0;
  private wsReconnectTimer?: ReturnType<typeof setTimeout>;
  private ctx?: PluginContext<typeof requiredServices>;
  private isShuttingDown = false;
  private readyWaiters: Array<() => void> = [];
  private lastSyncReport: NPCSyncReport = {
    since: 0,
    newSince: 0,
    importedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    blockedQuotes: [],
    failedQuotes: [],
  };

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

    const { syncIntervalMs, useWebsocket, sinceStore, logger, quoteMintPolicy } =
      options ?? {};

    this.sinceStore = sinceStore ?? new MemorySinceStore(0);
    this.logger = createChildLogger(logger as StructuredLogger, {
      module: "npc",
    });
    this.intervalMs = syncIntervalMs;
    this.useWebsocket = !!useWebsocket;
    this.quoteMintPolicy = quoteMintPolicy ?? { mode: "trusted-only" };

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
      blockedQuotes: [...this.lastSyncReport.blockedQuotes],
    };
  }

  /**
   * Returns the report from the most recent sync cycle.
   */
  getLastSyncReport(): NPCSyncReport {
    return {
      ...this.lastSyncReport,
      blockedQuotes: [...this.lastSyncReport.blockedQuotes],
      failedQuotes: [...this.lastSyncReport.failedQuotes],
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
        this.getStatus.bind(this),
        this.getLastSyncReport.bind(this),
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
  async sync(): Promise<NPCSyncReport> {
    const isReady = await this.waitUntilReady();
    if (!isReady) return this.getLastSyncReport();

    return this.requestSync("manual");
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

  private async requestSync(trigger: SyncTrigger): Promise<NPCSyncReport> {
    if (!this.isReady || this.isShuttingDown) {
      return this.getLastSyncReport();
    }

    // If already running, mark pending update and return existing promise
    if (this.isRunning) {
      this.hasPendingUpdate = true;
      return this.runPromise ?? Promise.resolve(this.getLastSyncReport());
    }

    this.hasPendingUpdate = true;
    this.startRunner(trigger);
    return this.runPromise ?? Promise.resolve(this.getLastSyncReport());
  }

  private startRunner(trigger: SyncTrigger): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.isRunning = true;
    this.runPromise = (async () => {
      let report = this.getLastSyncReport();
      try {
        do {
          this.hasPendingUpdate = false;
          report = await this.syncPaidQuotesOnce({
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
      return report;
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
  }): Promise<NPCSyncReport> {
    const { mintOperationService, mintService, trigger } = options;
    const since = await this.sinceStore.get();
    const emptyReport = this.createSyncReport({ since, newSince: since });

    this.logger?.debug?.(formatLogMessage("Starting sync", { since, trigger }));

    const rawQuotes = await this.npcClient.getQuotesSince(since);

    if (!rawQuotes || rawQuotes.length === 0) {
      this.logger?.debug?.("No new quotes");
      this.lastSyncReport = emptyReport;
      return this.getLastSyncReport();
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
      this.lastSyncReport = emptyReport;
      return this.getLastSyncReport();
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

        let mintAllowed = false;
        let mintPrepareError: string | undefined;
        try {
          mintAllowed = await this.prepareMintForQuoteImport(
            mintService,
            mintUrl,
          );
        } catch (err) {
          mintPrepareError = String(err);
          this.logger?.error?.(
            formatLogMessage("Failed to prepare mint for quotes", {
              err: mintPrepareError,
              mintUrl,
              quoteCount: list.length,
              policyMode: this.quoteMintPolicy.mode,
            }),
          );
        }

        if (!mintAllowed) {
          for (const quote of list) {
            results.push({
              mintUrl,
              quoteId: quote.quoteId,
              paidAt: quote.paidAt,
              status: mintPrepareError ? "failed" : "blocked",
              error: mintPrepareError,
            });
          }
          this.logger?.warn?.(
            formatLogMessage("Skipped quotes before import", {
              mintUrl,
              quoteCount: list.length,
              policyMode: this.quoteMintPolicy.mode,
              reason: mintPrepareError ? "mint-prepare-failed" : "blocked",
            }),
          );
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
              error: String(err),
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
            blocked: results.filter((result) => result.status === "blocked")
              .length,
          }),
        );

        return results;
      }),
    );

    const quoteResults = mintResults.flat();
    const unresolvedPaidAt = quoteResults
      .filter(
        (result) =>
          result.status === "failed" || result.status === "blocked",
      )
      .reduce<number | undefined>((min, result) => {
        if (min === undefined) {
          return result.paidAt;
        }
        return Math.min(min, result.paidAt);
      }, undefined);

    let safeSince = since;
    for (const result of quoteResults) {
      if (unresolvedPaidAt !== undefined && result.paidAt >= unresolvedPaidAt) {
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
    const blockedQuotes = quoteResults
      .filter((result) => result.status === "blocked")
      .map((result) => ({
        mintUrl: result.mintUrl,
        quoteId: result.quoteId,
        paidAt: result.paidAt,
      }));
    const failedQuotes = quoteResults
      .filter((result) => result.status === "failed")
      .map((result) => ({
        mintUrl: result.mintUrl,
        quoteId: result.quoteId,
        paidAt: result.paidAt,
        error: result.error ?? "Unknown error",
      }));

    this.lastSyncReport = this.createSyncReport({
      since,
      newSince: safeSince,
      importedCount,
      skippedCount,
      failedCount,
      blockedQuotes,
      failedQuotes,
    });

    if (failedCount > 0 || blockedQuotes.length > 0) {
      this.logger?.warn?.(
        formatLogMessage("Sync completed with unresolved quotes", {
          trigger,
          imported: importedCount,
          skipped: skippedCount,
          failed: failedCount,
          blocked: blockedQuotes.length,
          unresolvedWatermark: unresolvedPaidAt,
          safeSince,
        }),
      );
    }

    return this.getLastSyncReport();
  }

  private createSyncReport(options: {
    since: number;
    newSince: number;
    importedCount?: number;
    skippedCount?: number;
    failedCount?: number;
    blockedQuotes?: NPCBlockedQuote[];
    failedQuotes?: NPCFailedQuote[];
  }): NPCSyncReport {
    return {
      since: options.since,
      newSince: options.newSince,
      importedCount: options.importedCount ?? 0,
      skippedCount: options.skippedCount ?? 0,
      failedCount: options.failedCount ?? 0,
      blockedQuotes: options.blockedQuotes ?? [],
      failedQuotes: options.failedQuotes ?? [],
    };
  }

  private async prepareMintForQuoteImport(
    mintService: PluginContext<
      typeof requiredServices
    >["services"]["mintService"],
    mintUrl: string,
  ): Promise<boolean> {
    switch (this.quoteMintPolicy.mode) {
      case "trusted-only":
        return this.isTrustedMint(mintService, mintUrl);
      case "allow-list":
        if (!this.quoteMintPolicy.mintUrls.includes(mintUrl)) {
          return false;
        }
        await this.cacheMintWithoutTrusting(mintService, mintUrl);
        return true;
      case "auto-trust":
        await mintService.addMintByUrl(mintUrl, { trusted: true });
        return true;
    }
  }

  private async isTrustedMint(
    mintService: PluginContext<
      typeof requiredServices
    >["services"]["mintService"],
    mintUrl: string,
  ): Promise<boolean> {
    if (typeof mintService.isTrustedMint !== "function") {
      return false;
    }

    try {
      return await mintService.isTrustedMint(mintUrl);
    } catch (err) {
      this.logger?.warn?.(
        formatLogMessage("Unable to determine mint trust", {
          err: String(err),
          mintUrl,
        }),
      );
      return false;
    }
  }

  private async cacheMintWithoutTrusting(
    mintService: PluginContext<
      typeof requiredServices
    >["services"]["mintService"],
    mintUrl: string,
  ): Promise<void> {
    await mintService.addMintByUrl(mintUrl);
  }
}
