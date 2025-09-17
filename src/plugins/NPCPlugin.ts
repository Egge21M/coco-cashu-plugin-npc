import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import { syncPaidQuotesOnce } from "../sync/syncPaidQuotes";
import type { SinceStore } from "../sync/sinceStore";
import { MemorySinceStore } from "../sync/sinceStore";

const requiredServices = ["mintQuoteService", "mintService"] as const;

export class NPCPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npubcashPlugin";
  readonly required = requiredServices;
  private npcClient: NPCClient;
  private sinceStore: SinceStore;
  private logger?: Logger;
  private pollIntervalMs: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private isPolling = false;
  private isReady = false;
  private ctx?: PluginContext<typeof requiredServices>;

  constructor(
    baseUrl: string,
    signer: any,
    sinceStore?: SinceStore,
    logger?: Logger,
    pollIntervalMs = 25000,
  ) {
    this.sinceStore = sinceStore ?? new MemorySinceStore(0);
    this.logger =
      logger && (logger as any).child
        ? (logger as any).child({ module: "NPCPlugin" })
        : logger;
    this.pollIntervalMs = pollIntervalMs;
    this.npcClient = new NPCClient(
      baseUrl,
      new JWTAuthProvider(
        baseUrl,
        signer,
        logger && (logger as any).child
          ? (logger as any).child({ module: "NPC" })
          : logger,
      ),
    );
  }

  onInit(ctx: PluginContext<typeof requiredServices>) {
    this.ctx = ctx;
    return async () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    };
  }

  onReady(): void | Promise<void> {
    this.isReady = true;
    const ctx = this.ctx;
    if (!ctx) return;
    this.pollTimer = setInterval(async () => {
      if (!this.isReady) return;
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        await syncPaidQuotesOnce({
          npcClient: this.npcClient,
          sinceStore: this.sinceStore,
          mintQuoteService: ctx.services.mintQuoteService,
          mintService: ctx.services.mintService,
          logger: this.logger,
        });
      } catch (err) {
        this.logger?.error?.(err as any);
      } finally {
        this.isPolling = false;
      }
    }, this.pollIntervalMs);
  }
}
