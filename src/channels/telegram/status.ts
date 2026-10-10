export type TelegramConnectionState = "connected" | "disconnected";

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
