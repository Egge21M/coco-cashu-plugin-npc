import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import { syncPaidQuotesOnce } from "../sync/syncPaidQuotes";

const requiredServices = ["mintQuoteService"] as const;

export class NPCOnDemandPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npubcashPluginOnDemand";
  readonly required = requiredServices;
  private npcClient: NPCClient;
  private sinceGetter: () => Promise<number>;
  private sinceSetter: (since: number) => Promise<void>;
  private logger?: Logger;
  private isRunning = false;
  private ctx?: PluginContext<typeof requiredServices>;
  private isReady = false;

  constructor(
    baseUrl: string,
    signer: any,
    sinceGetter: () => Promise<number>,
    sinceSetter: (since: number) => Promise<void>,
    logger?: Logger
  ) {
    this.sinceGetter = sinceGetter;
    this.sinceSetter = sinceSetter;
    this.logger =
      logger && (logger as any).child
        ? (logger as any).child({ module: "NPCOnDemandPlugin" })
        : logger;
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
      // No interval to clean up.
    });
  }

  onReady(): void | Promise<void> {
    this.isReady = true;
  }

  async syncOnce(): Promise<void> {
    if (!this.isReady) return;
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const ctx = this.ctx;
      if (!ctx) throw new Error("NPCOnDemandPlugin not initialized");
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
      this.isRunning = false;
    }
  }
}
