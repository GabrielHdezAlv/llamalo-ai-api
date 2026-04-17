import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SystemLogsService } from './system-logs.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';
import { OwnerRoleGuard } from '../auth/owner-role.guard';

@ApiTags('system-logs')
@ApiBearerAuth()
@Controller('system-logs')
@UseGuards(FirebaseAuthGuard, OwnerRoleGuard)
export class SystemLogsController {
  constructor(private readonly systemLogsService: SystemLogsService) {}

  @Get()
  @ApiOperation({
    summary:
      'Obtener el registro básico de errores del sistema (llamadas fallidas, envío de email, etc.)',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getLogs(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.systemLogsService.getLogs(limitNum);
  }
}
