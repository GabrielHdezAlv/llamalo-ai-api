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
import { readFileSync } from 'fs';
import { join } from 'path';

// ⚡ Lazy initialization para Firebase Admin
let firebaseApp: admin.app.App | null = null;

function getFirebaseApp(): admin.app.App {
  if (!firebaseApp) {
    try {
      const serviceAccountPath =
        process.env.FIREBASE_SERVICE_ACCOUNT ||
        join(
          __dirname,
          '../config/llamaloio-firebase-adminsdk-fbsvc-2884e73711.json',
        );

      let serviceAccount: admin.ServiceAccount;

      // En Render o producción se puede usar la variable en texto plano
      if (serviceAccountPath.endsWith('.json')) {
        const raw = readFileSync(serviceAccountPath, 'utf8');
        serviceAccount = JSON.parse(raw);
      } else {
        // Si la variable contiene el JSON directamente
        serviceAccount = JSON.parse(serviceAccountPath);
      }

      firebaseApp = admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      });

      console.log('✅ Firebase Admin inicializado');
    } catch (error) {
      console.error('❌ Error al inicializar Firebase Admin:', error);
      throw new Error('Error al inicializar Firebase Admin');
    }
  }
  return firebaseApp;
}

@Injectable()
export class AuthService {
  private firebaseApiKey = process.env.FIREBASE_API_KEY;

  private getFirestore() {
    return getFirebaseApp().firestore();
  }

  // ✅ Registro de usuario
  async registerUser(createUserDto: CreateUserDto) {
    const { name, lastname, email, password } = createUserDto;

    if (!email || !password)
      throw new BadRequestException(
        'El email y la contraseña son obligatorios.',
      );

    // 1️⃣ Crear usuario en Firebase Auth
    let firebaseResponse: { idToken: string; localId: string };
    try {
      const { data } = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      firebaseResponse = data;
    } catch (error: any) {
      const message = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : error.message;
      throw new BadRequestException(`No se pudo registrar: ${message}`);
    }

    // 2️⃣ Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3️⃣ Guardar usuario en Firestore
    const firestore = this.getFirestore();
    const userRef = firestore.collection('users').doc(firebaseResponse.localId);
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

    try {
      const { data } = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      return { token: data.idToken, userId: data.localId };
    } catch (error: any) {
      const message = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : error.message;
      throw new UnauthorizedException(message);
    }
  }

  // ✅ Recuperar contraseña
  async recoverPassword(recoverDto: RecoverDto) {
    const { email } = recoverDto;
    if (!email) throw new BadRequestException('El email es obligatorio.');

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseApiKey}`,
        { requestType: 'PASSWORD_RESET', email },
      );
      return {
        message:
          'Si el correo está registrado, recibirás un email con instrucciones.',
      };
    } catch (error: any) {
      const message = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : error.message;
      throw new BadRequestException(`No se pudo enviar el correo: ${message}`);
    }
  }
}
