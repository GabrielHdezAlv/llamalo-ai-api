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
import {
  UpdateSupportAgentConfigDto,
  SupportAgentConfigDto,
  CreateSupportSourceDto,
} from './dto/support-chat.dto';

const SUPPORT_USER_ID = '__support_agent__';
const CONFIG_DOC_PATH = 'supportAgentConfig/default';

const DEFAULT_CONFIG: SupportAgentConfigDto = {
  instructions:
    'Eres el asistente de soporte de LlamaloAI. Ayuda a los usuarios a resolver dudas sobre la plataforma, solucionar problemas técnicos y, si es necesario, ponles en contacto con el equipo.',
  name: 'Asistente LlamaloAI',
  greeting: '¡Hola! Soy el asistente de LlamaloAI. ¿En qué puedo ayudarte?',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  maxTokens: 500,
  language: 'es',
  voiceId: process.env.ELEVENLABS_TTS_VOICE_ID ?? '15bJsujCI3tcDWeoZsQP',
  enabled: true,
  updatedAt: new Date(),
};

@Injectable()
export class SupportChatService {
  private readonly logger = new Logger(SupportChatService.name);
  private readonly firestore = getFirestore();

  private cachedConfig: SupportAgentConfigDto | null = null;
  private configCachedAt = 0;
  private readonly CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(
    private readonly knowledgeBaseService: KnowledgeBaseService,
  ) {}

  // ── Configuración ─────────────────────────────────────────────────────────

  async getConfig(): Promise<SupportAgentConfigDto> {
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
      this.cachedConfig = {
        instructions: data.instructions ?? DEFAULT_CONFIG.instructions,
        name: data.name ?? DEFAULT_CONFIG.name,
        greeting: data.greeting ?? DEFAULT_CONFIG.greeting,
        model: data.model ?? DEFAULT_CONFIG.model,
        temperature: data.temperature ?? DEFAULT_CONFIG.temperature,
        maxTokens: data.maxTokens ?? DEFAULT_CONFIG.maxTokens,
        language: data.language ?? DEFAULT_CONFIG.language,
        voiceId: data.voiceId ?? DEFAULT_CONFIG.voiceId,
        voiceParameters: data.voiceParameters ?? DEFAULT_CONFIG.voiceParameters,
        contactEmail: data.contactEmail,
        contactWhatsapp: data.contactWhatsapp,
        enabled: data.enabled ?? true,
        updatedAt: data.updatedAt?.toDate?.() ?? data.updatedAt ?? new Date(),
      };
      this.configCachedAt = now;
      return this.cachedConfig;
    } catch (error) {
      this.logger.error(`Error leyendo config de soporte: ${error.message}`);
      throw new BadRequestException('No se pudo obtener la configuración');
    }
  }

  async updateConfig(
    dto: UpdateSupportAgentConfigDto,
  ): Promise<SupportAgentConfigDto> {
    try {
      const updateData: Record<string, unknown> = {
        updatedAt: new Date(),
      };

      if (dto.instructions !== undefined)
        updateData.instructions = dto.instructions;
      if (dto.name !== undefined) updateData.name = dto.name;
      if (dto.greeting !== undefined) updateData.greeting = dto.greeting;
      if (dto.model !== undefined) updateData.model = dto.model;
      if (dto.temperature !== undefined)
        updateData.temperature = dto.temperature;
      if (dto.maxTokens !== undefined) updateData.maxTokens = dto.maxTokens;
      if (dto.contactEmail !== undefined)
        updateData.contactEmail = dto.contactEmail;
      if (dto.contactWhatsapp !== undefined)
        updateData.contactWhatsapp = dto.contactWhatsapp;
      if (dto.language !== undefined) updateData.language = dto.language;
      if (dto.voiceId !== undefined) updateData.voiceId = dto.voiceId;
      if (dto.voiceParameters !== undefined)
        updateData.voiceParameters = dto.voiceParameters;
      if (dto.enabled !== undefined) updateData.enabled = dto.enabled;

      const docRef = this.firestore.doc(CONFIG_DOC_PATH);
      const doc = await docRef.get();

      if (!doc.exists) {
        await docRef.set({ ...DEFAULT_CONFIG, ...updateData });
      } else {
        await docRef.update(updateData);
      }

      this.cachedConfig = null;
      this.logger.log('Configuración del agente de soporte actualizada');

      return this.getConfig();
    } catch (error) {
      this.logger.error(`Error actualizando config: ${error.message}`);
      throw new BadRequestException('No se pudo actualizar la configuración');
    }
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
    return sources
      .filter((s) => s.status === 'completed')
      .map((s) => s.id);
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
