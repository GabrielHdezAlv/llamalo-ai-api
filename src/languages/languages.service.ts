import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { getFirestore } from '../firebase/firebase.config';
@Injectable()
export class LanguagesService {
  private firestore = getFirestore();

  // ✅ Obtener todos los idiomas
  async getAllLanguages() {
    try {
      const colRef = this.firestore.collection('languages');
      const snapshot = await colRef.get();

      if (snapshot.empty) {
        throw new NotFoundException('No se encontraron idiomas.');
      }

      // Mapear los documentos a objetos Language
      const languages = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      return languages;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener los idiomas: ${(error as Error).message}`,
      );
    }
  }
}
