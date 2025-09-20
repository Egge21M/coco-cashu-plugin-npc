import type { Logger, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";
import { syncPaidQuotesOnce } from "../sync/syncPaidQuotes";
import type { SinceStore } from "../sync/sinceStore";
import { MemorySinceStore } from "../sync/sinceStore";

const requiredServices = ["mintQuoteService", "mintService"] as const;

export class NPCWebsocketPlugin implements Plugin<typeof requiredServices> {
  readonly name = "npubcashPluginWebsocket";
  readonly required = requiredServices;
  private npcClient: NPCClient;
  private sinceStore: SinceStore;
  private logger?: Logger;
  private isReady = false;
  private isRunning = false;
  private hasPendingUpdate = false;
  private unsubscribe?: () => void;
  private ctx?: PluginContext<typeof requiredServices>;

  constructor(
    baseUrl: string,
    signer: any,
    sinceStore?: SinceStore,
    logger?: Logger
  ) {
    this.sinceStore = sinceStore ?? new MemorySinceStore(0);
    this.logger =
      logger && (logger as any).child
        ? (logger as any).child({ module: "NPCWebsocketPlugin" })
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

  onInit(ctx: PluginContext<typeof requiredServices>) {
    this.ctx = ctx;
  }

  onReady() {
    this.isReady = true;
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.unsubscribe) return; // already subscribed
    this.unsubscribe = this.npcClient.subscribe(
      () => {
        void this.handleUpdate();
      },
      (msg) => {
        this.logger?.error?.(msg as any);
      }
    );
    return () => {
      if (this.unsubscribe) {
        try {
          this.unsubscribe();
        } catch {}
        this.unsubscribe = undefined;
      }
    };
  }

  private async handleUpdate(): Promise<void> {
    if (!this.isReady) return;
    this.hasPendingUpdate = true;
    if (this.isRunning) return;
    const ctx = this.ctx;
    if (!ctx) return;
    this.isRunning = true;
    try {
      do {
        this.hasPendingUpdate = false;
        await syncPaidQuotesOnce({
          npcClient: this.npcClient,
          sinceStore: this.sinceStore,
          mintQuoteService: ctx.services.mintQuoteService,
          mintService: ctx.services.mintService,
          logger: this.logger,
        });
      } while (this.hasPendingUpdate);
    } catch (err) {
      this.logger?.error?.(err as any);
    } finally {
      this.isRunning = false;
    }
  }
}
