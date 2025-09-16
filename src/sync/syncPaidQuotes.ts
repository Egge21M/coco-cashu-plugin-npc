import type { Logger, MintQuote, ServiceMap } from "coco-cashu-core";
import type { NPCClient } from "npubcash-sdk";

export async function syncPaidQuotesOnce(options: {
  npcClient: NPCClient;
  sinceGetter: () => Promise<number>;
  sinceSetter: (since: number) => Promise<void>;
  mintQuoteService: ServiceMap["mintQuoteService"];
  logger?: Logger;
}): Promise<void> {
  const { npcClient, sinceGetter, sinceSetter, mintQuoteService, logger } =
    options;

  const since = (await sinceGetter()) ?? 0;
  // `getQuotesSince` comes from npubcash-sdk; returns paid quotes with fields we map below
  const quotes: any[] = await (npcClient as any).getQuotesSince(since);
  if (!quotes || quotes.length === 0) return;

  const mintUrlToQuotes: { [mintUrl: string]: MintQuote[] } = {};
  for (const quote of quotes) {
    const mintUrl: string = quote.mintUrl;
    if (!mintUrlToQuotes[mintUrl]) mintUrlToQuotes[mintUrl] = [];
    const cocoQuote: MintQuote = {
      ...quote,
      unit: "sat",
      expiry: quote.expiresAt,
      state: "PAID",
      quote: quote.quoteId,
    };
    mintUrlToQuotes[mintUrl].push(cocoQuote);
  }

  await Promise.all(
    Object.entries(mintUrlToQuotes).map(([mintUrl, list]) =>
      Promise.resolve(mintQuoteService.addExistingMintQuotes(mintUrl, list))
    )
  );

  const latestTimestamp = quotes.reduce(
    (max: number, q: any) => Math.max(max, q?.paidAt ?? 0),
    since
  );
  if (latestTimestamp > since) await sinceSetter(latestTimestamp);
}
