import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { getFirestore } from '../firebase/firebase.config';
import { KnowledgeBaseService } from '../knowledge-base/knowledge-base.service';
import {
  CreateKnowledgeSourceDto,
  KnowledgeSourceDto,
} from '../knowledge-base/dto/knowledge-source.dto';
import { SetAgentConfigDto } from '../agents/dto/set-agent-config.dto';
import {
  SupportAgentConfigResponseDto,
  UpdateSupportAgentConfigDto,
  CreateSupportSourceDto,
} from './dto/support-chat.dto';

const SUPPORT_USER_ID = '__support_agent__';
const CONFIG_DOC_PATH = 'supportAgentConfig/default';

const DEFAULT_CONFIG: SupportAgentConfigResponseDto = {
  name: 'Asistente LlamaloAI',
  language: 'es',
  type: 'inbound',
  voiceId: process.env.ELEVENLABS_TTS_VOICE_ID ?? '15bJsujCI3tcDWeoZsQP',
  firstInteraction:
    '¡Hola! Soy el asistente de LlamaloAI. ¿En qué puedo ayudarte?',
  agentInstruction:
    'Eres el asistente de soporte de LlamaloAI. Ayuda a los usuarios a resolver dudas sobre la plataforma, solucionar problemas técnicos y, si es necesario, ponles en contacto con el equipo.',
  phoneNumbers: { countryCode: '+0', number: 0 },
  label: 'Agente de soporte',
  state: 'Activo',
  parameters: {
    stability: 0.72,
    similarity: 0.8,
    style: 0.05,
    boost: true,
    speed: 1,
  },
  model: 'gpt-4o-mini',
  enabled: true,
  updatedAt: new Date(),
};

@Injectable()
export class SupportChatService {
  private readonly logger = new Logger(SupportChatService.name);
  private readonly firestore = getFirestore();

  private cachedConfig: SupportAgentConfigResponseDto | null = null;
  private configCachedAt = 0;
  private readonly CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(private readonly knowledgeBaseService: KnowledgeBaseService) {}

  // ── Configuración (misma forma que edición de agente + enabled, updatedAt) ─

  async getConfig(): Promise<SupportAgentConfigResponseDto> {
    const now = Date.now();
    if (
      this.cachedConfig &&
      now - this.configCachedAt < this.CONFIG_CACHE_TTL_MS
    ) {
      return this.cachedConfig;
    }

    try {
      const doc = await this.firestore.doc(CONFIG_DOC_PATH).get();

      if (!doc.exists) {
        await this.firestore.doc(CONFIG_DOC_PATH).set(DEFAULT_CONFIG);
        this.cachedConfig = { ...DEFAULT_CONFIG };
        this.configCachedAt = now;
        return this.cachedConfig;
      }

      const data = doc.data()!;
      this.cachedConfig = this.mapDocToConfig(data);
      this.configCachedAt = now;
      return this.cachedConfig;
    } catch (error) {
      this.logger.error(`Error leyendo config de soporte: ${error.message}`);
      throw new BadRequestException('No se pudo obtener la configuración');
    }
  }

  async updateConfig(
    dto: UpdateSupportAgentConfigDto,
  ): Promise<SupportAgentConfigResponseDto> {
    try {
      const updateData: Record<string, unknown> = {
        ...dto,
        updatedAt: new Date(),
      };
      const payload = Object.fromEntries(
        Object.entries(updateData).filter(([, v]) => v !== undefined),
      ) as Record<string, unknown>;

      const docRef = this.firestore.doc(CONFIG_DOC_PATH);
      const doc = await docRef.get();

      if (!doc.exists) {
        await docRef.set({ ...DEFAULT_CONFIG, ...payload });
      } else {
        await docRef.update(payload);
      }

      this.cachedConfig = null;
      this.logger.log('Configuración del agente de soporte actualizada');

      return this.getConfig();
    } catch (error) {
      this.logger.error(`Error actualizando config: ${error.message}`);
      throw new BadRequestException('No se pudo actualizar la configuración');
    }
  }

  private mapDocToConfig(
    data: Record<string, unknown>,
  ): SupportAgentConfigResponseDto {
    return {
      name: (data.name as string) ?? DEFAULT_CONFIG.name,
      language: (data.language as string) ?? DEFAULT_CONFIG.language,
      type: (data.type as 'inbound' | 'outbound') ?? DEFAULT_CONFIG.type,
      voiceId: (data.voiceId as string) ?? DEFAULT_CONFIG.voiceId,
      firstInteraction:
        (data.firstInteraction as string) ?? DEFAULT_CONFIG.firstInteraction,
      agentInstruction:
        (data.agentInstruction as string) ?? DEFAULT_CONFIG.agentInstruction,
      phoneNumbers:
        (data.phoneNumbers as SetAgentConfigDto['phoneNumbers']) ??
        DEFAULT_CONFIG.phoneNumbers,
      label: (data.label as string) ?? DEFAULT_CONFIG.label,
      state: (data.state as 'Activo' | 'Inactivo') ?? DEFAULT_CONFIG.state,
      parameters:
        (data.parameters as SetAgentConfigDto['parameters']) ??
        DEFAULT_CONFIG.parameters,
      twilioAccountId: data.twilioAccountId as number | undefined,
      shopifyDomain: data.shopifyDomain as string | undefined,
      knowledgeSourceIds: data.knowledgeSourceIds as string[] | undefined,
      contactEmail: data.contactEmail as string | undefined,
      model: (data.model as string) ?? DEFAULT_CONFIG.model,
      enabled: (data.enabled as boolean) ?? true,
      updatedAt:
        (data.updatedAt as { toDate?: () => Date })?.toDate?.() ??
        (data.updatedAt as Date) ??
        new Date(),
    };
  }

  // ── Fuentes de conocimiento ───────────────────────────────────────────────

  async createSource(
    dto: CreateSupportSourceDto,
    filePath?: string,
  ): Promise<KnowledgeSourceDto> {
    const createDto: CreateKnowledgeSourceDto = {
      type: dto.type,
      name: dto.name,
      url: dto.url,
      content: dto.content,
      tags: ['support-agent'],
    };

    return this.knowledgeBaseService.createKnowledgeSource(
      SUPPORT_USER_ID,
      createDto,
      filePath,
    );
  }

  async getSources(): Promise<KnowledgeSourceDto[]> {
    return this.knowledgeBaseService.getUserSources(SUPPORT_USER_ID);
  }

  async deleteSource(sourceId: string): Promise<void> {
    const sources = await this.getSources();
    const exists = sources.some((s) => s.id === sourceId);
    if (!exists) {
      throw new NotFoundException(
        `Fuente ${sourceId} no encontrada en el agente de soporte`,
      );
    }
    return this.knowledgeBaseService.deleteKnowledgeSource(sourceId);
  }

  async getSourceIds(): Promise<string[]> {
    const sources = await this.getSources();
    return sources.filter((s) => s.status === 'completed').map((s) => s.id);
  }

  async searchKnowledge(query: string, limit = 5) {
    const sourceIds = await this.getSourceIds();
    if (sourceIds.length === 0) {
      return { query, results: [], totalResults: 0 };
    }

    return this.knowledgeBaseService.searchKnowledge({
      query,
      sourceIds,
      limit,
    });
  }
}
