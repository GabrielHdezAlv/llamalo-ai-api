import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { EmailService } from './email.service';
import axios from 'axios';
import * as bcrypt from 'bcryptjs';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config'; // 👈 Usamos el inicializador global

@Injectable()
export class AuthService {
  private firebaseApiKey = process.env.FIREBASE_API_KEY;
  private firestore = getFirestore();
  private readonly logger = new Logger(AuthService.name);

  constructor(private readonly emailService: EmailService) {
    // Validar que FIREBASE_API_KEY esté configurada al inicializar el servicio
    if (!this.firebaseApiKey) {
      console.error(
        '❌ [Auth] FIREBASE_API_KEY no está configurada en las variables de entorno',
      );
      throw new Error(
        'FIREBASE_API_KEY no está configurada en las variables de entorno',
      );
    }
    console.log(
      '✅ [Auth] Servicio de autenticación inicializado correctamente',
    );
  }

  // 🔧 Helper para extraer mensaje de error de Firebase
  private getFirebaseErrorMessage(error: any): string {
    if (axios.isAxiosError(error) && error.response?.data?.error) {
      const firebaseError = error.response.data.error;
      // Firebase devuelve mensajes descriptivos en error.message
      return firebaseError.message || 'Error desconocido de Firebase';
    }
    return error.message || 'Error desconocido';
  }

  // ✅ Registro de usuario
  async registerUser(createUserDto: CreateUserDto) {
    const { name, lastname, email, password, country, marketingConsent, rol } =
      createUserDto;

    if (!email || !password)
      throw new BadRequestException(
        'El email y la contraseña son obligatorios.',
      );

    console.log(`📝 [Auth] Intento de registro para: ${email}`);

    // 1️⃣ Crear usuario en Firebase Auth
    let firebaseResponse: { idToken: string; localId: string };
    try {
      const { data } = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      firebaseResponse = data;
      console.log(
        `✅ [Auth] Usuario creado en Firebase Auth: ${firebaseResponse.localId}`,
      );
    } catch (error: any) {
      const message = this.getFirebaseErrorMessage(error);
      const errorCode =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error.message
          : 'UNKNOWN';
      console.error(
        `❌ [Auth] Error al registrar usuario ${email}: ${errorCode} - ${message}`,
      );
      throw new BadRequestException(`No se pudo registrar: ${message}`);
    }

    // 2️⃣ Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3️⃣ Generar token de verificación
    const verificationToken = this.generateVerificationToken();

    // 4️⃣ Guardar usuario en Firestore con estado 3 (No validado) y token
    try {
      const userRef = this.firestore
        .collection('users')
        .doc(firebaseResponse.localId);
      await userRef.set({
        userId: firebaseResponse.localId,
        profileImage: '',
        name,
        lastname,
        enterprise: {
          name: '',
          url: '',
        },
        email,
        password: hashedPassword,
        country,
        marketingConsent,
        accountStatus: 3, // Forzar estado 3 = No validado
        rol: rol || 'client_user', // Por defecto 'client_user' si no se especifica
        verificationToken,
        verificationTokenExpiresAt: admin.firestore.Timestamp.now(),
        createdAt: admin.firestore.Timestamp.now(),
        integrations: {
          shopify: [],
        },
        twilio: [],
        phoneNumbers: [],
        agents: [],
        hasCompletedSetup: false,
      });
      console.log(
        `✅ [Auth] Usuario guardado en Firestore: ${firebaseResponse.localId}`,
      );

      // 5️⃣ Enviar email de verificación
      try {
        await this.emailService.sendVerificationEmail(email, verificationToken);
        console.log(`✅ [Auth] Email de verificación enviado a: ${email}`);
      } catch (emailError) {
        console.error(
          `❌ [Auth] Error al enviar email de verificación: ${emailError}`,
        );
        // No fallamos el registro si el email no se envía, pero lo registramos
      }
    } catch (error: any) {
      console.error(
        `❌ [Auth] Error al guardar usuario en Firestore: ${error.message}`,
      );
      throw new BadRequestException(
        'Usuario creado en Firebase pero error al guardar en Firestore',
      );
    }

    return {
      token: firebaseResponse.idToken,
      userId: firebaseResponse.localId,
    };
  }

  // ✅ Login de usuario
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    if (!email || !password)
      throw new BadRequestException('Email y contraseña son obligatorios.');

    console.log(`🔐 [Auth] Intento de login para: ${email}`);

    try {
      const { data } = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );

      // 🔍 Verificar accountStatus en Firestore después del login exitoso en Firebase Auth
      try {
        const userDoc = await this.firestore
          .collection('users')
          .doc(data.localId as string)
          .get();

        if (!userDoc.exists) {
          throw new UnauthorizedException(
            'Usuario no encontrado en el sistema',
          );
        }

        const userData = userDoc.data();

        // 🚫 Bloquear login si accountStatus es 3 (No validado)
        if (userData?.accountStatus === 3) {
          console.warn(
            `⚠️ [Auth] Login bloqueado para ${email} - cuenta no validada (accountStatus: 3)`,
          );
          throw new UnauthorizedException(
            'Debes verificar tu correo electrónico antes de poder iniciar sesión. Por favor, revisa tu email y haz clic en el enlace de verificación.',
          );
        }

        // 🚫 Bloquear login si accountStatus es 2 (Eliminado)
        if (userData?.accountStatus === 2) {
          console.warn(
            `⚠️ [Auth] Login bloqueado para ${email} - cuenta eliminada (accountStatus: 2)`,
          );
          throw new UnauthorizedException('Esta cuenta ha sido eliminada');
        }

        // 🚫 Bloquear login si accountStatus es 0 (Inactivo)
        if (userData?.accountStatus === 0) {
          console.warn(
            `⚠️ [Auth] Login bloqueado para ${email} - cuenta inactiva (accountStatus: 0)`,
          );
          throw new UnauthorizedException('Esta cuenta está inactiva');
        }
      } catch (firestoreError) {
        // Si el error es UnauthorizedException ya lo manejamos arriba
        if (firestoreError instanceof UnauthorizedException) {
          throw firestoreError;
        }
        // Si hay error al leer Firestore, logueamos pero permitimos el login
        console.error(
          `❌ [Auth] Error al verificar accountStatus para ${email}: ${firestoreError}`,
        );
      }

      console.log(
        `✅ [Auth] Login exitoso para: ${email} (userId: ${data.localId})`,
      );
      return { token: data.idToken, userId: data.localId };
    } catch (error: any) {
      const message = this.getFirebaseErrorMessage(error);

      // Firebase Auth devuelve códigos específicos para diferentes errores
      // INVALID_PASSWORD, EMAIL_NOT_FOUND, etc.
      if (axios.isAxiosError(error) && error.response?.data?.error) {
        const errorCode = error.response.data.error.message;

        // Log del error específico
        console.warn(`⚠️ [Auth] Error en login para ${email}: ${errorCode}`);

        // Mensajes más descriptivos según el código de error
        if (errorCode === 'EMAIL_NOT_FOUND') {
          throw new UnauthorizedException('El email no está registrado.');
        } else if (errorCode === 'INVALID_PASSWORD') {
          throw new UnauthorizedException('La contraseña es incorrecta.');
        } else if (errorCode === 'INVALID_EMAIL') {
          throw new BadRequestException('El formato del email no es válido.');
        } else if (errorCode === 'USER_DISABLED') {
          throw new UnauthorizedException('Esta cuenta ha sido deshabilitada.');
        } else if (errorCode === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
          console.error(
            `🚫 [Auth] Demasiados intentos de login para ${email} - cuenta temporalmente bloqueada`,
          );
          throw new UnauthorizedException(
            'Demasiados intentos fallidos. Por favor, intenta más tarde.',
          );
        }
      }

      // Error genérico
      console.error(
        `❌ [Auth] Error desconocido en login para ${email}: ${message}`,
      );
      throw new UnauthorizedException(`Error en el login: ${message}`);
    }
  }

  // ✅ Login con Google
  async googleLogin(idToken: string) {
    if (!idToken) {
      throw new BadRequestException('El token de Google es obligatorio.');
    }

    try {
      // 1. Verificar el token usando Firebase Admin
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      const userId = decodedToken.uid;
      const email = decodedToken.email;
      const name = decodedToken.name || '';
      const picture = decodedToken.picture || '';

      console.log(`🔐 [Auth] Intento de login con Google para: ${email} (uid: ${userId})`);

      // 2. Comprobar si el usuario ya existe en Firestore
      const userRef = this.firestore.collection('users').doc(userId);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        // 3. Es un usuario nuevo: Lo creamos en Firestore
        const nameParts = name.split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

        await userRef.set({
          userId: userId,
          profileImage: picture,
          name: firstName,
          lastname: lastName,
          enterprise: {
            name: '',
            url: '',
          },
          email: email,
          country: '',
          marketingConsent: true, // Asumimos true por ser login social, se podría pedir después
          accountStatus: 1, // 1 = Activo (Google ya ha verificado el email)
          rol: 'client_user',
          verificationToken: null,
          verificationTokenExpiresAt: null,
          createdAt: admin.firestore.Timestamp.now(),
          integrations: {
            shopify: [],
          },
          twilio: [],
          phoneNumbers: [],
          agents: [],
          hasCompletedSetup: false,
        });

        console.log(`✅ [Auth] Nuevo usuario de Google creado en Firestore: ${userId}`);
      } else {
        const userData = userDoc.data();

        // Validar si la cuenta estaba eliminada (status 2) o inactiva (status 0)
        if (userData?.accountStatus === 2) {
          console.warn(`⚠️ [Auth] Login de Google bloqueado para ${email} - cuenta eliminada (accountStatus: 2)`);
          throw new UnauthorizedException('Esta cuenta ha sido eliminada');
        }

        if (userData?.accountStatus === 0) {
          console.warn(`⚠️ [Auth] Login de Google bloqueado para ${email} - cuenta inactiva (accountStatus: 0)`);
          throw new UnauthorizedException('Esta cuenta está inactiva');
        }
        
        // Si el estado es 3 (no validado) pero entran con Google, lo pasamos a 1 (activo)
        if (userData?.accountStatus === 3) {
          await userRef.update({
            accountStatus: 1,
            emailVerifiedAt: admin.firestore.Timestamp.now(),
            verificationToken: null
          });
          console.log(`✅ [Auth] Usuario ${userId} pasó de estado 3 a 1 tras login con Google`);
        }
      }

      console.log(`✅ [Auth] Login exitoso con Google para: ${email}`);

      // 4. Devolver el mismo token (o uno de sesión, en este caso el de idToken para que el frontend lo guarde)
      return { token: idToken, userId: userId };
    } catch (error: any) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      
      console.error(`❌ [Auth] Error en login de Google: ${error.message}`);
      throw new UnauthorizedException('Token de Google inválido o expirado');
    }
  }

  // ✅ Recuperar contraseña
  async recoverPassword(recoverDto: RecoverDto) {
    const { email } = recoverDto;
    if (!email) throw new BadRequestException('El email es obligatorio.');

    console.log(
      `🔑 [Auth] Solicitud de recuperación de contraseña para: ${email}`,
    );

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseApiKey}`,
        { requestType: 'PASSWORD_RESET', email },
      );
      console.log(`✅ [Auth] Email de recuperación enviado a: ${email}`);
      return {
        message:
          'Si el correo está registrado, recibirás un email con instrucciones.',
      };
    } catch (error: any) {
      const message = this.getFirebaseErrorMessage(error);
      const errorCode =
        axios.isAxiosError(error) && error.response?.data?.error
          ? error.response.data.error.message
          : 'UNKNOWN';
      console.error(
        `❌ [Auth] Error al enviar email de recuperación a ${email}: ${errorCode} - ${message}`,
      );
      throw new BadRequestException(`No se pudo enviar el correo: ${message}`);
    }
  }

  // ✅ Cambiar contraseña (usuario autenticado)
  async changePassword(userId: string, changePasswordDto: ChangePasswordDto) {
    const { newPassword, confirmPassword } = changePasswordDto;

    // Validar que las contraseñas coincidan
    if (newPassword !== confirmPassword) {
      throw new BadRequestException('Las contraseñas no coinciden');
    }

    // Validar longitud mínima
    if (newPassword.length < 8) {
      throw new BadRequestException(
        'La contraseña debe tener al menos 8 caracteres',
      );
    }

    console.log(
      `🔐 [Auth] Cambio de contraseña solicitado para userId: ${userId}`,
    );

    try {
      // 1️⃣ Actualizar contraseña en Firebase Auth
      await admin.auth().updateUser(userId, {
        password: newPassword,
      });
      console.log(
        `✅ [Auth] Contraseña actualizada en Firebase Auth para userId: ${userId}`,
      );

      // 2️⃣ Hashear la nueva contraseña
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // 3️⃣ Actualizar contraseña hasheada en Firestore
      const userRef = this.firestore.collection('users').doc(userId);
      await userRef.update({
        password: hashedPassword,
      });
      console.log(
        `✅ [Auth] Contraseña actualizada en Firestore para userId: ${userId}`,
      );

      return {
        message: 'Contraseña actualizada correctamente',
      };
    } catch (error: any) {
      const errorMessage = error.message || 'Error desconocido';
      console.error(
        `❌ [Auth] Error al cambiar contraseña para userId ${userId}: ${errorMessage}`,
      );

      if (error.code === 'auth/user-not-found') {
        throw new BadRequestException('Usuario no encontrado');
      }

      throw new BadRequestException(
        `No se pudo actualizar la contraseña: ${errorMessage}`,
      );
    }
  }

  /**
   * Generar token de verificación único
   */
  private generateVerificationToken(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
      token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token;
  }

  /**
   * Verificar email del usuario usando token
   */
  async verifyEmail(token: string) {
    try {
      // Buscar usuario con el token de verificación
      const usersRef = this.firestore.collection('users');
      const snapshot = await usersRef
        .where('verificationToken', '==', token)
        .where('accountStatus', '==', 3) // Solo usuarios no validados
        .get();

      if (snapshot.empty) {
        throw new BadRequestException(
          'Token de verificación inválido o expirado',
        );
      }

      const userDoc = snapshot.docs[0];
      const userId = userDoc.id;

      // Actualizar usuario: cambiar accountStatus a 1 (Activo) y eliminar token
      await userDoc.ref.update({
        accountStatus: 1,
        verificationToken: null,
        emailVerifiedAt: admin.firestore.Timestamp.now(),
      });

      this.logger.log(`✅ [Auth] Email verificado para usuario: ${userId}`);

      return {
        message: 'Email verificado correctamente',
        accountStatus: 1,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('❌ [Auth] Error al verificar email:', error);
      throw new BadRequestException(
        `Error al verificar email: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Reenviar email de verificación
   */
  async resendVerificationEmail(email: string) {
    try {
      // Buscar usuario por email
      const usersRef = this.firestore.collection('users');
      const snapshot = await usersRef.where('email', '==', email).get();

      if (snapshot.empty) {
        throw new BadRequestException('No existe una cuenta con este email');
      }

      const userDoc = snapshot.docs[0];
      const userData = userDoc.data();

      // Solo reenviar si el usuario está en estado 3 (No validado)
      if (userData.accountStatus !== 3) {
        throw new BadRequestException(
          'Esta cuenta ya está verificada o no necesita verificación',
        );
      }

      // Generar nuevo token
      const verificationToken = this.generateVerificationToken();

      // Actualizar token en Firestore
      await userDoc.ref.update({
        verificationToken,
        verificationTokenExpiresAt: admin.firestore.Timestamp.now(),
      });

      // Enviar email
      await this.emailService.sendVerificationEmail(email, verificationToken);

      this.logger.log(`✅ [Auth] Email de verificación reenviado a: ${email}`);

      return {
        message: 'Email de verificación reenviado correctamente',
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      this.logger.error('❌ [Auth] Error al reenviar verificación:', error);
      throw new BadRequestException(
        `Error al reenviar email de verificación: ${(error as Error).message}`,
      );
    }
  }
}
