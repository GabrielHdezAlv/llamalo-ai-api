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

  // ✅ Obtener todas las voces disponibles
  async getAllAgents() {
    try {
      const colRef = this.firestore.collection('voices');
      const snapshot = await colRef.get();

      if (snapshot.empty) {
        throw new NotFoundException('No se encontraron voces.');
      }

      // Mapear los documentos a objetos Voice
      const voices = snapshot.docs.map((doc) => doc.data());

      return voices;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener las voces: ${(error as Error).message}`,
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
      const agentsArray = (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};

      // Determinar si usar nueva estructura (agents[]) o antigua (agent)
      const useNewStructure = agentsArray.length > 0 || !legacyAgent || Object.keys(legacyAgent).length === 0;
      
      let hasChanges = false;
      const updates: Record<string, unknown> = {};

      if (useNewStructure) {
        // Nueva estructura: trabajar con agents[]
        let firstAgent = agentsArray.length > 0 ? { ...agentsArray[0] } : null;
        
        // Si no hay agentes, crear uno nuevo con valores por defecto
        if (!firstAgent) {
          firstAgent = {
            name: agentConfig.name,
            type: 'inbound', // Valor por defecto
            language: agentConfig.language.code, // Convertir objeto language a string
            voiceId: agentConfig.voiceId,
            firstInteraction: '', // Valor por defecto
            agentInstruction: '', // Valor por defecto
            phoneNumbers: { phoneId: 0, countryCode: '', number: '' }, // Valor por defecto
            label: '', // Valor por defecto
          };
          hasChanges = true;
        } else {
          // Actualizar campos existentes
          if (firstAgent.voiceId !== agentConfig.voiceId) {
            firstAgent.voiceId = agentConfig.voiceId;
            hasChanges = true;
          }
          if (firstAgent.name !== agentConfig.name) {
            firstAgent.name = agentConfig.name;
            hasChanges = true;
          }
          // Convertir language de objeto a string si es necesario
          const currentLanguage = typeof firstAgent.language === 'string' 
            ? firstAgent.language 
            : (firstAgent.language as Record<string, string>)?.code || '';
          if (currentLanguage !== agentConfig.language.code) {
            firstAgent.language = agentConfig.language.code;
            hasChanges = true;
          }
        }

        if (hasChanges) {
          // Actualizar o crear el array de agents
          if (agentsArray.length === 0) {
            updates.agents = [firstAgent];
          } else {
            agentsArray[0] = firstAgent;
            updates.agents = agentsArray;
          }
        }
      } else {
        // Estructura antigua: mantener compatibilidad
        const userAgentConfig = { ...legacyAgent };

        if (userAgentConfig.voiceId !== agentConfig.voiceId) {
          userAgentConfig.voiceId = agentConfig.voiceId;
          hasChanges = true;
        }

        if (userAgentConfig.name !== agentConfig.name) {
          userAgentConfig.name = agentConfig.name;
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
          updates.agent = userAgentConfig;
        }
      }

      if (hasChanges) {
        await userDocRef.set(updates, { merge: true });
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
