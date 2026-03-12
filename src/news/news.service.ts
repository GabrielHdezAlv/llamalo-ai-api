import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getFirestore } from '../firebase/firebase.config';
import { CreateNewsDto } from './dto/create-news.dto';
import { UpdateNewsDto } from './dto/update-news.dto';

@Injectable()
export class NewsService {
  private firestore = getFirestore();

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
}
