import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UsersService } from './users.service';

@Injectable()
export class AccountDeletionSchedulerService {
  private readonly logger = new Logger(AccountDeletionSchedulerService.name);

  constructor(private readonly usersService: UsersService) {}

  // Ejecutar cada día a las 2:00 AM para procesar eliminaciones programadas
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async handleScheduledDeletions() {
    this.logger.log(
      '🔄 Iniciando procesamiento de eliminaciones programadas...',
    );

    try {
      const result = await this.usersService.processScheduledDeletions();
      this.logger.log(
        `✅ Procesamiento completado: ${result.deletedCount} cuenta(s) marcada(s) como eliminada(s)`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Error al procesar eliminaciones programadas: ${(error as Error).message}`,
      );
    }
  }
}
