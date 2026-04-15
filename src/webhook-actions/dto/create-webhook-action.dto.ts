import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWebhookActionDto {
  @ApiProperty({ example: 'Crear ticket en CRM' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({
    example:
      'Úsalo cuando el usuario quiera dejar constancia o abrir un caso en soporte.',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(2000)
  description: string;

  @ApiProperty({
    example: 'https://hook.eu2.make.com/xxxxxxxx',
  })
  @IsString()
  @MinLength(12)
  @MaxLength(2048)
  webhookUrl: string;
}
