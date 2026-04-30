import { getEncodedToken, type PaymentRequestService } from "coco-cashu-core";
import { PaymentRequiredError } from "npubcash-sdk";

import type { NPCAccountRuntime } from "./accounts/NPCAccountRuntime";
import type { NPCPlugin } from "./plugins/NPCPlugin";
import type {
  AddNPCAccountOptions,
  NPCAccountStatus,
  NPCAccountSummary,
  NPCPluginStatus,
  SetUsernameResult,
} from "./types";

/**
 * Root NPC extension API registered on the host manager.
 */
export class NPCPluginApi {
  private readonly plugin: NPCPlugin;

  constructor(plugin: NPCPlugin) {
    this.plugin = plugin;
  }

  addAccount(options: AddNPCAccountOptions): Promise<NPCAccountApi> {
    return this.plugin.addAccount(options);
  }

  removeAccount(accountId: string): Promise<void> {
    return this.plugin.removeAccount(accountId);
  }

  getAccount(accountId: string): NPCAccountApi | undefined {
    return this.plugin.getAccount(accountId);
  }

  listAccounts(): NPCAccountSummary[] {
    return this.plugin.listAccounts();
  }

  getStatus(): NPCPluginStatus {
    return this.plugin.getStatus();
  }

  syncAll(): Promise<void> {
    return this.plugin.syncAll();
  }

  shutdownAccount(accountId: string): Promise<void> {
    return this.plugin.shutdownAccount(accountId);
  }
}

/**
 * Account-scoped NPC API.
 */
export class NPCAccountApi {
  readonly id: string;

  private readonly getPrService: () => PaymentRequestService;
  private readonly runtime: NPCAccountRuntime;

  constructor(
    getPrService: () => PaymentRequestService,
    runtime: NPCAccountRuntime,
  ) {
    this.id = runtime.id;
    this.getPrService = getPrService;
    this.runtime = runtime;
  }

  /**
   * Fetches NPC server metadata and account information.
   */
  async getInfo() {
    return this.runtime.client.getInfo();
  }

  /**
   * Sets the account username, handling payment-required flows when requested.
   */
  async setUsername(
    username: string,
    attemptPayment?: boolean,
  ): Promise<SetUsernameResult> {
    try {
      await this.runtime.client.setUsername(username);
      return { success: true };
    } catch (e) {
      if (!(e instanceof PaymentRequiredError)) {
        throw e;
      }
      const creq = e.paymentRequest.toEncodedRequest();
      if (attemptPayment) {
        const prService = this.getPrService();
        const cocoReq = await prService.processPaymentRequest(creq);
        if (!cocoReq.matchingMints[0]) {
          return { success: false, pr: e.paymentRequest };
        }
        const tx = await prService.preparePaymentRequestTransaction(
          cocoReq.matchingMints[0],
          cocoReq,
        );
        await prService.handleInbandPaymentRequest(tx, async (token) => {
          const tokenString = getEncodedToken(token);
          await this.runtime.client.setUsername(username, tokenString);
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
   * Retrieves raw NPC quotes created since a Unix timestamp.
   */
  async getQuotesSince(sinceUnix: number) {
    return this.runtime.client.getQuotesSince(sinceUnix);
  }

  /**
   * Triggers this account's quote sync cycle.
   */
  async sync(): Promise<void> {
    await this.runtime.sync();
  }

  start(): void {
    this.runtime.start();
  }

  stop(): Promise<void> {
    return this.runtime.stop();
  }

  getStatus(): NPCAccountStatus {
    return this.runtime.getStatus();
  }
}
