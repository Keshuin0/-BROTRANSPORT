export interface WsEventMessage {
  type: string;
  channel?: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}

/**
 * Auto-reconnecting exponential-backoff WebSocket client for OpsHubDO.
 * Always call `.disconnect()` on component unmount / Astro before-swap.
 */
export class BroWsClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryMs = 1000;
  private timerId: number | null = null;
  private channel: string;
  private onMessage: (msg: WsEventMessage) => void;
  private onStatus?: (status: 'connecting' | 'connected' | 'offline') => void;

  constructor(
    channel: string,
    onMessage: (msg: WsEventMessage) => void,
    onStatus?: (status: 'connecting' | 'connected' | 'offline') => void,
  ) {
    this.channel = channel;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
  }

  async connect(): Promise<void> {
    if (this.closedByUser || typeof window === 'undefined') return;
    this.onStatus?.('connecting');

    try {
      const ticketRes = await fetch('/api/ws/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: this.channel }),
      });
      if (!ticketRes.ok) {
        this.scheduleReconnect();
        return;
      }
      const { ticket } = (await ticketRes.json()) as { ticket?: string };
      if (!ticket) {
        this.scheduleReconnect();
        return;
      }

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/api/ws?channel=${encodeURIComponent(this.channel)}&ticket=${encodeURIComponent(ticket)}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.retryMs = 1000;
        this.onStatus?.('connected');
      };

      ws.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(String(evt.data)) as WsEventMessage;
          this.onMessage(parsed);
        } catch {
          // ignore non-JSON frames
        }
      };

      ws.onclose = () => {
        this.ws = null;
        this.onStatus?.('offline');
        if (!this.closedByUser) this.scheduleReconnect();
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch {
      this.onStatus?.('offline');
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || typeof window === 'undefined') return;
    if (this.timerId !== null) window.clearTimeout(this.timerId);
    this.timerId = window.setTimeout(() => {
      void this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(30_000, Math.round(this.retryMs * 1.8));
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.timerId !== null && typeof window !== 'undefined') {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client unmount');
      this.ws = null;
    }
  }
}
