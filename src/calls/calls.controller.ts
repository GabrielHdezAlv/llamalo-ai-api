import { Controller, Post, Body, Res, Req, ForbiddenException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { validateRequest } from 'twilio';
import { TwilioService } from './twilio.service';
import { getTwilioMediaStreamWebSocketUrl } from './twilio-media-stream-url';
import { AgentKnowledgeService } from '../agents/agent-knowledge.service';
import { UsersService } from '../users/users.service';
import * as admin from 'firebase-admin';
import type {
  DocumentData,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'firebase-admin/firestore';

class IncomingDto {
  To?: string;
  From?: string;
  CallSid?: string;
  AccountSid?: string;
}

@Controller('voice')
export class CallsController {
  // Protección anti-spam por caller→destino sin bloquear picos legítimos de muchos callers distintos.
  private readonly callerWindowMs = 10 * 60 * 1000;
  private readonly callerMaxAttemptsPerWindow = 6;
  private readonly callerAttemptBuckets = new Map<string, number[]>();

  constructor(
    private readonly twilio: TwilioService,
    private readonly agentKnowledgeService: AgentKnowledgeService,
    private readonly usersService: UsersService,
  ) {}

  // 🔒 Helper para enmascarar números de teléfono
  private maskPhoneNumber(phone?: string): string {
    if (!phone) return 'N/A';
    // Mostrar solo los últimos 4 dígitos: +34****1234
    const digits = phone.replace(/\D/g, '');
    if (digits.length <= 4) return '****';
    return `${phone.substring(0, phone.length - 4)}****`;
  }

  @Post('incoming')
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  async incoming(
    @Req() req: Request,
    @Body() body: IncomingDto,
    @Res() res: Response,
  ) {
    await this.assertTwilioSignature(
      req,
      body as Record<string, string | undefined>,
    );
    const r = this.twilio.newVoiceResponse();

    console.log('📞 Llamada entrante detectada');
    // 🔒 Enmascarar números de teléfono para proteger privacidad
    console.log('➡️ Número marcado (To):', this.maskPhoneNumber(body.To));
    console.log(
      '➡️ Número del cliente (From):',
      this.maskPhoneNumber(body.From),
    );

    // EARLY EXIT: Rechazar peticiones de prueba/fantasma sin número real inmediatamente
    if (!body.To || body.To === 'N/A' || body.To.includes('client:')) {
      console.log('⚠️ Ignorando petición sin número real (Early Exit)');
      return res.type('text/xml').send('<Response><Reject /></Response>');
    }
    if (this.isCallerBurstExceeded(body.From, body.To)) {
      console.warn(
        '⚠️ [Calls] Patrón repetitivo detectado para caller/destino; rechazando llamada para mitigar spam',
      );
      return res.type('text/xml').send('<Response><Reject /></Response>');
    }

    try {
      const agentDoc = await this.resolveUserDocFromPhoneTo(body.To);
      if (!agentDoc) {
        console.log(
          '⚠️ No se encontró ningún agente con ese número — cuelgue inmediato (Reject)',
        );
        return res.type('text/xml').send('<Response><Reject /></Response>');
      }

      const userId = agentDoc.id;
      const agent = agentDoc.data() as Record<string, unknown>;

      const rawNumber = body.To?.replace('+34', '').replace(/\D/g, '');
      const agentNumber = parseInt(rawNumber || '0', 10);

      // 🔍 Debug: Ver estructura del documento
      console.log(
        `🔍 [Calls] Estructura del documento para usuario ${userId}:`,
        {
          tieneAgent: !!(
            agent.agent ||
            (agent.agents &&
              Array.isArray(agent.agents) &&
              agent.agents.length > 0)
          ),
          tieneTwilio: !!agent.twilio,
          tieneIntegrations: !!agent.integrations,
          tienePhoneNumbers: !!(
            agent.phoneNumbers && Array.isArray(agent.phoneNumbers)
          ),
          camposAgent: agent.agent
            ? Object.keys(agent.agent as Record<string, unknown>)
            : agent.agents?.[0]
              ? Object.keys(agent.agents[0] as Record<string, unknown>)
              : 'no existe',
        },
      );

      // Obtener phoneNumbers y twilio array
      const phoneNumbers =
        (agent.phoneNumbers as Array<{
          phoneId?: number;
          countryCode?: string;
          number?: string;
          twilioAccountId?: number;
        }>) || [];

      const twilioArray =
        (agent.twilio as Array<{
          twilioAccountId: number;
          twilioSid: string;
          twilioToken: string;
        }>) || [];

      // Buscar el phoneNumber que coincide con el número de la llamada
      const matchingPhone = phoneNumbers.find((phone) => {
        const phoneNumStr = phone.number?.replace(/\D/g, '') || '';
        const phoneNum = parseInt(phoneNumStr, 10);
        return phoneNum === agentNumber;
      });

      // Obtener shopDomain de integrations.shopify (ahora es un array)
      const integrations =
        (agent.integrations as Record<string, unknown>) || {};

      // Asegurar que shopify sea un array (manejar formato antiguo o valores inválidos)
      const shopifyArray: Array<{
        connected: boolean;
        shopDomain: string;
      }> = Array.isArray(integrations.shopify) ? integrations.shopify : [];

      // Usar la primera tienda conectada del array (si existe)
      const firstShopify = shopifyArray.find((store) => store.connected);
      const shopDomain = firstShopify?.shopDomain;

      // 🔍 Logging para debugging de Shopify
      if (!integrations || Object.keys(integrations).length === 0) {
        console.log(
          `⚠️ [Calls] Usuario ${userId} no tiene integraciones configuradas`,
        );
      } else if (!shopifyArray || shopifyArray.length === 0) {
        console.log(
          `⚠️ [Calls] Usuario ${userId} no tiene tiendas Shopify configuradas`,
        );
      } else if (!firstShopify) {
        console.log(
          `⚠️ [Calls] Usuario ${userId} tiene ${shopifyArray.length} tiendas Shopify pero ninguna conectada`,
        );
      } else {
        console.log(
          `✅ [Calls] ShopDomain encontrado para usuario ${userId}: ${shopDomain} (${shopifyArray.length} tienda(s) total)`,
        );
      }

      const agentsArray =
        (agent?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (agent?.agent as Record<string, unknown>) || {};

      const legacyDigitsMatch = (la: Record<string, unknown>): boolean => {
        const lpn = la.phoneNumber;
        const legacyDigits = parseInt(
          String(lpn ?? '').replace(/\D/g, '') || '0',
          10,
        );
        return legacyDigits === agentNumber && legacyDigits !== 0;
      };

      let agentData: Record<string, unknown>;

      if (matchingPhone !== undefined) {
        const mpid = Number(matchingPhone.phoneId);
        if (Number.isNaN(mpid)) {
          console.log('⚠️ [Calls] matchingPhone sin phoneId válido');
          return res.type('text/xml').send('<Response><Reject /></Response>');
        }
        const byPhone = agentsArray.find((ag) => {
          const pn = ag.phoneNumbers as Record<string, unknown> | undefined;
          return pn !== undefined && Number(pn.phoneId) === mpid;
        });
        if (byPhone) {
          agentData = byPhone;
        } else if (agentsArray.length > 0) {
          console.log(
            `⚠️ [Calls] Número en phoneNumbers sin agente vinculado (phoneId=${mpid})`,
          );
          return res.type('text/xml').send('<Response><Reject /></Response>');
        } else if (
          legacyAgent &&
          Object.keys(legacyAgent).length > 0 &&
          legacyDigitsMatch(legacyAgent)
        ) {
          agentData = legacyAgent;
        } else {
          return res.type('text/xml').send('<Response><Reject /></Response>');
        }
      } else {
        // Sin entrada en phoneNumbers[] para este To (p. ej. query legacy twilio.phoneNumber)
        if (agentsArray.length > 0) {
          console.log(
            '⚠️ [Calls] To no está en phoneNumbers[] — no enrutar a agents[0]',
          );
          return res.type('text/xml').send('<Response><Reject /></Response>');
        }
        if (
          legacyAgent &&
          Object.keys(legacyAgent).length > 0 &&
          legacyDigitsMatch(legacyAgent)
        ) {
          agentData = legacyAgent;
        } else {
          console.log(
            '⚠️ [Calls] Sin agente mapeable para este número (sin legacy válido)',
          );
          return res.type('text/xml').send('<Response><Reject /></Response>');
        }
      }

      if (agentData.state === 'Inactivo') {
        console.log(
          `⚠️ [Calls] Agente inactivo — cuelgue inmediato (userId=${userId}, agentId=${String(agentData.agentId)})`,
        );
        return res.type('text/xml').send('<Response><Reject /></Response>');
      }

      try {
        const quota = await this.usersService.hasAvailableMinutes(userId);
        if (!quota.hasMinutes) {
          console.warn(
            `[Calls] Sin minutos disponibles userId=${userId} (${quota.usedMinutes}/${quota.totalLimit})`,
          );
          const rQuota = this.twilio.newVoiceResponse();
          rQuota.say(
            {
              voice: 'alice',
              language: 'es-ES',
            },
            'Lo sentimos. Esta cuenta no tiene minutos de llamada disponibles en este periodo. Contacte con el administrador.',
          );
          rQuota.hangup();
          return res.type('text/xml').send(rQuota.toString());
        }
      } catch (quotaErr) {
        const msg =
          quotaErr instanceof Error ? quotaErr.message : 'Error desconocido';
        console.error(`❌ [Calls] Error comprobando cupo de minutos: ${msg}`);
        return res.type('text/xml').send('<Response><Reject /></Response>');
      }

      // // 🔹 Verificar antigüedad de la cuenta (deshabilitado temporalmente)
      // if (agent.createdAt) {
      //   const createdAt = (
      //     agent.createdAt as admin.firestore.Timestamp
      //   ).toDate();
      //   const diffDays =
      //     (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24);
      //
      //   if (diffDays >= 7) {
      //     console.log(
      //       `❌ Cuenta con ${diffDays.toFixed(0)} días — llamada no permitida.`,
      //     );
      //     (r.say as any)(
      //       'Su cuenta tiene más de 7 días de antigüedad. No puede realizar esta llamada.',
      //       { voice: 'alice', language: 'es-ES' },
      //     );
      //     return res.type('text/xml').send(r.toString());
      //   }
      // }

      const wsUrl = getTwilioMediaStreamWebSocketUrl();
      console.log('[Calls] Twilio Media Stream WebSocket:', wsUrl);

      const connect = r.connect();
      const stream = connect.stream({
        url: wsUrl,
        track: 'inbound_track',
      });

      const addStreamParameter = (name: string, value?: string) => {
        if (!value) return;
        const normalized = value.trim();
        if (!normalized) return;
        // Para instructions, usar límite mucho más alto; para otros parámetros mantener 450
        const limit = name === 'instructions' ? 50000 : 450;
        stream.parameter({
          name,
          value: normalized.slice(0, limit),
        });
      };

      // console.log(`🔍 [Calls] Estructura usada para usuario ${userId}:`, {
      //   tieneAgentsArray: agentsArray.length > 0,
      //   tieneLegacyAgent: Object.keys(legacyAgent).length > 0,
      //   usandoDirecta: agentData === directAgent,
      //   agentDataKeys: Object.keys(agentData),
      // });

      const agentName =
        typeof agentData.name === 'string'
          ? agentData.name
          : typeof agent?.name === 'string'
            ? agent.name
            : undefined;

      // Log para debugging de configuración del agente
      // console.log(
      //   `🔍 [Calls] Datos completos del agente para usuario ${userId}:`,
      //   JSON.stringify(agentData, null, 2),
      // );

      if (typeof agentData.voiceId === 'string') {
        console.log(
          `✅ [Calls] VoiceId encontrado para usuario ${userId}: ${agentData.voiceId}`,
        );
      } else if (typeof agentData.labsId === 'string') {
        // Mantener compatibilidad con labsId por si acaso
        console.log(
          `✅ [Calls] LabsId encontrado para usuario ${userId}: ${agentData.labsId}`,
        );
      } else {
        console.warn(
          `⚠️ [Calls] Usuario ${userId} no tiene voiceId configurado en agent. Estructura agent:`,
          Object.keys(agentData),
        );
        console.warn(`⚠️ [Calls] Valores de voiceId/labsId:`, {
          voiceId: agentData.voiceId,
          voiceIdType: typeof agentData.voiceId,
          labsId: agentData.labsId,
          labsIdType: typeof agentData.labsId,
        });
      }

      addStreamParameter('agentName', agentName);

      // 🔍 ELIMINADO: La carga de conocimiento se mueve a StreamsGateway para no bloquear a Twilio
      // let knowledgeContext = '';

      // Obtener firstInteraction: primero de agentData
      const firstInteraction =
        typeof agentData.firstInteraction === 'string'
          ? agentData.firstInteraction
          : undefined;
      addStreamParameter('greeting', firstInteraction);

      // Obtener agentInstruction: primero de agentData
      const agentInstruction =
        typeof agentData.agentInstruction === 'string'
          ? agentData.agentInstruction
          : undefined;

      addStreamParameter('instructions', agentInstruction);

      // Pasar el ID del agente para que StreamsGateway cargue el conocimiento asíncronamente
      if (agentData.agentId) {
        addStreamParameter('agentId', agentData.agentId.toString());
      } else {
        console.log(
          `ℹ️ [Calls] No se agregó contexto de conocimiento al stream (vacío o no encontrado)`,
        );
      }

      addStreamParameter(
        'labsId',
        typeof agentData.voiceId === 'string'
          ? agentData.voiceId
          : typeof agentData.labsId === 'string'
            ? agentData.labsId
            : undefined,
      );

      // console.log(`📋 [Calls] Parámetro labsId agregado al stream:`, {
      //   voiceId: agentData.voiceId,
      //   labsId: agentData.labsId,
      //   valorEnviado:
      //     typeof agentData.voiceId === 'string'
      //       ? agentData.voiceId
      //       : typeof agentData.labsId === 'string'
      //         ? agentData.labsId
      //         : undefined,
      // });

      // Obtener language: puede ser string (nueva estructura) u objeto (antigua)
      const languageCode =
        typeof agentData.language === 'string'
          ? agentData.language
          : typeof (agentData.language as Record<string, unknown>)?.code ===
              'string'
            ? ((agentData.language as Record<string, unknown>).code as string)
            : undefined;
      addStreamParameter('language', languageCode);

      // Obtener y agregar parámetros de voz personalizados del agente
      if (agentData.parameters && typeof agentData.parameters === 'object') {
        const params = agentData.parameters as Record<string, unknown>;
        // console.log(
        //   `🎛️ [Calls] Parámetros de voz encontrados para usuario ${userId}:`,
        //   params,
        // );

        // Agregar cada parámetro de voz como customParameter
        if (typeof params.stability === 'number') {
          addStreamParameter('voiceStability', params.stability.toString());
          // console.log(`✅ [Calls] voiceStability: ${params.stability}`);
        }
        if (typeof params.similarity === 'number') {
          addStreamParameter('voiceSimilarity', params.similarity.toString());
          // console.log(`✅ [Calls] voiceSimilarity: ${params.similarity}`);
        }
        if (typeof params.style === 'number') {
          addStreamParameter('voiceStyle', params.style.toString());
          // console.log(`✅ [Calls] voiceStyle: ${params.style}`);
        }
        if (typeof params.boost === 'boolean') {
          addStreamParameter('voiceBoost', params.boost.toString());
          // console.log(`✅ [Calls] voiceBoost: ${params.boost}`);
        }
        if (typeof params.speed === 'number') {
          addStreamParameter('voiceSpeed', params.speed.toString());
          // console.log(`✅ [Calls] voiceSpeed: ${params.speed}`);
        }
      } else {
        console.warn(
          `⚠️ [Calls] Usuario ${userId} no tiene parámetros de voz configurados`,
        );
        console.warn(`⚠️ [Calls] Valor de parameters:`, agentData.parameters);
        console.warn(
          `⚠️ [Calls] Tipo de parameters:`,
          typeof agentData.parameters,
        );
      }

      // Obtener credenciales de Twilio basadas en el phoneNumber
      if (twilioArray.length === 0) {
        console
          .warn
          // ...
          ();
      } else {
        let twilioConfig:
          | { twilioAccountId: number; twilioSid: string; twilioToken: string }
          | undefined;

        if (matchingPhone && matchingPhone.twilioAccountId) {
          // Buscar la cuenta de Twilio correspondiente al phoneNumber
          twilioConfig = twilioArray.find(
            (acc) => acc.twilioAccountId === matchingPhone.twilioAccountId,
          );
        }

        // Si no se encuentra o el phoneNumber no tiene twilioAccountId, usar la primera cuenta
        if (!twilioConfig && twilioArray.length > 0) {
          twilioConfig = twilioArray[0];
        }

        if (twilioConfig) {
          addStreamParameter('twilioSid', twilioConfig.twilioSid);
          addStreamParameter('twilioToken', twilioConfig.twilioToken);
          addStreamParameter(
            'twilioAccountId',
            twilioConfig.twilioAccountId.toString(),
          );
        }
      }

      // Agregar userId, shopDomain y callerPhone como customParameters para Shopify
      addStreamParameter('userId', userId);
      if (body.From) {
        addStreamParameter('callerPhone', body.From);
      }
      if (shopDomain && !shopDomain.includes('example.com')) {
        addStreamParameter('shopDomain', shopDomain);
      } else {
        console.warn(
          `⚠️ [Calls] ShopDomain no agregado (no está configurado o es de prueba para usuario ${userId})`,
        );
      }

      // ✅ TwiML generado correctamente (sin loggear el contenido completo)
      const twimlString = r.toString();
      console.log(
        '✅ TwiML generado correctamente (longitud:',
        twimlString.length,
        'caracteres)',
      );
      res.type('text/xml').send(twimlString);
    } catch (error) {
      // 🔒 No loggear el error completo que podría contener información sensible
      const errorMessage =
        error instanceof Error ? error.message : 'Error desconocido';
      console.error('❌ Error al procesar la llamada entrante:', errorMessage);
      return res.type('text/xml').send('<Response><Reject /></Response>');
    }
  }

  @Post('resume')
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  async resume(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const to =
      typeof body.To === 'string'
        ? body.To
        : typeof body.Called === 'string'
          ? body.Called
          : undefined;

    try {
      const agentDoc = await this.resolveUserDocFromPhoneTo(to);
      if (!agentDoc) {
        console.warn(
          '[Calls] resume: no se pudo resolver usuario por To/Called',
        );
        return res.type('text/xml').send('<Response><Reject /></Response>');
      }
      const userId = agentDoc.id;
      const quota = await this.usersService.hasAvailableMinutes(userId);
      if (!quota.hasMinutes) {
        console.warn(
          `[Calls] resume sin minutos userId=${userId} (${quota.usedMinutes}/${quota.totalLimit})`,
        );
        const rQuota = this.twilio.newVoiceResponse();
        rQuota.say(
          {
            voice: 'alice',
            language: 'es-ES',
          },
          'Lo sentimos. Esta cuenta no tiene minutos de llamada disponibles en este periodo. Contacte con el administrador.',
        );
        rQuota.hangup();
        return res.type('text/xml').send(rQuota.toString());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      console.error(`[Calls] resume error comprobando cupo: ${msg}`);
      return res.type('text/xml').send('<Response><Reject /></Response>');
    }

    const r = this.twilio.newVoiceResponse();
    const wsUrl = getTwilioMediaStreamWebSocketUrl();
    console.log('[Calls] resume — Twilio Media Stream WebSocket:', wsUrl);

    console.log('🔄 Reanudando stream Twilio');
    console.log('🔁 CallSid reanudado:', body?.CallSid || 'desconocido');

    const connect = r.connect();
    connect.stream({
      url: wsUrl,
      track: 'inbound_track',
    });

    const twimlString = r.toString();
    console.log(
      '📄 TwiML resume generado (longitud:',
      twimlString.length,
      'caracteres)',
    );
    res.type('text/xml').send(twimlString);
  }

  /**
   * Misma resolución usuario/agente que en incoming (número Twilio en To).
   */
  private async resolveUserDocFromPhoneTo(
    to: string | undefined,
  ): Promise<QueryDocumentSnapshot<DocumentData> | null> {
    if (!to || to === 'N/A' || to.includes('client:')) {
      return null;
    }
    const firestore = admin.firestore();
    const rawNumber = to.replace('+34', '').replace(/\D/g, '');
    const agentNumber = parseInt(rawNumber || '0', 10);

    console.log('🔍 Buscando agente con número:', agentNumber);

    let agentSnapshot = await firestore
      .collection('users')
      .where('twilio.phoneNumber', '==', agentNumber)
      .limit(1)
      .get();

    if (agentSnapshot.empty) {
      console.log('🔍 Buscando en nueva estructura phoneNumbers[]...');
      const allUsers = await firestore.collection('users').get();

      for (const userDoc of allUsers.docs) {
        const userData = userDoc.data();
        const phoneNumbers =
          (userData.phoneNumbers as Array<{
            phoneId?: number;
            countryCode?: string;
            number?: string;
          }>) || [];

        const found = phoneNumbers.some((phone) => {
          const phoneNumStr = phone.number?.replace(/\D/g, '') || '';
          const phoneNum = parseInt(phoneNumStr, 10);
          return phoneNum === agentNumber;
        });

        if (found) {
          agentSnapshot = {
            empty: false,
            docs: [userDoc],
            size: 1,
          } as QuerySnapshot<DocumentData>;
          break;
        }
      }
    }

    if (agentSnapshot.empty) {
      return null;
    }

    return agentSnapshot.docs[0];
  }

  private normalizePhone(phone?: string): string {
    return String(phone ?? '')
      .replace(/\D/g, '')
      .trim();
  }

  private isCallerBurstExceeded(from?: string, to?: string): boolean {
    const fromKey = this.normalizePhone(from);
    const toKey = this.normalizePhone(to);
    if (!fromKey || !toKey) {
      return false;
    }
    const now = Date.now();
    const key = `${fromKey}->${toKey}`;
    const cutoff = now - this.callerWindowMs;
    const current = (this.callerAttemptBuckets.get(key) ?? []).filter(
      (timestamp) => timestamp >= cutoff,
    );
    current.push(now);
    this.callerAttemptBuckets.set(key, current);
    this.compactCallerBuckets(cutoff);
    return current.length > this.callerMaxAttemptsPerWindow;
  }

  private compactCallerBuckets(cutoff: number): void {
    if (this.callerAttemptBuckets.size < 2000) {
      return;
    }
    for (const [key, timestamps] of this.callerAttemptBuckets.entries()) {
      const fresh = timestamps.filter((timestamp) => timestamp >= cutoff);
      if (fresh.length === 0) {
        this.callerAttemptBuckets.delete(key);
      } else {
        this.callerAttemptBuckets.set(key, fresh);
      }
    }
  }

  private async assertTwilioSignature(
    req: Request,
    payload: Record<string, string | undefined>,
  ): Promise<void> {
    const signature = req.header('x-twilio-signature');
    if (!signature) {
      throw new ForbiddenException('Falta cabecera X-Twilio-Signature.');
    }

    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const sanitizedPayload: Record<string, string> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') {
        sanitizedPayload[key] = value;
      }
    }

    const candidateTokens = await this.getCandidateTwilioTokens(sanitizedPayload);
    const isValid = candidateTokens.some((token) =>
      validateRequest(token, signature, url, sanitizedPayload),
    );
    if (!isValid || candidateTokens.length === 0) {
      throw new ForbiddenException('Firma de webhook Twilio inválida.');
    }
  }

  private async getCandidateTwilioTokens(
    payload: Record<string, string>,
  ): Promise<string[]> {
    const tokens = new Set<string>();
    const accountSid = payload.AccountSid?.trim();
    const to = payload.To?.trim();

    if (accountSid) {
      const fromIndex = await this.getTokensByAccountSid(accountSid);
      fromIndex.forEach((token) => tokens.add(token));
    }

    if (to) {
      const userDoc = await this.resolveUserDocFromPhoneTo(to);
      if (userDoc) {
        const userData = userDoc.data() as Record<string, unknown>;
        const twilioAccounts =
          (userData.twilio as Array<{ twilioToken?: string }>) || [];
        for (const account of twilioAccounts) {
          const token = account.twilioToken?.trim();
          if (token) {
            tokens.add(token);
          }
        }
      }
    }

    const globalToken = process.env.TWILIO_AUTH_TOKEN?.trim();
    if (globalToken) {
      tokens.add(globalToken);
    }

    return Array.from(tokens);
  }

  private async getTokensByAccountSid(accountSid: string): Promise<string[]> {
    const firestore = admin.firestore();
    const tokens = new Set<string>();

    const indexDoc = await firestore.collection('twilio_index').doc(accountSid).get();
    if (indexDoc.exists) {
      const userId = (indexDoc.data() as Record<string, string>)?.userId;
      if (userId) {
        const userDoc = await firestore.collection('users').doc(userId).get();
        if (userDoc.exists) {
          const userData = userDoc.data() as Record<string, unknown>;
          const twilioAccounts =
            (userData.twilio as Array<{
              twilioSid?: string;
              twilioToken?: string;
            }>) || [];
          for (const account of twilioAccounts) {
            if (account.twilioSid === accountSid && account.twilioToken?.trim()) {
              tokens.add(account.twilioToken.trim());
            }
          }
        }
      }
    }

    if (tokens.size > 0) {
      return Array.from(tokens);
    }

    const usersSnapshot = await firestore.collection('users').get();
    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data() as Record<string, unknown>;
      const twilioAccounts =
        (userData.twilio as Array<{ twilioSid?: string; twilioToken?: string }>) ||
        [];
      for (const account of twilioAccounts) {
        if (account.twilioSid === accountSid && account.twilioToken?.trim()) {
          tokens.add(account.twilioToken.trim());
        }
      }
    }

    return Array.from(tokens);
  }
}
