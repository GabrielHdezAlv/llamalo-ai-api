import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class SetFirstInteractionDto {
  @ApiProperty({
    example: 'Hola, bienvenido a LlamaloIA. ¿En qué puedo ayudarte hoy?',
    description: 'Texto de la primera interacción del agente',
  })
  @IsNotEmpty()
  @IsString()
  firstInteraction: string;
}
