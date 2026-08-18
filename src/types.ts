import type { Logger } from "@cashu/coco-core";
import type { JWTAuthProvider, PaymentRequiredError } from "npubcash-sdk";

import type { SinceStore } from "./sync/sinceStore";

/**
 * Quote data returned from NPubCash API
 */
export interface NPCQuote {
  quoteId: string;
  mintUrl: string;
  amount: number;
  expiresAt: number;
  paidAt: number;
  request?: string;
  /** Additional properties from the API */
  [key: string]: unknown;
}

/**
 * Transformed quote ready for the mint operation service
 */
export interface MintQuote {
  quoteId: string;
  mintUrl: string;
  amount: number;
  expiry: number;
  paidAt: number;
  unit: string;
  state: string;
  quote: string;
  request: string;
  [key: string]: unknown;
}

/**
 * Signer type for JWT authentication.
 * This is intentionally typed as `unknown` to allow compatibility
 * with various signing implementations from npubcash-sdk.
 */
export type Signer = ConstructorParameters<typeof JWTAuthProvider>[1];

export type SetUsernameResult =
  | { success: true }
  | {
      success: false;
      pr: Omit<PaymentRequiredError["paymentRequest"], "nut26">;
    };

/**
 * Options used to add one NPubCash account runtime.
 */
export interface AddNPCAccountOptions {
  id: string;
  signer: Signer;
  baseUrl?: string;
  sinceStore?: SinceStore;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  autoStart?: boolean;
}

/**
 * Persisted metadata for a host-owned NPC account.
 *
 * Signer material is intentionally not included.
 */
export interface NPCAccountRecord {
  id: string;
  baseUrl: string;
  syncIntervalMs?: number;
  useWebsocket?: boolean;
  autoStart: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Optional host-provided metadata store for account registrations.
 */
export interface NPCAccountStore {
  list(): Promise<NPCAccountRecord[]>;
  upsert(record: NPCAccountRecord): Promise<void>;
  remove(accountId: string): Promise<void>;
}

/**
 * Creates a per-account SinceStore when one is not supplied explicitly.
 */
export type NPCSinceStoreFactory = (
  accountId: string,
  baseUrl: string,
) => SinceStore | Promise<SinceStore>;

/**
 * Configuration options for NPCPlugin.
 */
export interface NPCPluginOptions {
  /**
   * Default NPC server URL for accounts that do not provide one.
   */
  defaultBaseUrl?: string;

  /**
   * Optional host-owned store for account metadata.
   */
  accountStore?: NPCAccountStore;

  /**
   * Optional factory for creating account-scoped SinceStore instances.
   */
  sinceStoreFactory?: NPCSinceStoreFactory;

  /**
   * Default interval in milliseconds between sync operations.
   * If not provided, interval-based syncing is disabled by default.
   */
  syncIntervalMs?: number;

  /**
   * Enable WebSocket subscriptions by default for account runtimes.
   * @default false
   */
  useWebsocket?: boolean;

  /**
   * Logger instance for debugging and error reporting.
   */
  logger?: Logger;
}

/**
 * Account runtime status information.
 */
export interface NPCAccountStatus {
  id: string;
  isReady: boolean;
  isRunning: boolean;
  isSyncing: boolean;
  isWebSocketConnected: boolean;
  isShutdown: boolean;
}

/**
 * Account summary returned by the root extension API.
 */
export interface NPCAccountSummary extends NPCAccountStatus {
  baseUrl: string;
  autoStart: boolean;
  syncIntervalMs?: number;
  useWebsocket: boolean;
}

/**
 * Plugin status information.
 */
export interface NPCPluginStatus {
  isInitialized: boolean;
  isReady: boolean;
  accountCount: number;
  runningAccountIds: string[];
  syncingAccountIds: string[];
  websocketConnectedAccountIds: string[];
}

/**
 * Extended logger interface that supports structured logging
 */
export interface StructuredLogger extends Logger {
  child?(bindings: Record<string, unknown>): StructuredLogger;
}

/**
 * Creates a child logger if the logger supports it, otherwise returns the original
 */
export function createChildLogger(
  logger: StructuredLogger | undefined,
  bindings: Record<string, unknown>,
): StructuredLogger | undefined {
  if (!logger) return undefined;
  if (typeof logger.child === "function") {
    return logger.child(bindings);
  }
  return logger;
}

/**
 * Formats a log message with optional context data
 */
export function formatLogMessage(
  message: string,
  data?: Record<string, unknown>,
): string {
  if (!data || Object.keys(data).length === 0) {
    return message;
  }
  return `${message} ${JSON.stringify(data)}`;
}

/**
 * Default values for quote transformation
 */
export const QUOTE_DEFAULTS = {
  UNIT: "sat",
  STATE_PAID: "PAID",
} as const;

/**
 * Validates that a quote has required fields
 */
export function isValidQuote(quote: unknown): quote is NPCQuote {
  if (!quote || typeof quote !== "object") return false;
  const q = quote as Record<string, unknown>;
  return (
    typeof q.quoteId === "string" &&
    typeof q.mintUrl === "string" &&
    typeof q.paidAt === "number"
  );
}

/**
 * Validates that a string is a valid URL
 */
export function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
