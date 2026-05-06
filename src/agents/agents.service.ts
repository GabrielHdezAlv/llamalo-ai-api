import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PlanLimitsService } from '../plan-limits/plan-limits.service';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { SetAgentConfigDto } from './dto/set-agent-config.dto';
import { GenerateAgentInstructionRequestDto } from './dto/generate-agent-instruction-request.dto';
import { GenerateAgentInstructionResponseDto } from './dto/generate-agent-instruction-response.dto';
import { getFirestore } from '../firebase/firebase.config';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';
import { WebhookActionsService } from '../webhook-actions/webhook-actions.service';

@Injectable()
export class AgentsService {
  private firestore = getFirestore();

  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  constructor(
    @Inject(forwardRef(() => KnowledgeBaseService))
    private readonly knowledgeBaseService: KnowledgeBaseService,
    private readonly planLimitsService: PlanLimitsService,
    private readonly webhookActionsService: WebhookActionsService,
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

    let template = this.readAgentPromptTemplate();

    // ✅ LÓGICA DE SHOPIFY: Si no hay shopDomain, eliminamos la sección 7 del template
    const hasShopify = !!(payload.shopDomain && payload.shopDomain.trim());
    if (!hasShopify) {
      // Eliminar desde el separador de la sección 7 hasta justo antes del separador de la sección 8
      const shopifySectionRegex =
        /============================================================\n## 7\. USO DEL CONTEXTO DE SHOPIFY[\s\S]*?(?============================================================\n## 8\.)/;
      template = template.replace(shopifySectionRegex, '');
    }

    const systemPrompt = `Eres un Ingeniero de Prompts Experto en Inteligencia Artificial Conversacional.
Tu trabajo es crear el "Prompt de Sistema Perfecto" para un Agente Telefónico de Voz de una empresa.

TÚ DEBES rellenar la plantilla que te he dado como si fuera un formulario basándote en los datos que te proporcionaré.

REGLAS DE SEGURIDAD CRÍTICAS:
1. **PROHIBICIÓN DE MARCA**: NUNCA menciones "Llámalo AI" ni "LlamaloAI" en las instrucciones del agente. El agente trabaja EXCLUSIVAMENTE para la empresa indicada en "Nombre de la Empresa".
2. **IDENTIDAD**: Usa el "Nombre de la Empresa" proporcionado como base, PERO si en la "DESCRIPCIÓN DEL USUARIO" se menciona un nombre de negocio diferente o un sector que no encaja con ese nombre, PRIORIZA SIEMPRE la descripción del usuario. El agente debe ser coherente con lo que el usuario describe ahora mismo. JAMÁS digas que eres de Llámalo AI.

Requisitos estrictos para generar el prompt:
1. Devuelve SOLO el texto final de instrucciones. No devuelvas explicaciones ni rodees el texto con backticks de markdown.
2. Usa la estructura exacta del ejemplo/plantilla proporcionado.
3. **CERO COPIA DE EJEMPLOS**: Los textos entre corchetes como "[PASO 2 - Ej: Identificación de la necesidad]" o "[LIMITE_CRITICO_1...]" son SOLO EJEMPLOS del tipo de contenido que debe ir ahí. TÚ DEBES inventar el contenido real basándote ÚNICAMENTE en la "DESCRIPCIÓN DEL USUARIO".
4. **EVITAR SESGOS MÉDICOS/DENTALES**: NUNCA menciones "Clínica Dental", "Dientes", "Limpiezas", "Ortodoncia" ni nada relacionado con odontología o salud A MENOS que la "DESCRIPCIÓN DEL USUARIO" lo indique de forma explícita y directa. Ignora cualquier sesgo previo o el nombre de la empresa si este sugiere algo médico pero la descripción trata de otro tema (ej: taller, tienda).
5. El texto debe estar en el idioma indicado por language (ISO-639-1).
6. **Objetivo Principal**: Escribe un objetivo hiper claro en la sección 1 basándote únicamente en lo que el usuario ha descrito. Si el usuario describe un negocio diferente al "Nombre de la Empresa", usa el nombre del negocio que el usuario haya puesto en su descripción.
7. **Flujo de Llamada**: Inventa pasos lógicos en la sección 4 que sigan el proceso real del negocio descrito.
8. **Límites Estrictos**: Inventa al menos 2 límites críticos en la sección 5 basados específicamente en la industria del cliente.
9. **Base de Conocimientos**: Transforma la descripción del usuario en una sección de conocimiento clara (sección 6) con viñetas.
10. **Playbooks**: Inventa 2 escenarios comunes de la industria del cliente en la sección 8 y cómo debe reaccionar el agente.
11. Reemplaza el marcador [IDIOMA_AGENTE] con el idioma proporcionado (${payload.language}).
12. ${hasShopify ? `Si el usuario tiene shopDomain (${payload.shopDomain}), asegúrate de dejar intacta la sección 7 de Shopify.` : 'NO incluyas ninguna sección de Shopify ya que esta empresa no tiene tienda conectada.'}
13. **Nombre del Agente**: Usa obligatoriamente ${payload.agentName}.

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

    const model = process.env.OPENAI_MODEL ?? 'gpt-4o';
    const temperature = Number(process.env.OPENAI_TEMPERATURE ?? 0.7);
    // No reutilizar OPENAI_MAX_TOKENS global (puede estar bajo para llamadas). Usar uno propio.
    const baseMaxTokens = 3500;

    const callOpenAI = async (max_tokens: number) => {
      try {
        return await this.openai.chat.completions.create({
          model,
          temperature,
          max_tokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        });
      } catch (error: any) {
        if (error.status === 429) {
          throw new BadRequestException('Límite de cuota de OpenAI excedido. Por favor, verifica los fondos en tu cuenta de OpenAI (platform.openai.com).');
        }
        throw error;
      }
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

  /** Misma lógica que en TwilioService: perfil antiguo (objeto) → array. */
  private normalizeTwilioArray(
    twilioData: unknown,
  ): Array<{
    twilioAccountId: number;
    twilioSid: string;
    twilioToken: string;
  }> {
    if (!twilioData) {
      return [];
    }
    if (Array.isArray(twilioData)) {
      return twilioData as Array<{
        twilioAccountId: number;
        twilioSid: string;
        twilioToken: string;
      }>;
    }
    if (typeof twilioData === 'object' && twilioData !== null) {
      const oldTwilio = twilioData as Record<string, unknown>;
      if (oldTwilio.twilioSid && oldTwilio.twilioToken) {
        return [
          {
            twilioAccountId: Date.now(),
            twilioSid: oldTwilio.twilioSid as string,
            twilioToken: oldTwilio.twilioToken as string,
          },
        ];
      }
    }
    return [];
  }

  private twilioAccountIdIsValidForUser(
    twilioArray: Array<{ twilioAccountId: number }>,
    id: number | undefined,
  ): boolean {
    if (id === undefined || Number.isNaN(id)) {
      return false;
    }
    return twilioArray.some((acc) => acc.twilioAccountId === id);
  }

  /**
   * Resuelve qué twilioAccountId debe usar el agente.
   * Si el ID guardado quedó obsoleto (p. ej. se desvinculó y volvió a vincular Twilio),
   * intenta el asociado al número en phoneNumbers[] y, solo si hay una única cuenta en el perfil, esa.
   */
  private resolveTwilioAccountId(
    userData: Record<string, unknown>,
    agentTwilioAccountId: number | undefined,
    phoneNumbersArray: Array<Record<string, unknown>>,
    phoneId: number,
  ): number | undefined {
    const twilioArray = this.normalizeTwilioArray(userData?.twilio);

    const phoneEntry = phoneNumbersArray.find(
      (p) => (p.phoneId as number) === phoneId,
    );
    const inferredFromPhone = phoneEntry?.twilioAccountId as number | undefined;

    if (twilioArray.length === 0) {
      if (agentTwilioAccountId !== undefined) {
        throw new BadRequestException(
          'No hay cuentas de Twilio configuradas en el perfil. Vincula Twilio antes de asociar el agente.',
        );
      }
      return undefined;
    }

    if (agentTwilioAccountId !== undefined) {
      if (
        this.twilioAccountIdIsValidForUser(twilioArray, agentTwilioAccountId)
      ) {
        return agentTwilioAccountId;
      }
      if (this.twilioAccountIdIsValidForUser(twilioArray, inferredFromPhone)) {
        return inferredFromPhone;
      }
      if (twilioArray.length === 1) {
        return twilioArray[0].twilioAccountId;
      }
      throw new BadRequestException(
        'La cuenta de Twilio guardada en este agente ya no existe o hay varias cuentas y no se pudo determinar cuál usar. Elige la cuenta de Twilio correcta en el formulario del agente.',
      );
    }

    if (this.twilioAccountIdIsValidForUser(twilioArray, inferredFromPhone)) {
      return inferredFromPhone;
    }
    if (twilioArray.length === 1) {
      return twilioArray[0].twilioAccountId;
    }
    return undefined;
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
        ...(agentConfig.model && { model: agentConfig.model }),
        ...(agentConfig.contactEmail && { contactEmail: agentConfig.contactEmail }),
        ...(agentConfig.knowledgeSourceIds && { knowledgeSourceIds: agentConfig.knowledgeSourceIds }),
        ...(agentConfig.outboundCampaignKind && { outboundCampaignKind: agentConfig.outboundCampaignKind }),
        ...(agentConfig.outboundCampaignScripts && { outboundCampaignScripts: agentConfig.outboundCampaignScripts }),
        ...(agentConfig.outboundImportCsvPhones && { outboundImportCsvPhones: agentConfig.outboundImportCsvPhones }),
        ...(agentConfig.outboundSegmentationNotes && { outboundSegmentationNotes: agentConfig.outboundSegmentationNotes }),
        ...(agentConfig.outboundScheduleCampaignNotes && { outboundScheduleCampaignNotes: agentConfig.outboundScheduleCampaignNotes }),
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

      await this.planLimitsService.assertCanAddAgent(
        userId,
        agentsArray.length,
      );

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

      // Sincronizar cola de llamadas outbound
      const outboundPhones = newAgent.outboundImportCsvPhones as string[] | undefined;
      const outboundKind = newAgent.outboundCampaignKind as string | undefined;

      if (newAgent.type === 'outbound' && Array.isArray(outboundPhones) && outboundPhones.length > 0) {
        await this.syncOutboundQueue(userId, agentId, outboundPhones, outboundKind || '');
      }

      return {
        message: 'Agente creado correctamente.',
        agent: newAgent,
        agentId: agentId,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
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
        ...(agentConfig.model !== undefined ? { model: agentConfig.model } : existingAgent.model ? { model: existingAgent.model } : {}),
        ...(agentConfig.contactEmail !== undefined ? { contactEmail: agentConfig.contactEmail } : existingAgent.contactEmail ? { contactEmail: existingAgent.contactEmail } : {}),
        ...(agentConfig.knowledgeSourceIds !== undefined ? { knowledgeSourceIds: agentConfig.knowledgeSourceIds } : existingAgent.knowledgeSourceIds ? { knowledgeSourceIds: existingAgent.knowledgeSourceIds } : {}),
        ...(agentConfig.outboundCampaignKind !== undefined ? { outboundCampaignKind: agentConfig.outboundCampaignKind } : existingAgent.outboundCampaignKind ? { outboundCampaignKind: existingAgent.outboundCampaignKind } : {}),
        ...(agentConfig.outboundCampaignScripts !== undefined ? { outboundCampaignScripts: agentConfig.outboundCampaignScripts } : existingAgent.outboundCampaignScripts ? { outboundCampaignScripts: existingAgent.outboundCampaignScripts } : {}),
        ...(agentConfig.outboundImportCsvPhones !== undefined ? { outboundImportCsvPhones: agentConfig.outboundImportCsvPhones } : existingAgent.outboundImportCsvPhones ? { outboundImportCsvPhones: existingAgent.outboundImportCsvPhones } : {}),
        ...(agentConfig.outboundSegmentationNotes !== undefined ? { outboundSegmentationNotes: agentConfig.outboundSegmentationNotes } : existingAgent.outboundSegmentationNotes ? { outboundSegmentationNotes: existingAgent.outboundSegmentationNotes } : {}),
        ...(agentConfig.outboundScheduleCampaignNotes !== undefined ? { outboundScheduleCampaignNotes: agentConfig.outboundScheduleCampaignNotes } : existingAgent.outboundScheduleCampaignNotes ? { outboundScheduleCampaignNotes: existingAgent.outboundScheduleCampaignNotes } : {}),
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

      // Sincronizar cola de llamadas outbound
      const outboundPhones = updatedAgent.outboundImportCsvPhones as string[] | undefined;
      const outboundKind = updatedAgent.outboundCampaignKind as string | undefined;

      if (updatedAgent.type === 'outbound' && Array.isArray(outboundPhones) && outboundPhones.length > 0) {
        await this.syncOutboundQueue(userId, agentId, outboundPhones, outboundKind || '');
      }

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

  async syncOutboundQueue(userId: string, agentId: number, phones: string[], campaignKind: string) {
    const batch = this.firestore.batch();
    const queueRef = this.firestore.collection('outbound_queue');

    // Obtener las existentes para este agente
    const existingSnapshot = await queueRef.where('agentId', '==', agentId).get();
    const existingPhones = new Set<string>();
    existingSnapshot.docs.forEach(doc => {
      existingPhones.add(doc.data().phoneNumber);
    });

    const now = new Date().toISOString();
    let count = 0;

    // Solo añadimos los que no estén ya en la cola para no sobreescribir el estado
    for (const phone of phones) {
      const normalizedPhone = phone.replace(/\s|-|\(|\)/g, ''); // Normalización básica
      if (!existingPhones.has(normalizedPhone) && normalizedPhone) {
        // Formato E164 (añadir + si no lo tiene)
        const e164Phone = normalizedPhone.startsWith('+') ? normalizedPhone : `+${normalizedPhone}`;
        
        const docId = `${agentId}_${e164Phone.replace('+', '')}`;
        const newQueueItemRef = queueRef.doc(docId);
        batch.set(newQueueItemRef, {
          userId,
          agentId,
          phoneNumber: e164Phone,
          status: 'pending',
          campaignKind,
          createdAt: now,
          updatedAt: now,
        });
        count++;
      }
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[Outbound] Añadidos ${count} nuevos números a la cola para el agente ${agentId}`);
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

      try {
        await this.webhookActionsService.deleteAllForAgent(userId, agentId);
      } catch (e) {
        console.error(
          `[deleteAgent] No se pudieron eliminar webhook actions para agent ${agentId}:`,
          e,
        );
      }

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
}
