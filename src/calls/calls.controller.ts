import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TwilioService } from './twilio.service';
import { AgentKnowledgeService } from '../agents/agent-knowledge.service';
import * as admin from 'firebase-admin';

class IncomingDto {
  To?: string;
  From?: string;
  CallSid?: string;
}

@Controller('voice')
export class CallsController {
  constructor(
    private readonly twilio: TwilioService,
    private readonly agentKnowledgeService: AgentKnowledgeService,
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
  async incoming(@Body() body: IncomingDto, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const firestore = admin.firestore();

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

    try {
      // 🔹 Buscar agente por su número Twilio (body.To)
      const rawNumber = body.To?.replace('+34', '').replace(/\D/g, '');
      const agentNumber = parseInt(rawNumber || '0', 10);

      console.log('🔍 Buscando agente con número:', agentNumber);

      // Primero intentar búsqueda con estructura antigua (compatibilidad)
      let agentSnapshot = await firestore
        .collection('users')
        .where('twilio.phoneNumber', '==', agentNumber)
        .limit(1)
        .get();

      // Si no se encuentra, buscar en la nueva estructura phoneNumbers[]
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

          // Buscar en el array de números
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
            } as FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;
            break;
          }
        }
      }

      if (agentSnapshot.empty) {
        console.log('⚠️ No se encontró ningún agente con ese número.');
        (r.say as any)(
          'El número de agente no está configurado. Inténtelo más tarde.',
          {
            voice: 'alice',
            language: 'es-ES',
          },
        );
        return res.type('text/xml').send(r.toString());
      }

      const agentDoc = agentSnapshot.docs[0];
      const userId = agentDoc.id;
      const agent = agentDoc.data();

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

      const wsUrl =
        process.env.NODE_ENV === 'production'
          ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
          : 'ws://localhost:3000/voice/stream';

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

      // Obtener datos del agente: primero intentar nueva estructura (agents[]), luego antigua (agent), luego directa
      const agentsArray =
        (agent?.agents as Array<Record<string, unknown>>) || [];
      const legacyAgent = (agent?.agent as Record<string, unknown>) || {};

      // NUEVO: Intentar obtener directamente del documento principal
      const directAgent = agent as Record<string, unknown>;

      // Usar primer agente del array si existe, sino estructura antigua, sino directa
      let agentData: Record<string, unknown>;
      if (agentsArray.length > 0) {
        agentData = agentsArray[0];
      } else if (legacyAgent && Object.keys(legacyAgent).length > 0) {
        agentData = legacyAgent;
      } else {
        agentData = directAgent;
      }

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
      (r.say as any)(
        'Ha ocurrido un error interno. Por favor, inténtelo más tarde.',
        {
          voice: 'alice',
          language: 'es-ES',
        },
      );
      res.type('text/xml').send(r.toString());
    }
  }

  @Post('resume')
  resume(@Body() body: Record<string, unknown>, @Res() res: Response) {
    const r = this.twilio.newVoiceResponse();
    const wsUrl =
      process.env.NODE_ENV === 'production'
        ? 'wss://llamaloiabackend-5294.onrender.com/voice/stream'
        : 'ws://localhost:3000/voice/stream';

    console.log('🔄 Reanudando stream Twilio');
    console.log('🔁 CallSid reanudado:', body?.CallSid || 'desconocido');

    const connect = r.connect();
    connect.stream({
      url: wsUrl,
      track: 'inbound_track',
    });

    const twimlString = r.toString();
    // ✅ Solo loggear longitud, no el contenido completo
    console.log(
      '📄 TwiML resume generado (longitud:',
      twimlString.length,
      'caracteres)',
    );
    res.type('text/xml').send(twimlString);
  }
}
