import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as Sentry from '@sentry/nestjs';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      user?: admin.auth.DecodedIdToken;
    }>();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      Sentry.setUser(null);
      throw new UnauthorizedException('Token no proporcionado');
    }

    const token = authHeader.split('Bearer ')[1];

    try {
      const decodedToken = await admin.auth().verifyIdToken(token);
      request.user = decodedToken; // Adjuntar datos del usuario al request
      Sentry.setUser({
        id: decodedToken.uid,
        email: decodedToken.email,
      });
      return true;
    } catch {
      Sentry.setUser(null);
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
