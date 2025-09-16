import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import { syncPaidQuotesOnce } from "../sync/syncPaidQuotes";

const requiredServices = ["mintQuoteService"] as const;

export class NPCPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npubcashPlugin";
  readonly required = requiredServices;
  private npcClient: NPCClient;
  private sinceGetter: () => Promise<number>;
  private sinceSetter: (since: number) => Promise<void>;
  private logger?: Logger;
  private pollIntervalMs: number;
  private pollTimer?: ReturnType<typeof setInterval>;
  private isPolling = false;
  private isReady = false;
  private ctx?: PluginContext<typeof requiredServices>;

  constructor(
    baseUrl: string,
    signer: any,
    sinceGetter: () => Promise<number>,
    sinceSetter: (since: number) => Promise<void>,
    logger?: Logger,
    pollIntervalMs = 25000
  ) {
    this.sinceGetter = sinceGetter;
    this.sinceSetter = sinceSetter;
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
          : logger
      )
    );
  }

  onInit(ctx: PluginContext<typeof requiredServices>): void | Promise<void> {
    this.ctx = ctx;
    ctx.registerCleanup(async () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    });
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
          sinceGetter: this.sinceGetter,
          sinceSetter: this.sinceSetter,
          mintQuoteService: ctx.services.mintQuoteService,
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
