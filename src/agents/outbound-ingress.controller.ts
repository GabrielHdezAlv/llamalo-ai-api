import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentsService } from './agents.service';
import { OutboundIngressLeadDto } from './dto/outbound-ingress-lead.dto';

@ApiTags('webhooks')
@Controller()
export class OutboundIngressController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post('webhooks/outbound/leads')
  @HttpCode(202)
  @ApiOperation({
    summary:
      'Encolar un contacto outbound (Make): cabecera X-Outbound-Key con la clave del agente',
  })
  async ingestOutboundLead(
    @Headers('x-outbound-key') key: string,
    @Body() body: OutboundIngressLeadDto,
  ): Promise<{ accepted: boolean }> {
    if (!key?.trim()) {
      throw new UnauthorizedException('Falta la cabecera X-Outbound-Key');
    }
    await this.agentsService.ingestOutboundLeadFromWebhook(key.trim(), body);
    return { accepted: true };
  }
}
