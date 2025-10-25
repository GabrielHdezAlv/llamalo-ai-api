import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { getFirestore } from '../firebase/firebase.config';

@Injectable()
export class AgentsService {
  private firestore = getFirestore();

  // ✅ Obtener todos los agentes
  async getAllAgents() {
    try {
      const colRef = this.firestore.collection('agents');
      const snapshot = await colRef.get();

      if (snapshot.empty) {
        throw new NotFoundException('No se encontraron agentes.');
      }

      // Mapear los documentos a objetos Agent
      const agents = snapshot.docs.map((doc) => doc.data());

      return agents;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener los agentes: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Configurar agente del usuario
  async setAgentConfig(userId: string, agentConfig: SetAgentConfigDto) {
    try {
      // Obtener la referencia al documento del usuario
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const userAgentConfig =
        (userData?.agent as Record<string, unknown>) || {};

      // Actualizar solo los campos que cambiaron
      let hasChanges = false;

      if (userAgentConfig.labsId !== agentConfig.labsId) {
        userAgentConfig.labsId = agentConfig.labsId;
        hasChanges = true;
      }

      if (userAgentConfig.name !== agentConfig.name) {
        userAgentConfig.name = agentConfig.name;
        hasChanges = true;
      }

      if (userAgentConfig.photoUrl !== agentConfig.photoUrl) {
        userAgentConfig.photoUrl = agentConfig.photoUrl;
        hasChanges = true;
      }

      // Comparar objeto language
      const currentLanguage = userAgentConfig.language as
        | Record<string, string>
        | undefined;
      const newLanguage = agentConfig.language;

      if (
        !currentLanguage ||
        currentLanguage.code !== newLanguage.code ||
        currentLanguage.name !== newLanguage.name ||
        currentLanguage.flag !== newLanguage.flag
      ) {
        userAgentConfig.language = {
          flag: newLanguage.flag,
          name: newLanguage.name,
          code: newLanguage.code,
        };
        hasChanges = true;
      }

      if (hasChanges) {
        await userDocRef.set({ agent: userAgentConfig }, { merge: true });
      }

      return {
        message: 'Configuración de agente actualizada correctamente.',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al procesar la configuración del agente: ${(error as Error).message}`,
      );
    }
  }
}
