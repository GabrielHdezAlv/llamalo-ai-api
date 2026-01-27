import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, MinLength } from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({
    example: 'NuevaContraseña123$',
    description: 'Nueva contraseña del usuario',
  })
  @IsNotEmpty()
  @MinLength(8)
  newPassword: string;

  @ApiProperty({
    example: 'NuevaContraseña123$',
    description: 'Confirmación de la nueva contraseña',
  })
  @IsNotEmpty()
  @MinLength(8)
  confirmPassword: string;
}
