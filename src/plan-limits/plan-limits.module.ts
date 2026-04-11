import { Global, Module } from '@nestjs/common';
import { PlanLimitsService } from './plan-limits.service';

@Global()
@Module({
  providers: [PlanLimitsService],
  exports: [PlanLimitsService],
})
export class PlanLimitsModule {}
