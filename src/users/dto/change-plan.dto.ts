import { IsNotEmpty, IsString, IsIn } from 'class-validator';
import type { PlanType } from '../../common/constants/plans.constants';
import { PLAN_LIMITS } from '../../common/constants/plans.constants';

export class ChangePlanDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(Object.keys(PLAN_LIMITS))
  plan: PlanType;
}
