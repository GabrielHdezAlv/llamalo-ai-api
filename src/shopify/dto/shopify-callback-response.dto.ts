import { ApiProperty } from '@nestjs/swagger';

export class ShopifyCallbackResponseDto {
  @ApiProperty({
    example: true,
    description: 'Indica si la autenticación fue exitosa',
  })
  success: boolean;

  @ApiProperty({
    example: 'Token de acceso guardado correctamente',
    description: 'Mensaje descriptivo',
  })
  message: string;
}

