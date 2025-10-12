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
import * as serviceAccount from '../config/llamaloio-firebase-adminsdk-fbsvc-2884e73711.json';

// Inicializa Firebase Admin (solo una vez en tu app principal)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

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

    // 1️⃣ Registrar en Firebase Auth
    let firebaseResponse: { idToken: string; localId: string };
    try {
      const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      firebaseResponse = response.data as { idToken: string; localId: string };
    } catch (error: unknown) {
      const message: string = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : (error as Error).message;
      throw new BadRequestException(
        `No se pudo registrar el usuario en Firebase: ${message}`,
      );
    }

    // 2️⃣ Hashear contraseña
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3️⃣ Guardar usuario en Firestore
    const userRef = firestore.collection('users').doc(firebaseResponse.localId);
    await userRef.set({
      name,
      lastname,
      email,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      profileImage: '',
      enterprise: '',
      enterpriseWeb: '',
      twilio: {}, // TODO: Añadir la creación de configuración base de twilio
      agent: {}, // TODO: Añadir la selección del primer agente por defecto
    });

    return {
      token: firebaseResponse.idToken,
      userId: firebaseResponse.localId,
    };
  }

  // ✅ Login de usuario
  async login(loginDto: LoginDto) {
    const { email, password } = loginDto;

    if (!email || !password) {
      throw new BadRequestException('Email y contraseña son obligatorios.');
    }

    let firebaseResponse: { idToken: string; localId: string };
    try {
      const response = await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${this.firebaseApiKey}`,
        { email, password, returnSecureToken: true },
      );
      firebaseResponse = response.data as { idToken: string; localId: string };
    } catch (error: unknown) {
      const message: string = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : (error as Error).message;
      throw new UnauthorizedException(message);
    }

    return {
      token: firebaseResponse.idToken,
      userId: firebaseResponse.localId,
    };
  }

  // ✅ Recuperar contraseña
  async recoverPassword(recoverDto: RecoverDto) {
    const { email } = recoverDto;

    if (!email) {
      throw new BadRequestException('El email es obligatorio.');
    }

    try {
      await axios.post(
        `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${this.firebaseApiKey}`,
        { requestType: 'PASSWORD_RESET', email },
      );
    } catch (error: unknown) {
      const message: string = axios.isAxiosError(error)
        ? error.message || 'Error desconocido'
        : (error as Error).message;
      throw new BadRequestException(
        `No se pudo enviar el correo de recuperación: ${message}`,
      );
    }

    return {
      message:
        'Si el correo está registrado, recibirás un email con instrucciones.',
    };
  }
}
