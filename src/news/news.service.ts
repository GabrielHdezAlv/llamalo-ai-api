import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { getFirestore } from '../firebase/firebase.config';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';
import type { DocumentData } from 'firebase-admin/firestore';

export interface UploadFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

@Injectable()
export class NewsService {
  private firestore = getFirestore();
  private storage = admin.storage();

  private async checkOwner(userId: string) {
    const userDoc = await this.firestore.collection('users').doc(userId).get();
    if (!userDoc.exists) {
      throw new NotFoundException('Usuario no encontrado');
    }
    const userData = userDoc.data();
    if (userData?.rol !== 'owner') {
      throw new ForbiddenException('Solo los administradores (owners) pueden realizar esta acción');
    }
  }

  /**
   * Fecha de publicación en ISO 8601 para JSON y lectura en el frontend (etiquetas relativas allí).
   */
  private toIsoDateString(value: unknown): string | undefined {
    if (value == null) return undefined;
    if (typeof value === 'string' && value.trim() !== '') {
      const d = new Date(value);
      if (!isNaN(d.getTime())) return d.toISOString();
      return undefined;
    }
    if (value instanceof admin.firestore.Timestamp) {
      return value.toDate().toISOString();
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      'seconds' in value &&
      typeof (value as { seconds: number }).seconds === 'number'
    ) {
      try {
        return new admin.firestore.Timestamp(
          (value as { seconds: number }).seconds,
          (value as { nanoseconds?: number }).nanoseconds ?? 0,
        )
          .toDate()
          .toISOString();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private normalizeNewsResponse(id: string, data: DocumentData | undefined) {
    if (!data) return { id };
    const date =
      this.toIsoDateString(data.date) ??
      this.toIsoDateString(data.createdAt) ??
      new Date().toISOString();
    return {
      id,
      ...data,
      date,
    };
  }

  async createNews(userId: string, createDto: CreateNewsDto) {
    await this.checkOwner(userId);
    const newDocRef = this.firestore.collection('news').doc();
    // La fecha de publicación la fija el servidor (ISO 8601); el cálculo "hace X min" es solo en el frontend.
    const { date: _omitDate, ...rest } = createDto;
    const publishedAt = new Date().toISOString();
    const data = {
      ...rest,
      date: publishedAt,
      createdAt: new Date(),
      createdBy: userId,
    };
    await newDocRef.set(data);
    const saved = await newDocRef.get();
    return this.normalizeNewsResponse(saved.id, saved.data());
  }

  async getAllNews() {
    const snapshot = await this.firestore.collection('news').orderBy('createdAt', 'desc').get();
    return snapshot.docs.map((doc) => this.normalizeNewsResponse(doc.id, doc.data()));
  }

  async updateNews(userId: string, id: string, updateDto: UpdateNewsDto) {
    await this.checkOwner(userId);
    const docRef = this.firestore.collection('news').doc(id);
    const snapshot = await docRef.get();

    if (!snapshot.exists) {
      throw new NotFoundException('Noticia no encontrada');
    }

    const { date: incomingDate, ...rest } = updateDto;
    const payload: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (incomingDate !== undefined) {
      const iso = this.toIsoDateString(incomingDate);
      if (iso) payload.date = iso;
    }

    await docRef.update(payload as FirebaseFirestore.UpdateData<DocumentData>);

    const updated = await docRef.get();
    return this.normalizeNewsResponse(updated.id, updated.data());
  }

  async deleteNews(userId: string, id: string) {
    await this.checkOwner(userId);
    const docRef = this.firestore.collection('news').doc(id);
    const snapshot = await docRef.get();
    
    if (!snapshot.exists) {
      throw new NotFoundException('Noticia no encontrada');
    }
    
    await docRef.delete();
    return { success: true, message: 'Noticia eliminada correctamente' };
  }

  async uploadImage(userId: string, file: UploadFile) {
    await this.checkOwner(userId);

    if (!file) {
      throw new BadRequestException('Debe enviarse un archivo de imagen');
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('La imagen no puede superar los 5MB');
    }

    const allowedTypes = [
      'image/png',
      'image/jpeg',
      'image/jpg',
      'image/webp',
    ];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException(
        'Formato de imagen no permitido. Use PNG, JPG o WebP',
      );
    }

    const bucket = this.storage.bucket(process.env.FIREBASE_STORAGE_BUCKET);
    const extension = file.originalname.split('.').pop();
    const uniqueId = uuidv4();
    const fileName = `news-images/${uniqueId}.${extension}`;
    const fileRef = bucket.file(fileName);

    // Make the file publicly accessible from the start
    await fileRef.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
      },
      public: true, // Esto es clave
      predefinedAcl: 'publicRead' // Asegura que se establece ACL pública
    });

    // Como salvaguarda adicional
    await fileRef.makePublic();

    // Ahora podemos usar la URL directa de Google Cloud Storage
    const imageUrl = `https://storage.googleapis.com/${process.env.FIREBASE_STORAGE_BUCKET}/${fileName}`;

    return {
      message: 'Imagen subida correctamente',
      imageUrl,
    };
  }
}
