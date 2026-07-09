import { getEncodedToken, type PaymentRequestService } from "coco-cashu-core";
import { PaymentRequiredError, type NPCClient } from "npubcash-sdk";
import type {
  NPCPluginStatus,
  NPCSyncReport,
} from "./plugins/NPCPlugin";

export type SetUsernameResult =
  | { success: true }
  | {
      success: false;
      pr: Omit<PaymentRequiredError["paymentRequest"], "nut26">;
    };

export class PluginApi {
  private prService: PaymentRequestService;
  private client: NPCClient;
  private syncQuotes: () => Promise<NPCSyncReport>;
  private getPluginStatus: () => NPCPluginStatus;
  private getPluginSyncReport: () => NPCSyncReport;

  /**
   * Creates a plugin API wrapper around payment and NPC clients.
   * @param prService Service for handling Cashu payment requests.
   * @param client NPC client used for API calls.
   */
  constructor(
    prService: PaymentRequestService,
    client: NPCClient,
    syncQuotes: () => Promise<NPCSyncReport>,
    getPluginStatus: () => NPCPluginStatus,
    getPluginSyncReport: () => NPCSyncReport,
  ) {
    this.prService = prService;
    this.client = client;
    this.syncQuotes = syncQuotes;
    this.getPluginStatus = getPluginStatus;
    this.getPluginSyncReport = getPluginSyncReport;
  }

  /**
   * Fetches NPC server metadata and capability information.
   */
  async getInfo() {
    return this.client.getInfo();
  }

  /**
   * Sets the user's NPC username, handling payment-required flows when needed.
   * @param username Desired username to set.
   * @param attemptPayment If true, automatically attempt to pay if payment is required.
   * @returns Result indicating success or payment instructions.
   */
  async setUsername(
    username: string,
    attemptPayment?: boolean,
  ): Promise<SetUsernameResult> {
    try {
      await this.client.setUsername(username);
      return { success: true };
    } catch (e) {
      if (!(e instanceof PaymentRequiredError)) {
        throw e; // Re-throw unexpected errors
      }
      const creq = e.paymentRequest.toEncodedRequest();
      if (attemptPayment) {
        const cocoReq = await this.prService.processPaymentRequest(creq);
        if (!cocoReq.matchingMints[0]) {
          return { success: false, pr: e.paymentRequest };
        }
        const tx = await this.prService.preparePaymentRequestTransaction(
          cocoReq.matchingMints[0],
          cocoReq,
        );
        await this.prService.handleInbandPaymentRequest(tx, async (token) => {
          const tokenString = getEncodedToken(token);
          await this.client.setUsername(username, tokenString);
        });
        return {
          success: true,
        };
      }
      return {
        success: false,
        pr: e.paymentRequest,
      };
    }
  }

  /**
   * Retrieves NPC quotes created since a given Unix timestamp.
   * This will only display the quotes. It will not automatically handle them through coco.
   * @param sinceUnix Unix timestamp (seconds) to query from.
   */
  async getQuotesSince(sinceUnix: number) {
    return this.client.getQuotesSince(sinceUnix);
  }

  /**
   * Triggers a plugin sync cycle through the host integration.
   */
  async sync(): Promise<NPCSyncReport> {
    return this.syncQuotes();
  }

  /**
   * Returns plugin lifecycle and sync policy status.
   */
  getStatus(): NPCPluginStatus {
    return this.getPluginStatus();
  }

  /**
   * Returns the report from the most recent plugin sync cycle.
   */
  getLastSyncReport(): NPCSyncReport {
    return this.getPluginSyncReport();
  }

  /**
   * Updates the NPC account's preferred server-side mint URL.
   */
  async setMintUrl(
    mintUrl: string,
  ): Promise<Awaited<ReturnType<NPCClient["settings"]["setMintUrl"]>>> {
    return this.client.settings.setMintUrl(mintUrl);
  }

  /**
   * Enables or disables server-side quote locking for the NPC account.
   */
  async setLockQuotes(
    lock: boolean,
  ): Promise<Awaited<ReturnType<NPCClient["settings"]["setLock"]>>> {
    return this.client.settings.setLock(lock);
  }
}
