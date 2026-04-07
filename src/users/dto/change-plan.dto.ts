import { IsNotEmpty, IsString, IsIn } from 'class-validator';
import { PlanType, PLAN_LIMITS } from '../../common/constants/plans.constants';

export class ChangePlanDto {
  @IsNotEmpty()
  @IsString()
  @IsIn(Object.keys(PLAN_LIMITS))
  plan: PlanType;
}
