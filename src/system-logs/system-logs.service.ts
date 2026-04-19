import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

export enum LogType {
  CALL_FAILED = 'CALL_FAILED',
  /** @deprecated Preferir EMAIL_OUTBOUND_ERROR */
  MAILERSEND_ERROR = 'MAILERSEND_ERROR',
  EMAIL_OUTBOUND_ERROR = 'EMAIL_OUTBOUND_ERROR',
  SYSTEM_ERROR = 'SYSTEM_ERROR',
}

export interface ErrorLogData {
  type: LogType | string;
  message: string;
  reason?: string;
  metadata?: Record<string, any>;
  timestamp?: any;
}

@Injectable()
export class SystemLogsService {
  private readonly logger = new Logger(SystemLogsService.name);

  async logError(params: {
    type: LogType | string;
    message: string;
    reason?: string;
    metadata?: Record<string, any>;
  }) {
    try {
      const db = admin.firestore();
      await db.collection('system_error_logs').add({
        type: params.type,
        message: params.message,
        reason: params.reason || '',
        metadata: params.metadata || {},
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      this.logger.log(`[Error Log Registrado] ${params.type} - ${params.message}`);
    } catch (e) {
      this.logger.error('Error al guardar el log en system_error_logs:', e);
    }
  }

  async getLogs(limit = 100) {
    try {
      const db = admin.firestore();
      const snapshot = await db.collection('system_error_logs')
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map(doc => {
        const data = doc.data();
        return {
          id: doc.id,
          ...data,
          timestamp: data.timestamp ? data.timestamp.toDate() : null,
        };
      });
    } catch (e) {
      this.logger.error('Error obteniendo system_error_logs:', e);
      return [];
    }
  }
}
