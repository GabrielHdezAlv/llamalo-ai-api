import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { SystemLogsService } from './system-logs.service';
import { FirebaseAuthGuard } from '../auth/firebase-auth.guard';

@ApiTags('system-logs')
@ApiBearerAuth()
@Controller('system-logs')
@UseGuards(FirebaseAuthGuard)
export class SystemLogsController {
  constructor(private readonly systemLogsService: SystemLogsService) {}

  @Get()
  @ApiOperation({ summary: 'Obtener el registro básico de errores del sistema (llamadas fallidas, MailerSend, etc)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getLogs(@Query('limit') limit?: string) {
    const limitNum = limit ? parseInt(limit, 10) : 100;
    return this.systemLogsService.getLogs(limitNum);
  }
}
