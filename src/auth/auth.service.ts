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

// ✅ Inicializa Firebase Admin (de forma segura para local y producción)
if (!admin.apps.length) {
  const serviceAccountPath =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    join(
      __dirname,
      '../config/llamaloio-firebase-adminsdk-fbsvc-2884e73711.json',
    );

  const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, 'utf8'));

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

const firestore = admin.firestore();

@Injectable()
export class AuthService {
  private firebaseApiKey = process.env.FIREBASE_API_KEY;

  // ✅ Registro de usuario
  async registerUser(createUserDto: CreateUserDto) {
    const { name, lastname, email, password } = createUserDto;

    if (!email || !password) {
      throw new BadRequestException(
        'El email y la contraseña son obligatorios.',
      );
    }

    // 1️⃣ Crear usuario en Firebase Auth (REST API)
    let firebaseResponse: { idToken: string; localId: string };
    try {
      const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      firebaseResponse = response.data as { idToken: string; localId: string };
    } catch (error: any) {
      const message = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : error.message;
      throw new BadRequestException(
        `No se pudo registrar en Firebase: ${message}`,
      );
    }

    // 2️⃣ Hash de contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3️⃣ Guardar usuario en Firestore
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

  // ✅ Login
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    if (!email || !password) {
      throw new BadRequestException('Email y contraseña son obligatorios.');
    }

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
