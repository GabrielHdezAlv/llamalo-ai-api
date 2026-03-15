import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailerLiteService } from './mailerlite.service';

@Injectable()
export class MailerLiteScheduler {
  private readonly logger = new Logger(MailerLiteScheduler.name);

  constructor(private readonly mailerLiteService: MailerLiteService) {}

  // Sincronizar todos los usuarios cada día a las 3:00 AM
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleDailySync() {
    this.logger.log('Iniciando sincronización diaria con MailerLite...');
    try {
      await this.mailerLiteService.syncAllUsers();
      this.logger.log('Sincronización diaria con MailerLite completada con éxito.');
    } catch (error) {
      this.logger.error('Error durante la sincronización diaria con MailerLite:', error);
    }
  }
}
