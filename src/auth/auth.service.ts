import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { RecoverDto } from './dto/recover.dto';
import axios from 'axios';
import * as bcrypt from 'bcryptjs';
import * as admin from 'firebase-admin';
import { getFirestore } from '../firebase/firebase.config'; // 👈 Usamos el inicializador global

@Injectable()
export class AuthService {
  private firebaseApiKey = process.env.FIREBASE_API_KEY;
  private firestore = getFirestore();

  constructor() {
    // Validar que FIREBASE_API_KEY esté configurada al inicializar el servicio
    if (!this.firebaseApiKey) {
      console.error(
        '❌ [Auth] FIREBASE_API_KEY no está configurada en las variables de entorno',
      );
      throw new Error(
        'FIREBASE_API_KEY no está configurada en las variables de entorno',
      );
    }
    console.log('✅ [Auth] Servicio de autenticación inicializado correctamente');
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
    const { name, lastname, email, password } = createUserDto;

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
      console.log(`✅ [Auth] Usuario creado en Firebase Auth: ${firebaseResponse.localId}`);
    } catch (error: any) {
      const message = this.getFirebaseErrorMessage(error);
      const errorCode = axios.isAxiosError(error) && error.response?.data?.error
        ? error.response.data.error.message
        : 'UNKNOWN';
      console.error(
        `❌ [Auth] Error al registrar usuario ${email}: ${errorCode} - ${message}`,
      );
      throw new BadRequestException(`No se pudo registrar: ${message}`);
    }

    // 2️⃣ Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3️⃣ Guardar usuario en Firestore
    try {
      const userRef = this.firestore
        .collection('users')
        .doc(firebaseResponse.localId);
      await userRef.set({
        name,
        lastname,
        email,
        password: hashedPassword,
        createdAt: admin.firestore.Timestamp.now(),
        profileImage: '',
        enterprise: '',
        enterpriseWeb: '',
        twilio: {},
        agent: {},
      });
      console.log(`✅ [Auth] Usuario guardado en Firestore: ${firebaseResponse.localId}`);
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
      console.log(`✅ [Auth] Login exitoso para: ${email} (userId: ${data.localId})`);
      return { token: data.idToken, userId: data.localId };
    } catch (error: any) {
      const message = this.getFirebaseErrorMessage(error);
      
      // Firebase Auth devuelve códigos específicos para diferentes errores
      // INVALID_PASSWORD, EMAIL_NOT_FOUND, etc.
      if (axios.isAxiosError(error) && error.response?.data?.error) {
        const errorCode = error.response.data.error.message;
        
        // Log del error específico
        console.warn(
          `⚠️ [Auth] Error en login para ${email}: ${errorCode}`,
        );
        
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

  // ✅ Recuperar contraseña
  async recoverPassword(recoverDto: RecoverDto) {
    const { email } = recoverDto;
    if (!email) throw new BadRequestException('El email es obligatorio.');

    console.log(`🔑 [Auth] Solicitud de recuperación de contraseña para: ${email}`);

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
      const errorCode = axios.isAxiosError(error) && error.response?.data?.error
        ? error.response.data.error.message
        : 'UNKNOWN';
      console.error(
        `❌ [Auth] Error al enviar email de recuperación a ${email}: ${errorCode} - ${message}`,
      );
      throw new BadRequestException(`No se pudo enviar el correo: ${message}`);
    }
  }
}
