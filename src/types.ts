import type { Logger } from "coco-cashu-core";
import type { JWTAuthProvider } from "npubcash-sdk";

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
 * Transformed quote ready for mint quote service
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
