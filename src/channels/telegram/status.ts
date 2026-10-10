/**
 * Telegram connectivity as seen by the poller.
 * - `connected`: the last `getUpdates` succeeded.
 * - `disconnected`: network error or rate limit; the poller keeps retrying.
 * - `conflict`: HTTP 409, another poller or a webhook is active (health maps this to `degraded`).
 * - `unauthorized`: HTTP 401/404, the bot token is bad or revoked; needs an operator.
 */
export type TelegramConnectionState = "connected" | "disconnected" | "conflict" | "unauthorized";

/**
 * Shared Telegram connectivity flag. The poller writes it; the health check (#8) reads it.
 * Starts `disconnected` until the first successful `getUpdates` call.
 */
export class TelegramStatus {
  private state: TelegramConnectionState = "disconnected";

  get(): TelegramConnectionState {
    return this.state;
  }

  set(state: TelegramConnectionState): void {
    this.state = state;
  }

  isConnected(): boolean {
    return this.state === "connected";
  }
}
