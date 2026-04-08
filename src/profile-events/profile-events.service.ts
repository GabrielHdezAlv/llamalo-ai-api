import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';
import * as admin from 'firebase-admin';

/**
 * Conexiones WebSocket por usuario (misma ruta /profile/events).
 * Permite empujar `profile_updated` cuando cambian plan, cupo o perfil en servidor.
 */
@Injectable()
export class ProfileEventsService {
  private readonly logger = new Logger(ProfileEventsService.name);
  private readonly userSockets = new Map<string, Set<WebSocket>>();
  private readonly lastNotifyAt = new Map<string, number>();
  private static readonly NOTIFY_THROTTLE_MS = 2500;

  handleConnection(ws: WebSocket): void {
    ws.once('message', async (raw: WebSocket.RawData) => {
      try {
        const buf = Buffer.isBuffer(raw)
          ? raw
          : Buffer.from(String(raw), 'utf8');
        const parsed = JSON.parse(buf.toString('utf8')) as {
          type?: string;
          token?: string;
        };
        if (parsed.type !== 'auth' || !parsed.token) {
          ws.send(JSON.stringify({ type: 'error', message: 'auth_required' }));
          ws.close();
          return;
        }
        const decoded = await admin.auth().verifyIdToken(parsed.token);
        const userId = decoded.uid;
        if (!this.userSockets.has(userId)) {
          this.userSockets.set(userId, new Set());
        }
        this.userSockets.get(userId)!.add(ws);
        ws.send(JSON.stringify({ type: 'ready' }));

        const cleanup = () => {
          const set = this.userSockets.get(userId);
          if (set) {
            set.delete(ws);
            if (set.size === 0) this.userSockets.delete(userId);
          }
        };
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      } catch (e) {
        this.logger.warn(
          `Profile WS auth failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        } catch {
          /* ignore */
        }
        ws.close();
      }
    });
  }

  notifyProfileUpdated(userId: string): void {
    const now = Date.now();
    const last = this.lastNotifyAt.get(userId) ?? 0;
    if (now - last < ProfileEventsService.NOTIFY_THROTTLE_MS) {
      return;
    }
    this.lastNotifyAt.set(userId, now);

    const set = this.userSockets.get(userId);
    if (!set || set.size === 0) return;
    const payload = JSON.stringify({ type: 'profile_updated' });
    for (const socket of set) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
