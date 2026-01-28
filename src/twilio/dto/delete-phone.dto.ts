import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsNotEmpty } from 'class-validator';

export class DeletePhoneDto {
  @ApiProperty({
    example: 1738000000000,
    description: 'ID único del número de teléfono a eliminar',
  })
  @IsNumber()
  @IsNotEmpty()
  phoneId: number;
}
