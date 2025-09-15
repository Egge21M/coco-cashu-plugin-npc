import type { Logger, MintQuote, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";

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
    this.pollTimer = setInterval(async () => {
      if (this.isPolling) return;
      this.isPolling = true;
      try {
        const since = (await this.getSinceTimestamp()) ?? 0;
        const quotes = await this.npcClient.getQuotesSince(since);
        if (!quotes || quotes.length === 0) return;
        const cocoQuoteMap: { [mintUrl: string]: MintQuote[] } = {};
        for (const quote of quotes) {
          const mintUrl = quote.mintUrl;
          if (!cocoQuoteMap[mintUrl]) cocoQuoteMap[mintUrl] = [];
          const cocoQuote: MintQuote = {
            ...quote,
            unit: "sat",
            expiry: quote.expiresAt,
            state: "PAID",
            quote: quote.quoteId,
          };
          cocoQuoteMap[mintUrl].push(cocoQuote);
        }
        await Promise.all(
          Object.entries(cocoQuoteMap).map(([mintUrl, list]) =>
            ctx.services.mintQuoteService.addExistingMintQuotes(mintUrl, list)
          )
        );
        const latestTimestamp = quotes.reduce(
          (max: number, q: any) => Math.max(max, q?.paidAt ?? 0),
          since
        );
        if (latestTimestamp > since) await this.sinceSetter(latestTimestamp);
      } catch (err) {
        this.logger?.error?.(err as any);
      } finally {
        this.isPolling = false;
      }
    }, this.pollIntervalMs);
    ctx.registerCleanup(async () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
    });
  }
  private async getSinceTimestamp(): Promise<number | undefined> {
    if (this.sinceGetter) {
      const since = await this.sinceGetter();
      return since;
    }
  }
}
