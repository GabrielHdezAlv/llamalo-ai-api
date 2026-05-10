import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Body público POST `/webhooks/outbound/leads` (Make). */
export class OutboundIngressLeadDto {
  @ApiProperty({ example: '+34600111222' })
  @IsNotEmpty()
  @IsString()
  @MaxLength(32)
  phone: string;

  @ApiProperty({ required: false, description: 'ISO 8601' })
  @IsOptional()
  @IsString()
  eventAt?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalEventId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  contactTicket?: number;

  @ApiProperty({ required: false, enum: ['new', 'recurring'] })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerState?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  cartTotal?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  cartItemCount?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  productHandle?: string;
}
