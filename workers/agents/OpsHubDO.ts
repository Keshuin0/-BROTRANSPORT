import { DurableObject } from 'cloudflare:workers';
import type { CloudflareEnv } from '../../src/env.js';
import type { HubBroadcastEvent } from './hubEvents.js';

export type { HubEventType, HubBroadcastEvent } from './hubEvents.js';
export { emitHubEvent } from './hubEvents.js';

/**
 * Global Stateful WebSocket Pub/Sub Hub using Cloudflare Durable Objects Hibernation API.
 * Fans out live logistics, customs, AI OCR, billing, and telematics updates in <50ms.
 */
export class OpsHubDO extends DurableObject<CloudflareEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal broadcast endpoint called by Workers, Cron jobs, and Workflows
    if (request.method === 'POST' && url.pathname === '/broadcast') {
      const event = (await request.json()) as HubBroadcastEvent;
      const delivered = this.broadcast(event);
      return new Response(JSON.stringify({ ok: true, delivered }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Live connection count diagnostics
    if (request.method === 'GET' && url.pathname === '/stats') {
      const sockets = this.ctx.getWebSockets();
      return new Response(JSON.stringify({ connectedClients: sockets.length }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // WebSocket upgrade (channel verified by gateway ticket before forwarding here)
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const channel = url.searchParams.get('channel') || 'public:borders';
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server, [channel, 'global']);
      server.send(
        JSON.stringify({
          type: 'CONNECTED',
          channel,
          timestamp: Date.now(),
        }),
      );

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not Found', { status: 404 });
  }

  broadcast(event: HubBroadcastEvent): number {
    const message = JSON.stringify(event);
    const sockets = this.ctx.getWebSockets(event.channel || 'global');
    let delivered = 0;

    for (const ws of sockets) {
      try {
        ws.send(message);
        delivered++;
      } catch {
        try {
          ws.close(1011, 'Send failed');
        } catch {
          // ignore close errors on dead sockets
        }
      }
    }
    return delivered;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message === 'string' && message === 'ping') {
      ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
    }
  }

  webSocketClose(ws: WebSocket): void {
    try {
      ws.close(1000, 'Closed');
    } catch {
      // ignore
    }
  }
}
