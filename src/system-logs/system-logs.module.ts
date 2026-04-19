import { Module, Global } from '@nestjs/common';
import { SystemLogsService } from './system-logs.service';
import { SystemLogsController } from './system-logs.controller';
import { OwnerRoleGuard } from '../auth/owner-role.guard';

@Global()
@Module({
  controllers: [SystemLogsController],
  providers: [SystemLogsService, OwnerRoleGuard],
  exports: [SystemLogsService],
})
export class SystemLogsModule {}
