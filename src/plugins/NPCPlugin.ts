import type { Plugin } from "coco-cashu-core";

import {
  NPCAccountRuntime,
  type NPCPluginContext,
  npcRequiredServices,
} from "../accounts/NPCAccountRuntime";
import { NPCAccountApi, NPCPluginApi } from "../PluginApi";
import { MemorySinceStore, type SinceStore } from "../sync/sinceStore";
import {
  type AddNPCAccountOptions,
  type NPCAccountRecord,
  type NPCAccountStatus,
  type NPCAccountSummary,
  type NPCPluginOptions,
  type NPCPluginStatus,
  type Signer,
  type StructuredLogger,
  createChildLogger,
  isValidUrl,
} from "../types";

export type { NPCPluginOptions, NPCPluginStatus } from "../types";

type RequiredServices = typeof npcRequiredServices;

interface NormalizedAccountConfig {
  id: string;
  baseUrl: string;
  signer: Signer;
  syncIntervalMs?: number;
  useWebsocket: boolean;
  autoStart: boolean;
  explicitSinceStore?: SinceStore;
}

interface AccountEntry {
  runtime: NPCAccountRuntime;
  api: NPCAccountApi;
  config: NormalizedAccountConfig;
  createdAt: number;
}

/**
 * NPubCash plugin for coco-cashu-core.
 *
 * The plugin owns host-level registration while account runtimes own NPC
 * clients, signers, timers, websocket subscriptions, and quote sync state.
 */
export class NPCPlugin implements Plugin<RequiredServices> {
  readonly name = "npc";
  readonly required = npcRequiredServices;

  private readonly defaultBaseUrl?: string;
  private readonly accountStore?: NPCPluginOptions["accountStore"];
  private readonly sinceStoreFactory?: NPCPluginOptions["sinceStoreFactory"];
  private readonly syncIntervalMs?: number;
  private readonly useWebsocket: boolean;
  private readonly logger?: StructuredLogger;
  private readonly accounts = new Map<string, AccountEntry>();

  private ctx?: NPCPluginContext;
  private isReady = false;
  private isShuttingDown = false;
  private rootApi?: NPCPluginApi;

  constructor(options?: NPCPluginOptions) {
    if (options?.defaultBaseUrl && !isValidUrl(options.defaultBaseUrl)) {
      throw new Error(`Invalid defaultBaseUrl: ${options.defaultBaseUrl}`);
    }

    this.defaultBaseUrl = options?.defaultBaseUrl;
    this.accountStore = options?.accountStore;
    this.sinceStoreFactory = options?.sinceStoreFactory;
    this.syncIntervalMs = options?.syncIntervalMs;
    this.useWebsocket = !!options?.useWebsocket;
    this.logger = createChildLogger(options?.logger as StructuredLogger, {
      module: "npc",
    });
  }

  getStatus(): NPCPluginStatus {
    const summaries = this.listAccounts();

    return {
      isInitialized: this.ctx !== undefined,
      isReady: this.isReady,
      accountCount: summaries.length,
      runningAccountIds: summaries
        .filter((summary) => summary.isRunning)
        .map((summary) => summary.id),
      syncingAccountIds: summaries
        .filter((summary) => summary.isSyncing)
        .map((summary) => summary.id),
      websocketConnectedAccountIds: summaries
        .filter((summary) => summary.isWebSocketConnected)
        .map((summary) => summary.id),
    };
  }

  onInit(ctx: NPCPluginContext): () => Promise<void> {
    this.ctx = ctx;
    this.rootApi = new NPCPluginApi(this);
    ctx.registerExtension("npc", this.rootApi);

    for (const entry of this.accounts.values()) {
      entry.runtime.attachContext(ctx);
    }

    return async () => {
      await this.shutdown();
    };
  }

  onReady(): void {
    this.isReady = true;

    const ctx = this.ctx;
    if (ctx) {
      for (const entry of this.accounts.values()) {
        entry.runtime.attachContext(ctx);
        entry.runtime.markReady();
      }
    }

    for (const entry of this.accounts.values()) {
      if (entry.config.autoStart) {
        entry.runtime.start();
      }
    }
  }

  async addAccount(options: AddNPCAccountOptions): Promise<NPCAccountApi> {
    if (this.isShuttingDown) {
      throw new Error("Cannot add NPC account after plugin shutdown");
    }

    const config = this.normalizeAccountConfig(options);
    const existing = this.accounts.get(config.id);
    if (existing) {
      if (this.matchesConfig(existing.config, config)) {
        return existing.api;
      }
      throw new Error(
        `NPC account "${config.id}" already exists with different configuration; remove it before re-adding`,
      );
    }

    const sinceStore = await this.resolveSinceStore(options, config);
    const runtime = new NPCAccountRuntime({
      id: config.id,
      baseUrl: config.baseUrl,
      signer: config.signer,
      sinceStore,
      syncIntervalMs: config.syncIntervalMs,
      useWebsocket: config.useWebsocket,
      autoStart: config.autoStart,
      logger: this.logger,
    });

    const ctx = this.ctx;
    if (ctx) {
      runtime.attachContext(ctx);
      if (this.isReady) {
        runtime.markReady();
      }
    }

    const now = Date.now();
    const entry: AccountEntry = {
      runtime,
      api: new NPCAccountApi(() => this.getPaymentRequestService(), runtime),
      config,
      createdAt: now,
    };

    const record = this.createAccountRecord(entry, now);
    await this.accountStore?.upsert(record);

    this.accounts.set(config.id, entry);

    if (this.isReady && config.autoStart) {
      runtime.start();
    }

    return entry.api;
  }

  async removeAccount(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId);
    if (!entry) return;

    await this.accountStore?.remove(accountId);
    await entry.runtime.shutdown();
    this.accounts.delete(accountId);
  }

  getAccount(accountId: string): NPCAccountApi | undefined {
    return this.accounts.get(accountId)?.api;
  }

  listAccounts(): NPCAccountSummary[] {
    return Array.from(this.accounts.values()).map((entry) =>
      entry.runtime.getSummary(),
    );
  }

  async syncAll(): Promise<void> {
    await Promise.all(
      Array.from(this.accounts.values()).map((entry) => entry.runtime.sync()),
    );
  }

  async shutdownAccount(accountId: string): Promise<void> {
    await this.accounts.get(accountId)?.runtime.shutdown();
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    await Promise.all(
      Array.from(this.accounts.values()).map((entry) =>
        entry.runtime.shutdown(),
      ),
    );
  }

  private normalizeAccountConfig(
    options: AddNPCAccountOptions,
  ): NormalizedAccountConfig {
    const id = options.id.trim();
    if (!id) {
      throw new Error("NPC account id is required");
    }

    const baseUrl = options.baseUrl ?? this.defaultBaseUrl;
    if (!baseUrl) {
      throw new Error(
        `NPC account "${id}" requires a baseUrl or plugin defaultBaseUrl`,
      );
    }
    if (!isValidUrl(baseUrl)) {
      throw new Error(`Invalid baseUrl for NPC account "${id}": ${baseUrl}`);
    }

    return {
      id,
      baseUrl,
      signer: options.signer,
      syncIntervalMs: options.syncIntervalMs ?? this.syncIntervalMs,
      useWebsocket: options.useWebsocket ?? this.useWebsocket,
      autoStart: options.autoStart ?? true,
      explicitSinceStore: options.sinceStore,
    };
  }

  private matchesConfig(
    existing: NormalizedAccountConfig,
    incoming: NormalizedAccountConfig,
  ): boolean {
    return (
      existing.id === incoming.id &&
      existing.baseUrl === incoming.baseUrl &&
      existing.signer === incoming.signer &&
      existing.syncIntervalMs === incoming.syncIntervalMs &&
      existing.useWebsocket === incoming.useWebsocket &&
      existing.autoStart === incoming.autoStart &&
      existing.explicitSinceStore === incoming.explicitSinceStore
    );
  }

  private async resolveSinceStore(
    options: AddNPCAccountOptions,
    config: NormalizedAccountConfig,
  ): Promise<SinceStore> {
    if (options.sinceStore) {
      return options.sinceStore;
    }
    if (this.sinceStoreFactory) {
      return this.sinceStoreFactory(config.id, config.baseUrl);
    }
    return new MemorySinceStore(0);
  }

  private getPaymentRequestService(): NPCPluginContext["services"]["paymentRequestService"] {
    const prService = this.ctx?.services.paymentRequestService;
    if (!prService) {
      throw new Error("NPC plugin must be initialized before adding accounts");
    }
    return prService;
  }

  private createAccountRecord(
    entry: AccountEntry,
    updatedAt: number,
  ): NPCAccountRecord {
    return {
      id: entry.config.id,
      baseUrl: entry.config.baseUrl,
      syncIntervalMs: entry.config.syncIntervalMs,
      useWebsocket: entry.config.useWebsocket,
      autoStart: entry.config.autoStart,
      createdAt: entry.createdAt,
      updatedAt,
    };
  }
}

export type { NPCAccountStatus, NPCAccountSummary };
