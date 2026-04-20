import { Controller, Get, Head } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class HealthController {
  @Get('ping')
  @Head('ping')
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({ status: 200, description: 'Retorna "pong"' })
  ping(): string {
    return 'pong';
  }

  /**
   * Endpoint temporal para verificar la integración con Sentry.
   * Lanza una excepción a propósito: debe aparecer como issue en Sentry.
   * Eliminar (o proteger con guard) una vez validada la configuración.
   */
  @Get('debug-sentry')
  @ApiOperation({
    summary: 'Lanza un error de prueba para verificar Sentry (quitar en prod)',
  })
  debugSentry(): never {
    throw new Error('Sentry backend test error');
  }
}
