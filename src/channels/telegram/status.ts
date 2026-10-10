/**
 * Telegram connectivity as seen by the poller and exposed to health (#8).
 * Issue #9 fixes the contract to two values: `connected` (the last `getUpdates` succeeded) and
 * `disconnected` (anything else: conflict, bad token, rate limit or network error).
 */
export type TelegramConnectionState = "connected" | "disconnected";

/**
 * Why the poller is `disconnected`, for diagnostics and runbooks; never part of the health contract.
 * - `conflict`: HTTP 409, another poller or a webhook is active.
 * - `unauthorized`: HTTP 401/404, the bot token is bad or revoked; needs an operator.
 * - `rate_limited`: HTTP 429.
 * - `network`: any other failure; the poller keeps retrying.
 */
export type TelegramFailureReason = "conflict" | "unauthorized" | "rate_limited" | "network";

/**
 * Shared Telegram connectivity flag. The poller writes it; the health check (#8) reads it.
 * Starts `disconnected` (reason `null`) until the first successful `getUpdates` call.
 */
export class TelegramStatus {
  private state: TelegramConnectionState = "disconnected";
  private failure: TelegramFailureReason | null = null;

  get(): TelegramConnectionState {
    return this.state;
  }

  /** The reason for the current `disconnected` state, or `null` when connected or not yet polled. */
  reason(): TelegramFailureReason | null {
    return this.failure;
  }

  setConnected(): void {
    this.state = "connected";
    this.failure = null;
  }

  setDisconnected(reason: TelegramFailureReason): void {
    this.state = "disconnected";
    this.failure = reason;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }
}
