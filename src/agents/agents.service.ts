import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { GenerateAgentInstructionRequestDto } from './dto/generate-agent-instruction-request.dto';
import { GenerateAgentInstructionResponseDto } from './dto/generate-agent-instruction-response.dto';
import { getFirestore } from '../firebase/firebase.config';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';

@Injectable()
export class AgentsService {
  private firestore = getFirestore();

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  constructor(
    @Inject(forwardRef(() => KnowledgeBaseService))
    private readonly knowledgeBaseService: KnowledgeBaseService,
  ) {}

  private readAgentPromptTemplate(): string {
    const candidatePaths = [
      path.resolve(process.cwd(), 'AGENT_PROMPT_TEMPLATE.md'),
      path.resolve(__dirname, '..', '..', 'AGENT_PROMPT_TEMPLATE.md'),
    ];
    for (const filePath of candidatePaths) {
      try {
        return fs.readFileSync(filePath, 'utf8');
      } catch {
        // continuar con el siguiente candidate path
      }
    }

    return '============================================================\nINSTRUCCIONES DEL AGENTE\n============================================================\n\nEres un asistente de voz profesional y resolutivo.';
  }

  private sanitizeGeneratedInstruction(text: string): string {
    const trimmed = (text || '').trim();

    if (!trimmed) return '';

    // Si hay un bloque ```...```, devolver su contenido aunque haya markdown antes
    const fenceMatch = trimmed.match(/```[a-zA-Z]*\n([\s\S]*?)\n```/);
    if (fenceMatch?.[1]) {
      return fenceMatch[1].trim();
    }

    // Si empieza directamente con ```...```
    if (trimmed.startsWith('```')) {
      const withoutFirstFence = trimmed.replace(/^```[a-zA-Z]*\n?/, '');
      const withoutLastFence = withoutFirstFence.replace(/```\s*$/, '').trim();
      return withoutLastFence;
    }

    // Quitar encabezados/separadores markdown comunes si vinieran
    const withoutMarkdown = trimmed
      .replace(/^#\s+.*\n+/, '')
      .replace(/^---\s*\n+/, '')
      .trim();

    return withoutMarkdown;
  }

  async generateAgentInstruction(
    payload: GenerateAgentInstructionRequestDto,
  ): Promise<GenerateAgentInstructionResponseDto> {
    if (!process.env.OPENAI_API_KEY) {
      throw new BadRequestException('OPENAI_API_KEY no configurado.');
    }

    const template = this.readAgentPromptTemplate();

    const systemPrompt = `Eres un Ingeniero de Prompts Experto en Inteligencia Artificial Conversacional.
Tu trabajo es crear el "Prompt de Sistema Perfecto" para un Agente Telefónico de Voz de una empresa.

TÚ DEBES rellenar la plantilla que te he dado como si fuera un formulario basándote en los datos que te proporcionaré.

REGLAS DE SEGURIDAD CRÍTICAS:
1. **PROHIBICIÓN DE MARCA**: NUNCA menciones "Llámalo AI" ni "LlamaloAI" en las instrucciones del agente. El agente trabaja EXCLUSIVAMENTE para la empresa indicada en "Nombre de la Empresa".
2. **IDENTIDAD**: Usa obligatoriamente el "Nombre de la Empresa" proporcionado. Si no se proporciona un nombre, usa un término genérico como "nuestra empresa", "la clínica" o "la tienda", pero JAMÁS digas que eres de Llámalo AI.

Requisitos estrictos para generar el prompt:
1. Devuelve SOLO el texto final de instrucciones. No devuelvas explicaciones ni rodees el texto con backticks de markdown.
2. Usa la estructura exacta del ejemplo/plantilla proporcionado, pero INVENTA Y COMPLETA todas las secciones con corchetes [COMO_ESTOS] basándote en la industria del cliente.
3. El texto debe estar en el idioma indicado por language (ISO-639-1).
4. **Objetivo Principal**: Escribe un objetivo hiper claro en la sección 1 (ej: agendar una cita, vender un zapato, dar soporte técnico).
5. **Flujo de Llamada**: Inventa 4 o 5 pasos lógicos en la sección 4 para que el agente guíe la llamada (ej: 1. Saludo, 2. Pedir DNI, 3. Buscar cita, 4. Confirmar).
6. **Límites Estrictos**: Inventa al menos 2 límites críticos en la sección 5 basados en la industria (ej: Si es una clínica, escribe "NUNCA des consejos médicos ni recetes medicación").
7. **Base de Conocimientos**: Transforma la descripción del usuario en una sección de conocimiento clara (sección 6) con viñetas para que el agente la pueda leer rápido.
8. **Playbooks**: Inventa 2 escenarios comunes de la industria del cliente en la sección 8 y cómo debe reaccionar el agente.
9. Reemplaza el marcador [IDIOMA_AGENTE] con el idioma proporcionado (${payload.language}).
10. Si el usuario tiene shopDomain (${payload.shopDomain}), asegúrate de dejar intacta la sección 7 de Shopify.

Ejemplo/plantilla de referencia (Rellena los huecos vacíos):
${template}`;

    const userPrompt = `Datos para personalizar:
- Nombre de la Empresa: ${payload.enterpriseName}
- Nombre del Agente: ${payload.agentName}
- Tipo de Llamada: ${payload.callType}
- Idioma: ${payload.language}
- Voice ID: ${payload.voiceId}
- Voice Parameters: ${JSON.stringify(payload.voiceParameters)}
- Dominio Shopify: ${payload.shopDomain ?? '(no proporcionado)'}

DESCRIPCIÓN DEL USUARIO (Transforma esto en la Base de Conocimientos y Flujo del Agente):
${payload.userDescription}

Genera las instrucciones completas rellenando la plantilla con todo el contexto necesario para esta empresa.`;

    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const temperature = Number(process.env.OPENAI_TEMPERATURE ?? 0.7);
    // No reutilizar OPENAI_MAX_TOKENS global (puede estar bajo para llamadas). Usar uno propio.
    const baseMaxTokens = 3500;

    const callOpenAI = async (max_tokens: number) => {
      return await this.openai.chat.completions.create({
        model,
        temperature,
        max_tokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
    };

    let completion = await callOpenAI(baseMaxTokens);
    const finishReason = completion.choices?.[0]?.finish_reason;

    // Si el modelo truncó por longitud, reintentar una vez con más tokens
    if (finishReason === 'length') {
      completion = await callOpenAI(Math.max(baseMaxTokens * 2, 6000));
    }

    const content = completion.choices?.[0]?.message?.content ?? '';
    let agentInstruction = this.sanitizeGeneratedInstruction(content);

    // Si la respuesta es demasiado corta, forzar un reintento (a veces no viene finish_reason=length)
    const minChars = 1800;
    if (agentInstruction.length > 0 && agentInstruction.length < minChars) {
      const retryCompletion = await callOpenAI(
        Math.max(baseMaxTokens * 2, 6000),
      );
      const retryContent = retryCompletion.choices?.[0]?.message?.content ?? '';
      const retryInstruction = this.sanitizeGeneratedInstruction(retryContent);
      if (retryInstruction.length > agentInstruction.length) {
        agentInstruction = retryInstruction;
      }
    }

    if (!agentInstruction) {
      throw new BadRequestException(
        'No se pudo generar agentInstruction (respuesta vacía).',
      );
    }

    return { agentInstruction };
  }

  // Helper para filtrar agentes por parámetros de búsqueda
  private filterAgents(agents: Array<Record<string, unknown>>, query?: string) {
    if (!query || !query.trim()) {
      return agents;
    }

    const q = query.toLowerCase().trim();

    return agents.filter((agent) => {
      const name = (agent.name as string | undefined)?.toLowerCase() || '';
      const label = (agent.label as string | undefined)?.toLowerCase() || '';

      const phone = agent.phoneNumbers as Record<string, unknown> | undefined;
      const phoneNumber =
        (phone?.number as string | undefined)?.toLowerCase() || '';

      return name.includes(q) || label.includes(q) || phoneNumber.includes(q);
    });
  }

  // Helper para calcular el estado de un phoneNumber basado en si algún agente lo usa
  private calculatePhoneNumberState(
    phoneId: number,
    agents: Array<Record<string, unknown>>,
  ): 'Activo' | 'Inactivo' {
    if (!agents || agents.length === 0) {
      return 'Inactivo';
    }
    const isUsed = agents.some((agent) => {
      const agentPhone = agent.phoneNumbers as
        | Record<string, unknown>
        | undefined;
      return agentPhone && (agentPhone.phoneId as number) === phoneId;
    });
    return isUsed ? 'Activo' : 'Inactivo';
  }

  // Helper para normalizar el dominio de Shopify
  private normalizeShopifyDomain(domain?: string): string | undefined {
    if (!domain || typeof domain !== 'string' || !domain.trim()) {
      return undefined;
    }
    return (
      domain
        .replace(/^https?:\/\//, '')
        .replace(/\/$/, '')
        .trim() || undefined
    );
  }

  // Helper para actualizar el estado de todos los phoneNumbers
  private updatePhoneNumbersState(
    phoneNumbersArray: Array<Record<string, unknown>>,
    agentsArray: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return phoneNumbersArray.map((phone) => ({
      ...phone,
      state: this.calculatePhoneNumberState(
        phone.phoneId as number,
        agentsArray,
      ),
      importedBy: phone.importedBy || 'Twilio',
    }));
  }

  private resolveTwilioAccountId(
    userData: Record<string, unknown>,
    agentTwilioAccountId: number | undefined,
    phoneNumbersArray: Array<Record<string, unknown>>,
    phoneId: number,
  ): number | undefined {
    if (agentTwilioAccountId !== undefined) {
      const twilioArray =
        (userData?.twilio as Array<Record<string, unknown>>) || [];
      const exists = twilioArray.some(
        (acc) => (acc.twilioAccountId as number) === agentTwilioAccountId,
      );
      if (!exists) {
        throw new BadRequestException(
          `Cuenta de Twilio con ID ${agentTwilioAccountId} no encontrada para el usuario.`,
        );
      }
      return agentTwilioAccountId;
    }

    const phoneEntry = phoneNumbersArray.find(
      (p) => (p.phoneId as number) === phoneId,
    );
    const inferred = phoneEntry?.twilioAccountId as number | undefined;
    return inferred;
  }

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

      if (agentConfig.twilioAccountId === undefined) {
        throw new BadRequestException('twilioAccountId es obligatorio.');
      }

      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (userData?.agent as Record<string, unknown>) || {};
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Preparar número
      const newCountryCode = agentConfig.phoneNumbers.countryCode;
      const newNumber = agentConfig.phoneNumbers.number.toString();

      // Verificar si el número ya existe en phoneNumbers[]
      const existingPhoneIndex = phoneNumbersArray.findIndex(
        (phone) =>
          (phone.countryCode as string) === newCountryCode &&
          (phone.number as string) === newNumber,
      );

      let phoneId: number;
      if (existingPhoneIndex !== -1) {
        // Si el número existe en phoneNumbers[] pero no está en uso, reutilizar phoneId
        const existingPhone = phoneNumbersArray[existingPhoneIndex] as {
          phoneId: number;
        };
        phoneId = existingPhone.phoneId;
      } else {
        // Generar nuevo phoneId y agregar a phoneNumbers[]
        phoneId = Date.now();
        phoneNumbersArray.push({
          phoneId: phoneId,
          countryCode: newCountryCode,
          number: newNumber,
          state: 'Activo', // Será activo porque se está usando en el nuevo agente
          importedBy: 'Twilio',
        });
      }

      const resolvedTwilioAccountId = this.resolveTwilioAccountId(
        userData,
        agentConfig.twilioAccountId,
        phoneNumbersArray,
        phoneId,
      );

      if (resolvedTwilioAccountId !== undefined) {
        const phoneEntryIndex = phoneNumbersArray.findIndex(
          (p) => (p.phoneId as number) === phoneId,
        );
        if (phoneEntryIndex !== -1) {
          phoneNumbersArray[phoneEntryIndex] = {
            ...phoneNumbersArray[phoneEntryIndex],
            twilioAccountId: resolvedTwilioAccountId,
          };
        }
      }

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: newCountryCode,
        number: newNumber,
      };

      // Crear nuevo agente
      const agentId = Date.now();
      const shopifyDomain = this.normalizeShopifyDomain(
        agentConfig.shopifyDomain,
      );
      const newAgent = {
        agentId: agentId,
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        ...(resolvedTwilioAccountId !== undefined && {
          twilioAccountId: resolvedTwilioAccountId,
        }),
        label: agentConfig.label,
        state: agentConfig.state || 'Activo',
        parameters: agentConfig.parameters,
        totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
        ...(shopifyDomain && { shopifyDomain }),
      };

      // Si hay estructura antigua, migrar primero
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1; // Un timestamp anterior
        const legacyCountryCode = (legacyAgent.countryCode as string) || '';
        const legacyNumber =
          (legacyAgent.phoneNumber as number)?.toString() || '';

        // Validar que el número legacy no esté en uso
        const legacyNumberInUse = agentsArray.some((agent) => {
          const agentPhone = agent.phoneNumbers as
            | Record<string, unknown>
            | undefined;
          if (!agentPhone) return false;
          return (
            (agentPhone.countryCode as string) === legacyCountryCode &&
            (agentPhone.number as string) === legacyNumber
          );
        });

        if (!legacyNumberInUse && legacyNumber) {
          const legacyPhoneNumbers = {
            phoneId: legacyPhoneId,
            countryCode: legacyCountryCode,
            number: legacyNumber,
            state: 'Activo', // Será activo porque se está usando en el agente migrado
            importedBy: 'Twilio',
          };

          const migratedAgent = {
            agentId: Date.now() - 2, // Un timestamp anterior al legacyPhoneId
            name: (legacyAgent.name as string) || '',
            type: 'inbound', // Valor por defecto
            language:
              typeof legacyAgent.language === 'string'
                ? legacyAgent.language
                : (legacyAgent.language as Record<string, string>)?.code ||
                  'es',
            voiceId:
              (legacyAgent.voiceId as string) ||
              (legacyAgent.labsId as string) ||
              '',
            firstInteraction: (legacyAgent.firstInteraction as string) || '',
            agentInstruction: (legacyAgent.agentInstruction as string) || '',
            phoneNumbers: legacyPhoneNumbers,
            label: '',
            state: 'Activo',
            parameters: {
              stability: 0.5,
              similarity: 0.75,
              style: 0.0,
              boost: false,
              speed: 1.0,
            },
            totalMinutes: 0,
          };

          agentsArray.push(migratedAgent);

          // Agregar número legacy a phoneNumbers[] si no existe
          const legacyExists = phoneNumbersArray.some(
            (phone) =>
              (phone.countryCode as string) === legacyCountryCode &&
              (phone.number as string) === legacyNumber,
          );
          if (!legacyExists) {
            phoneNumbersArray.push(legacyPhoneNumbers);
          }
        }
      }

      // Agregar el nuevo agente al array
      agentsArray.push(newAgent);

      // Actualizar el estado de todos los phoneNumbers basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar ambos arrays en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

      return {
        message: 'Agente creado correctamente.',
        agent: newAgent,
        agentId: agentId,
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

  // ✅ Listar todos los agentes del usuario (con búsqueda opcional)
  async getUserAgents(userId: string, query?: string) {
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

      let resultAgents = agentsArray;

      // Si hay estructura antigua, incluirla en la respuesta
      if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        const legacyPhoneId = Date.now() - 1;
        const legacyPhoneNumbers = {
          phoneId: legacyPhoneId,
          countryCode: (legacyAgent.countryCode as string) || '',
          number: (legacyAgent.phoneNumber as number)?.toString() || '',
          state: 'Activo' as const, // Será activo porque se está usando en el agente legacy
          importedBy: 'Twilio',
        };

        const migratedAgent = {
          agentId: Date.now() - 2, // Un timestamp anterior al legacyPhoneId
          name: (legacyAgent.name as string) || '',
          type: 'inbound',
          language:
            typeof legacyAgent.language === 'string'
              ? legacyAgent.language
              : (legacyAgent.language as Record<string, string>)?.code || 'es',
          voiceId:
            (legacyAgent.voiceId as string) ||
            (legacyAgent.labsId as string) ||
            '',
          firstInteraction: (legacyAgent.firstInteraction as string) || '',
          agentInstruction: (legacyAgent.agentInstruction as string) || '',
          phoneNumbers: legacyPhoneNumbers,
          label: '',
          state: 'Activo',
          parameters: {
            stability: 0.5,
            similarity: 0.75,
            style: 0.0,
            boost: false,
            speed: 1.0,
          },
          totalMinutes: 0,
        };

        resultAgents = [migratedAgent, ...agentsArray];
      }

      const filteredAgents = this.filterAgents(resultAgents, query);

      return {
        agents: filteredAgents,
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

  // ✅ Actualizar agente específico por agentId
  async updateAgent(
    userId: string,
    agentId: number,
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
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Buscar agente por agentId
      const agentIndex = agentsArray.findIndex(
        (agent) => (agent.agentId as number) === agentId,
      );

      if (agentIndex === -1) {
        throw new BadRequestException(
          `Agente con agentId ${agentId} no encontrado.`,
        );
      }

      // Obtener agente existente
      const existingAgent = { ...agentsArray[agentIndex] };
      const existingPhone = existingAgent.phoneNumbers as
        | Record<string, unknown>
        | undefined;
      const existingCountryCode = existingPhone?.countryCode as string;
      const existingNumber = existingPhone?.number as string;

      // Preparar nuevo número
      const newCountryCode = agentConfig.phoneNumbers.countryCode;
      const newNumber = agentConfig.phoneNumbers.number.toString();

      // Verificar si el número está cambiando
      const numberChanged =
        existingCountryCode !== newCountryCode || existingNumber !== newNumber;

      // Determinar phoneId
      let phoneId: number;
      if (numberChanged) {
        // Si cambió el número, verificar si existe en phoneNumbers[]
        const existingPhoneIndex = phoneNumbersArray.findIndex(
          (phone) =>
            (phone.countryCode as string) === newCountryCode &&
            (phone.number as string) === newNumber,
        );

        if (existingPhoneIndex !== -1) {
          // Reutilizar phoneId existente
          const existingPhoneInArray = phoneNumbersArray[
            existingPhoneIndex
          ] as { phoneId: number };
          phoneId = existingPhoneInArray.phoneId;
        } else {
          // Generar nuevo phoneId y agregar a phoneNumbers[]
          phoneId = Date.now();
          phoneNumbersArray.push({
            phoneId: phoneId,
            countryCode: newCountryCode,
            number: newNumber,
            state: 'Activo', // Será activo porque se está usando en el agente actualizado
            importedBy: 'Twilio',
          });
        }
      } else {
        // Si no cambió el número, mantener el phoneId existente
        phoneId = (existingPhone?.phoneId as number) || Date.now();
      }

      const existingAgentTwilioAccountId =
        (existingAgent.twilioAccountId as number | undefined) ?? undefined;
      const requestedTwilioAccountId =
        agentConfig.twilioAccountId !== undefined
          ? agentConfig.twilioAccountId
          : existingAgentTwilioAccountId;

      const resolvedTwilioAccountId = this.resolveTwilioAccountId(
        userData,
        requestedTwilioAccountId,
        phoneNumbersArray,
        phoneId,
      );

      if (resolvedTwilioAccountId !== undefined) {
        const phoneEntryIndex = phoneNumbersArray.findIndex(
          (p) => (p.phoneId as number) === phoneId,
        );
        if (phoneEntryIndex !== -1) {
          phoneNumbersArray[phoneEntryIndex] = {
            ...phoneNumbersArray[phoneEntryIndex],
            twilioAccountId: resolvedTwilioAccountId,
          };
        }
      }

      // Preparar phoneNumbers con phoneId
      const phoneNumbersWithId = {
        phoneId: phoneId,
        countryCode: newCountryCode,
        number: newNumber,
      };

      // Actualizar agente (preservar shopifyDomain existente si no se envía en el request)
      const shopifyDomain =
        agentConfig.shopifyDomain !== undefined
          ? (this.normalizeShopifyDomain(agentConfig.shopifyDomain) ?? null)
          : ((existingAgent.shopifyDomain as string | undefined) ?? null);
      const updatedAgent = {
        agentId: agentId,
        name: agentConfig.name,
        type: agentConfig.type,
        language: agentConfig.language,
        voiceId: agentConfig.voiceId,
        firstInteraction: agentConfig.firstInteraction,
        agentInstruction: agentConfig.agentInstruction,
        phoneNumbers: phoneNumbersWithId,
        ...(resolvedTwilioAccountId !== undefined && {
          twilioAccountId: resolvedTwilioAccountId,
        }),
        label: agentConfig.label,
        state: agentConfig.state || 'Activo',
        parameters: agentConfig.parameters,
        totalMinutes: (existingAgent.totalMinutes as number) || 0, // Mantener valor existente, no se acepta del request
        shopifyDomain,
      };

      // Actualizar en el array
      agentsArray[agentIndex] = updatedAgent;

      // Actualizar el estado de todos los phoneNumbers basado en los agentes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar ambos arrays en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

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

  // ✅ Eliminar agente por agentId
  async deleteAgent(userId: string, agentId: number) {
    try {
      const userDocRef = this.firestore.collection('users').doc(userId);
      const userSnapshot = await userDocRef.get();

      if (!userSnapshot.exists) {
        throw new NotFoundException('Usuario no encontrado.');
      }

      const userData = userSnapshot.data() as Record<string, unknown>;
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];

      // Buscar agente por agentId
      const agentIndex = agentsArray.findIndex(
        (agent) => (agent.agentId as number) === agentId,
      );

      if (agentIndex === -1) {
        throw new BadRequestException(
          `Agente con agentId ${agentId} no encontrado.`,
        );
      }

      // Eliminar agente del array
      agentsArray.splice(agentIndex, 1);

      // Obtener phoneNumbers para actualizar su estado
      const phoneNumbersArray =
        (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];

      // Actualizar el estado de todos los phoneNumbers basado en los agentes restantes
      const updatedPhoneNumbers = this.updatePhoneNumbersState(
        phoneNumbersArray,
        agentsArray,
      );

      // Guardar en Firestore
      await userDocRef.set(
        {
          agents: agentsArray,
          phoneNumbers: updatedPhoneNumbers,
        },
        { merge: true },
      );

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
      const agentsArray =
        (userData?.agents as Array<Record<string, unknown>>) || [];
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
          const existingPhone = firstAgent.phoneNumbers as Record<
            string,
            unknown
          >;
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
          const newAgentId = Date.now();
          const shopifyDomain = this.normalizeShopifyDomain(
            agentConfig.shopifyDomain,
          );
          firstAgent = {
            agentId: newAgentId,
            name: agentConfig.name,
            type: agentConfig.type,
            language: agentConfig.language,
            voiceId: agentConfig.voiceId,
            firstInteraction: agentConfig.firstInteraction,
            agentInstruction: agentConfig.agentInstruction,
            phoneNumbers: phoneNumbersWithId,
            label: agentConfig.label,
            state: agentConfig.state || 'Activo',
            parameters: agentConfig.parameters,
            totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
            ...(shopifyDomain && { shopifyDomain }),
          };
          hasChanges = true;
        } else {
          // Asegurar que el agente existente tenga agentId
          if (!firstAgent.agentId) {
            firstAgent.agentId = Date.now();
            hasChanges = true;
          }
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
          if ((firstAgent.state as string) !== agentConfig.state) {
            firstAgent.state = agentConfig.state || 'Activo';
            hasChanges = true;
          }
          if (
            JSON.stringify(firstAgent.parameters) !==
            JSON.stringify(agentConfig.parameters)
          ) {
            firstAgent.parameters = agentConfig.parameters;
            hasChanges = true;
          }
          // totalMinutes no se actualiza desde el request, se mantiene el valor existente

          // Actualizar phoneNumbers (mantener phoneId existente si es el mismo número)
          const existingPhone = firstAgent.phoneNumbers as Record<
            string,
            unknown
          >;
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

          // Actualizar shopifyDomain si viene en el request
          if (agentConfig.shopifyDomain !== undefined) {
            const newShopifyDomain = this.normalizeShopifyDomain(
              agentConfig.shopifyDomain,
            );
            const currentShopifyDomain = firstAgent.shopifyDomain as
              | string
              | undefined;
            if (newShopifyDomain !== (currentShopifyDomain ?? null)) {
              firstAgent.shopifyDomain = newShopifyDomain ?? null;
              hasChanges = true;
            }
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

          // Actualizar el estado de todos los phoneNumbers basado en los agentes
          const phoneNumbersArray =
            (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
          const finalAgentsArray =
            agentsArray.length === 0 ? [firstAgent] : agentsArray;
          const updatedPhoneNumbers = this.updatePhoneNumbersState(
            phoneNumbersArray,
            finalAgentsArray,
          );
          updates.phoneNumbers = updatedPhoneNumbers;
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
        const newAgentId = Date.now();
        const shopifyDomain = this.normalizeShopifyDomain(
          agentConfig.shopifyDomain,
        );
        const newAgent = {
          agentId: newAgentId,
          name: agentConfig.name,
          type: agentConfig.type,
          language: agentConfig.language,
          voiceId: agentConfig.voiceId,
          firstInteraction: agentConfig.firstInteraction,
          agentInstruction: agentConfig.agentInstruction,
          phoneNumbers: phoneNumbersWithId,
          label: agentConfig.label,
          state: agentConfig.state || 'Activo',
          parameters: agentConfig.parameters,
          totalMinutes: 0, // Siempre inicializar en 0, no se acepta del request
          ...(shopifyDomain && { shopifyDomain }),
        };

        // Migrar a nueva estructura
        updates.agents = [newAgent];
        hasChanges = true;
      }

      if (hasChanges) {
        // Si se está usando estructura antigua, también actualizar phoneNumbers
        if (!useNewStructure && updates.agents) {
          const phoneNumbersArray =
            (userData?.phoneNumbers as Array<Record<string, unknown>>) || [];
          const newAgentsArray = updates.agents as Array<
            Record<string, unknown>
          >;

          // Asegurar que el phoneNumber tenga los campos necesarios
          const phoneId = (updates.agents[0] as Record<string, unknown>)
            .phoneNumbers as Record<string, unknown>;
          const phoneIdValue = phoneId.phoneId as number;
          if (
            phoneIdValue &&
            !phoneNumbersArray.some(
              (p) => (p.phoneId as number) === phoneIdValue,
            )
          ) {
            phoneNumbersArray.push({
              phoneId: phoneIdValue,
              countryCode: phoneId.countryCode as string,
              number: phoneId.number as string,
              state: 'Activo' as const,
              importedBy: 'Twilio',
            });
          }

          const updatedPhoneNumbers = this.updatePhoneNumbersState(
            phoneNumbersArray,
            newAgentsArray,
          );
          updates.phoneNumbers = updatedPhoneNumbers;
        }

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
