import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import type { SinceStore } from "../sync/sinceStore";
import { MemorySinceStore } from "../sync/sinceStore";

const requiredServices = ["mintQuoteService", "mintService"] as const;

export interface NPCPluginOptions {
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  sinceStore?: SinceStore;
  logger?: Logger;
}

export class NPCPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npubcashPlugin";
  readonly required = requiredServices;
  private npcClient: NPCClient;
  private sinceStore: SinceStore;
  private logger?: Logger;
  private isRunning = false;
  private hasPendingUpdate = false;
  private runPromise?: Promise<void>;
  private unsubscribe?: () => void;
  private intervalMs?: number;
  private intervalTimer?: ReturnType<typeof setTimeout>;
  private useWebsocket: boolean;
  private isReady = false;
  private ctx?: PluginContext<typeof requiredServices>;

  constructor(baseUrl: string, signer: any, options?: NPCPluginOptions) {
    const { syncIntervalMs, useWebsocket, sinceStore, logger } = options ?? {};
    this.sinceStore = sinceStore ?? new MemorySinceStore(0);
    this.logger =
      logger && (logger as any).child
        ? (logger as any).child({ module: "NPCPlugin" })
        : logger;
    this.intervalMs = syncIntervalMs;
    this.useWebsocket = !!useWebsocket;
    this.npcClient = new NPCClient(
      baseUrl,
      new JWTAuthProvider(
        baseUrl,
        signer,
        logger && (logger as any).child
          ? (logger as any).child({ module: "NPC" })
          : logger
      )
    );
  }

  onInit(ctx: PluginContext<typeof requiredServices>) {
    this.ctx = ctx;
    return () => {
      this.teardown();
    };
  }

  onReady(): void | Promise<void> {
    this.isReady = true;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.useWebsocket && !this.unsubscribe) {
      this.unsubscribe = this.npcClient.subscribe(
        () => {
          void this.requestSync("websocket");
        },
        (msg) => {
          this.logger?.error?.(msg as any);
        }
      );
    }
    if (this.intervalMs !== undefined) {
      this.armIntervalTimer();
    }
  }

  async sync(): Promise<void> {
    await this.requestSync("manual");
  }

  private teardown() {
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    if (this.unsubscribe) {
      try {
        this.unsubscribe();
      } catch {}
      this.unsubscribe = undefined;
    }
  }

  private armIntervalTimer() {
    if (this.intervalMs === undefined) return;
    if (this.intervalTimer) {
      clearTimeout(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    this.intervalTimer = setTimeout(async () => {
      await this.requestSync("interval");
    }, this.intervalMs);
  }

  private async requestSync(
    trigger: "manual" | "websocket" | "interval"
  ): Promise<void> {
    if (!this.isReady) return;
    this.armIntervalTimer();
    if (this.isRunning && trigger !== "websocket") {
      return this.runPromise ?? Promise.resolve();
    }
    this.hasPendingUpdate = true;
    if (!this.isRunning) {
      this.startRunner();
    }
    return this.runPromise ?? Promise.resolve();
  }

  private startRunner() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.isRunning = true;
    this.runPromise = (async () => {
      try {
        do {
          this.hasPendingUpdate = false;
          await this.syncPaidQuotesOnce({
            mintQuoteService: ctx.services.mintQuoteService,
            mintService: ctx.services.mintService,
          });
        } while (this.hasPendingUpdate);
      } catch (err) {
        this.logger?.error?.(err as any);
      } finally {
        this.isRunning = false;
        this.runPromise = undefined;
      }
    })();
  }

  private async syncPaidQuotesOnce(options: {
    mintQuoteService: PluginContext<
      typeof requiredServices
    >["services"]["mintQuoteService"];
    mintService: PluginContext<
      typeof requiredServices
    >["services"]["mintService"];
  }): Promise<void> {
    const { mintQuoteService, mintService } = options;
    const since = (await this.sinceStore.get()) ?? 0;
    const quotes: any[] = await (this.npcClient as any).getQuotesSince(since);
    if (!quotes || quotes.length === 0) return;
    const mintUrlToQuotes: { [mintUrl: string]: any[] } = {};
    for (const quote of quotes) {
      const mintUrl: string = quote.mintUrl;
      if (!mintUrlToQuotes[mintUrl]) mintUrlToQuotes[mintUrl] = [];
      mintUrlToQuotes[mintUrl].push({
        ...quote,
        unit: "sat",
        expiry: quote.expiresAt,
        state: "PAID",
        quote: quote.quoteId,
      });
    }
    await Promise.all(
      Object.entries(mintUrlToQuotes).map(async ([mintUrl, list]) => {
        await mintService.addMintByUrl(mintUrl);
        await mintQuoteService.addExistingMintQuotes(mintUrl, list);
      })
    );
    const latestTimestamp = quotes.reduce(
      (max: number, q: any) => Math.max(max, q?.paidAt ?? 0),
      since
    );
    if (latestTimestamp > since) await this.sinceStore.set(latestTimestamp);
  }
}
