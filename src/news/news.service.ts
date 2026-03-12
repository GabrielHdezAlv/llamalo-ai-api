import { Injectable, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { getFirestore } from '../firebase/firebase.config';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';

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

  async createNews(userId: string, createDto: CreateNewsDto) {
    await this.checkOwner(userId);
    const newDocRef = this.firestore.collection('news').doc();
    const data = {
      ...createDto,
      createdAt: new Date(),
      createdBy: userId,
    };
    await newDocRef.set(data);
    return { id: newDocRef.id, ...data };
  }

  async getAllNews() {
    const snapshot = await this.firestore.collection('news').orderBy('createdAt', 'desc').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async updateNews(userId: string, id: string, updateDto: UpdateNewsDto) {
    await this.checkOwner(userId);
    const docRef = this.firestore.collection('news').doc(id);
    const snapshot = await docRef.get();
    
    if (!snapshot.exists) {
      throw new NotFoundException('Noticia no encontrada');
    }
    
    await docRef.update({ ...updateDto, updatedAt: new Date() });
    
    const updated = await docRef.get();
    return { id: updated.id, ...updated.data() };
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

    await fileRef.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        metadata: {
          firebaseStorageDownloadTokens: uniqueId,
        }
      },
      public: true,
    });

    await fileRef.makePublic();

    // Firebase Storage usa un formato de URL diferente para las imágenes públicas por defecto
    // que incluyen un token o requieren permisos de read. 
    // Usando el formato de URL con alt=media que suele funcionar mejor para Firebase Storage
    const encodedFileName = encodeURIComponent(fileName);
    const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${process.env.FIREBASE_STORAGE_BUCKET}/o/${encodedFileName}?alt=media&token=${uniqueId}`;

    return {
      message: 'Imagen subida correctamente',
      imageUrl,
    };
  }
}
