import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsObject, ValidateNested, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class TranslationDto {
  @ApiProperty()
  @IsString()
  es: string;

  @ApiProperty()
  @IsString()
  en: string;
}

export class CreateNewsDto {
  @ApiProperty({ type: TranslationDto })
  @IsObject()
  @ValidateNested()
  @Type(() => TranslationDto)
  title: TranslationDto;

  @ApiProperty({ type: TranslationDto })
  @IsObject()
  @ValidateNested()
  @Type(() => TranslationDto)
  description: TranslationDto;

  @ApiProperty()
  @IsString()
  imageUrl: string;

  @ApiProperty()
  @IsString()
  date: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  link?: string;
}
