import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import * as admin from 'firebase-admin';

export const GetUser = createParamDecorator(
  (
    data: string | undefined,
    ctx: ExecutionContext,
  ): admin.auth.DecodedIdToken | string | undefined => {
    const request = ctx.switchToHttp().getRequest<{
      user?: admin.auth.DecodedIdToken;
    }>();
    const user = request.user;

    return data ? (user?.[data] as string | undefined) : user;
  },
);
