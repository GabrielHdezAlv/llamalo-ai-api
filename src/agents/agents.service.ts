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

  // ✅ Crear nuevo agente
  async createAgent(userId: string, agentConfig: SetAgentConfigDto) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};

      // Generar phoneId
      const phoneId = Date.now();

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: agentConfig.phoneNumbers.countryCode,
        number: agentConfig.phoneNumbers.number.toString(),
      };

      // Crear nuevo agente
      const newAgent = {
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        label: agentConfig.label,
      };

      // Si hay estructura antigua, migrar primero
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1; // Un timestamp anterior
        const legacyPhoneNumbers = {
          phoneId: legacyPhoneId,
          countryCode: (legacyAgent.countryCode as string) || '',
          number: (legacyAgent.phoneNumber as number)?.toString() || '',
        };

        const migratedAgent = {
          name: (legacyAgent.name as string) || '',
          type: 'inbound', // Valor por defecto
          language:
            typeof legacyAgent.language === 'string'
              ? legacyAgent.language
              : (legacyAgent.language as Record<string, string>)?.code || 'es',
          voiceId: (legacyAgent.voiceId as string) ||
            (legacyAgent.labsId as string) ||
            '',
          firstInteraction: (legacyAgent.firstInteraction as string) || '',
          agentInstruction: (legacyAgent.agentInstruction as string) || '',
          phoneNumbers: legacyPhoneNumbers,
          label: '',
        };

        agentsArray.push(migratedAgent);
      }

      // Agregar el nuevo agente al array
      agentsArray.push(newAgent);
      const newIndex = agentsArray.length - 1;

      // Guardar en Firestore
      await userDocRef.set({ agents: agentsArray }, { merge: true });

      return {
        message: 'Agente creado correctamente.',
        agent: newAgent,
        index: newIndex,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al crear el agente: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Listar todos los agentes del usuario
  async getUserAgents(userId: string) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};

      // Si hay estructura antigua, incluirla en la respuesta
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1;
        const legacyPhoneNumbers = {
          phoneId: legacyPhoneId,
          countryCode: (legacyAgent.countryCode as string) || '',
          number: (legacyAgent.phoneNumber as number)?.toString() || '',
        };

        const migratedAgent = {
          name: (legacyAgent.name as string) || '',
          type: 'inbound',
          language:
            typeof legacyAgent.language === 'string'
              ? legacyAgent.language
              : (legacyAgent.language as Record<string, string>)?.code || 'es',
          voiceId: (legacyAgent.voiceId as string) ||
            (legacyAgent.labsId as string) ||
            '',
          firstInteraction: (legacyAgent.firstInteraction as string) || '',
          agentInstruction: (legacyAgent.agentInstruction as string) || '',
          phoneNumbers: legacyPhoneNumbers,
          label: '',
        };

        return {
          agents: [migratedAgent, ...agentsArray],
        };
      }

      return {
        agents: agentsArray,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al obtener los agentes: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Actualizar agente específico por índice
  async updateAgent(
    userId: string,
    index: number,
    agentConfig: SetAgentConfigDto,
  ) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      // Validar que el índice existe
      if (index < 0 || index >= agentsArray.length) {
        throw new BadRequestException(
          `Índice de agente inválido. El usuario tiene ${agentsArray.length} agente(s).`,
        );
      }

      // Obtener agente existente
      const existingAgent = { ...agentsArray[index] };

      // Mantener phoneId existente o generar uno nuevo si no existe
      let phoneId = 0;
      if (existingAgent.phoneNumbers) {
        const existingPhone = existingAgent.phoneNumbers as Record<
          string,
          unknown
        >;
        phoneId = (existingPhone.phoneId as number) || 0;
      }
      if (phoneId === 0) {
        phoneId = Date.now();
      }

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: agentConfig.phoneNumbers.countryCode,
        number: agentConfig.phoneNumbers.number.toString(),
      };

      // Actualizar agente
      const updatedAgent = {
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        label: agentConfig.label,
      };

      // Actualizar en el array
      agentsArray[index] = updatedAgent;

      // Guardar en Firestore
      await userDocRef.set({ agents: agentsArray }, { merge: true });

      return {
        message: 'Agente actualizado correctamente.',
        agent: updatedAgent,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al actualizar el agente: ${(error as Error).message}`,
      );
    }
  }

  // ✅ Eliminar agente por índice
  async deleteAgent(userId: string, index: number) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      // Validar que el índice existe
      if (index < 0 || index >= agentsArray.length) {
        throw new BadRequestException(
          `Índice de agente inválido. El usuario tiene ${agentsArray.length} agente(s).`,
        );
      }

      // Eliminar agente del array
      agentsArray.splice(index, 1);

      // Guardar en Firestore
      await userDocRef.set({ agents: agentsArray }, { merge: true });

      return {
        message: 'Agente eliminado correctamente.',
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new BadRequestException(
        `Error al eliminar el agente: ${(error as Error).message}`,
      );
    }
  }

  // ⚠️ DEPRECATED: Mantener por compatibilidad temporal
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
      const useNewStructure =
        agentsArray.length > 0 ||
        !legacyAgent ||
        Object.keys(legacyAgent).length === 0;

      let hasChanges = false;
      const updates: Record<string, unknown> = {};

      if (useNewStructure) {
        // Nueva estructura: trabajar con agents[]
        let firstAgent = agentsArray.length > 0 ? { ...agentsArray[0] } : null;

        // Generar phoneId si no existe
        let phoneId = 0;
        if (firstAgent?.phoneNumbers) {
          const existingPhone = firstAgent.phoneNumbers as Record<string, unknown>;
          phoneId = (existingPhone.phoneId as number) || 0;
        }
        // Si no hay phoneId, generar uno nuevo basado en timestamp
        if (phoneId === 0) {
          phoneId = Date.now();
        }

        // Preparar phoneNumbers con phoneId
        const phoneNumbersWithId = {
          phoneId: phoneId,
          countryCode: agentConfig.phoneNumbers.countryCode,
          number: agentConfig.phoneNumbers.number.toString(), // Convertir a string para Firestore
        };

        // Si no hay agentes, crear uno nuevo
        if (!firstAgent) {
          firstAgent = {
            name: agentConfig.name,
            type: agentConfig.type,
            language: agentConfig.language,
            voiceId: agentConfig.voiceId,
            firstInteraction: agentConfig.firstInteraction,
            agentInstruction: agentConfig.agentInstruction,
            phoneNumbers: phoneNumbersWithId,
            label: agentConfig.label,
          };
          hasChanges = true;
        } else {
          // Actualizar campos existentes
          if (firstAgent.name !== agentConfig.name) {
            firstAgent.name = agentConfig.name;
            hasChanges = true;
          }
          if (firstAgent.type !== agentConfig.type) {
            firstAgent.type = agentConfig.type;
            hasChanges = true;
          }
          if (firstAgent.language !== agentConfig.language) {
            firstAgent.language = agentConfig.language;
            hasChanges = true;
          }
          if (firstAgent.voiceId !== agentConfig.voiceId) {
            firstAgent.voiceId = agentConfig.voiceId;
            hasChanges = true;
          }
          if (firstAgent.firstInteraction !== agentConfig.firstInteraction) {
            firstAgent.firstInteraction = agentConfig.firstInteraction;
            hasChanges = true;
          }
          if (firstAgent.agentInstruction !== agentConfig.agentInstruction) {
            firstAgent.agentInstruction = agentConfig.agentInstruction;
            hasChanges = true;
          }
          if (firstAgent.label !== agentConfig.label) {
            firstAgent.label = agentConfig.label;
            hasChanges = true;
          }

          // Actualizar phoneNumbers (mantener phoneId existente si es el mismo número)
          const existingPhone = firstAgent.phoneNumbers as Record<string, unknown>;
          const existingCountryCode = existingPhone?.countryCode as string;
          const existingNumber = existingPhone?.number as string;
          const newCountryCode = agentConfig.phoneNumbers.countryCode;
          const newNumber = agentConfig.phoneNumbers.number.toString();

          if (
            existingCountryCode !== newCountryCode ||
            existingNumber !== newNumber
          ) {
            // Si cambia el número, mantener el phoneId existente o generar uno nuevo
            firstAgent.phoneNumbers = {
              phoneId: phoneId,
              countryCode: newCountryCode,
              number: newNumber,
            };
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
        // Estructura antigua: mantener compatibilidad pero migrar a nueva estructura
        // Generar phoneId
        const phoneId = Date.now();

        const phoneNumbersWithId = {
          phoneId: phoneId,
          countryCode: agentConfig.phoneNumbers.countryCode,
          number: agentConfig.phoneNumbers.number.toString(),
        };

        // Crear nuevo agente con estructura completa
        const newAgent = {
          name: agentConfig.name,
          type: agentConfig.type,
          language: agentConfig.language,
          voiceId: agentConfig.voiceId,
          firstInteraction: agentConfig.firstInteraction,
          agentInstruction: agentConfig.agentInstruction,
          phoneNumbers: phoneNumbersWithId,
          label: agentConfig.label,
        };

        // Migrar a nueva estructura
        updates.agents = [newAgent];
        hasChanges = true;
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
