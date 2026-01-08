import { getEncodedToken, type PaymentRequestService } from "coco-cashu-core";
import { PaymentRequiredError, type NPCClient } from "npubcash-sdk";

export type SetUsernameResult =
  | { success: true }
  | {
      success: false;
      pr: Omit<PaymentRequiredError["paymentRequest"], "nut26">;
      acceptHandler: () => Promise<void>;
    };

export class PluginApi {
  private prService: PaymentRequestService;
  private client: NPCClient;

  constructor(prService: PaymentRequestService, client: NPCClient) {
    this.prService = prService;
    this.client = client;
  }

  async getInfo() {
    return this.client.getInfo();
  }

  async setUsername(username: string): Promise<SetUsernameResult> {
    try {
      await this.client.setUsername(username);
      return { success: true };
    } catch (e) {
      if (!(e instanceof PaymentRequiredError)) {
        throw e; // Re-throw unexpected errors
      }
      const creq = e.paymentRequest.toEncodedRequest();
      const cocoReq = await this.prService.processPaymentRequest(creq);
      if (!cocoReq.matchingMints[0]) {
        throw new Error("No matching mints");
      }
      const tx = await this.prService.preparePaymentRequestTransaction(
        cocoReq.matchingMints[0],
        cocoReq,
      );
      return {
        success: false,
        pr: cocoReq.paymentRequest,
        acceptHandler: async () => {
          await this.prService.handleInbandPaymentRequest(tx, async (token) => {
            const tokenString = getEncodedToken(token);
            await this.client.setUsername(username, tokenString);
          });
        },
      };
    }
  }
}
