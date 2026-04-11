import { ApiProperty } from '@nestjs/swagger';

export class PanelAnalyticsDto {
  @ApiProperty({ enum: ['basic', 'advanced', 'full_export'] })
  tier: 'basic' | 'advanced' | 'full_export';

  @ApiProperty({
    description: 'Exportación CSV / datos completos (plan Scale)',
  })
  can_export_csv: boolean;
}
