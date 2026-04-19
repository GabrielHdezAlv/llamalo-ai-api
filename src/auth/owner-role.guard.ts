import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config';

/**
 * Debe usarse después de {@link FirebaseAuthGuard}.
 * Comprueba en Firestore que el usuario tenga `rol === 'owner'`.
 */
@Injectable()
export class OwnerRoleGuard implements CanActivate {
  private readonly firestore = getFirestore();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: admin.auth.DecodedIdToken;
    }>();
    const uid = request.user?.uid;
    if (!uid) {
      throw new UnauthorizedException('Sesión no válida');
    }
    const snap = await this.firestore.collection('users').doc(uid).get();
    if (!snap.exists) {
      throw new ForbiddenException('Usuario no encontrado');
    }
    const rol = (snap.data() as { rol?: string })?.rol;
    if (rol !== 'owner') {
      throw new ForbiddenException('Acceso reservado a administradores');
    }
    return true;
  }
}
