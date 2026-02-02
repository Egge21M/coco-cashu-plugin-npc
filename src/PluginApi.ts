import { getEncodedToken, type PaymentRequestService } from "coco-cashu-core";
import { PaymentRequiredError, type NPCClient } from "npubcash-sdk";

export type SetUsernameResult =
  | { success: true }
  | {
      success: false;
      pr: Omit<PaymentRequiredError["paymentRequest"], "nut26">;
    };

export class PluginApi {
  private prService: PaymentRequestService;
  private client: NPCClient;

  /**
   * Creates a plugin API wrapper around payment and NPC clients.
   * @param prService Service for handling Cashu payment requests.
   * @param client NPC client used for API calls.
   */
  constructor(prService: PaymentRequestService, client: NPCClient) {
    this.prService = prService;
    this.client = client;
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
}
