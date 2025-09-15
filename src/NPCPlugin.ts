/**
 * NPCPlugin bridges an NPubCash (NPC) server into coco-cashu-core.
 *
 * It periodically polls the NPC server for newly paid quotes since a
 * persisted timestamp and forwards them to `mintQuoteService.addExistingMintQuotes`.
 *
 * Persistence is provided by the host application via `sinceGetter` and
 * `sinceSetter` so the plugin can resume from where it left off across restarts.
 *
 * The plugin is designed to be registered with coco-cashu-core which will call
 * `onInit` and manage lifecycle cleanup.
 */
import type { Logger, MintQuote, Plugin, PluginContext } from "coco-cashu-core";
import { JWTAuthProvider, NPCClient } from "npubcash-sdk";

/** Services required by this plugin. */
const requiredServices = ["mintQuoteService"] as const;

export class NPCPlugin implements Plugin<typeof requiredServices> {
  /** Plugin name exposed to coco-cashu-core. */
  readonly name = "npubcashPlugin";
  /** Declares which services must be available in the host. */
  readonly required = requiredServices;
  /** Low-level client used to talk to the NPC server. */
  private npcClient: NPCClient;
  /** Reads the last processed `paidAt` timestamp. */
  private sinceGetter: () => Promise<number>;
  /** Persists the last processed `paidAt` timestamp. */
  private sinceSetter: (since: number) => Promise<void>;
  /** Optional logger compatible with coco-cashu-core's `Logger`. */
  private logger?: Logger;
  /** Polling interval in milliseconds. Defaults to 25 seconds. */
  private pollIntervalMs: number;
  /** Handle to the internal polling timer. */
  private pollTimer?: ReturnType<typeof setInterval>;
  /** Reentrancy guard to avoid overlapping poll cycles. */
  private isPolling = false;

  /**
   * Create a new NPCPlugin.
   *
   * @param baseUrl - Base URL of the NPC server (e.g. `https://npc.example.com`).
   * @param signer - Signer used by `JWTAuthProvider` for authenticating to NPC.
   * @param sinceGetter - Async function returning the last processed `paidAt` timestamp (ms).
   * @param sinceSetter - Async function to persist the latest processed `paidAt` timestamp (ms).
   * @param logger - Optional logger; child loggers are derived when available.
   * @param pollIntervalMs - Polling interval in milliseconds. Default: 25000.
   *
   * @example
   * const plugin = new NPCPlugin(
   *   "https://npc.example.com",
   *   signer,
   *   async () => lastSince,
   *   async (since) => { lastSince = since },
   *   logger,
   *   25000
   * );
   */
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
