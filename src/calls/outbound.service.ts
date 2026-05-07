import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Twilio, twiml } from 'twilio';
import { DateTime } from 'luxon';
import { getFirestore } from '../firebase/firebase.config';
import { getTwilioMediaStreamWebSocketUrl } from './twilio-media-stream-url';
import { UsersService } from '../users/users.service';
import axios from 'axios';
import {
  isWithinCallingWindow,
  maxCallsPerDayLimit,
  maxRetriesAllowed,
  OUTBOUND_SCHEDULE_TZ,
  parseOutboundScheduleNotes,
  parseOutboundSegmentationNotes,
  phoneMatchesCountrySegmentation,
  scheduleRetryNotBeforeLuxon,
  nextDayWindowOpenLuxon,
} from './outbound-scheduling.util';

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);
  private firestore = getFirestore();

  constructor(private readonly usersService: UsersService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleOutboundQueue() {
    this.logger.log('Revisando cola de llamadas outbound...');
    const queueRef = this.firestore.collection('outbound_queue');
    const snapshot = await queueRef
      .where('status', '==', 'pending')
      .limit(40)
      .get();

    if (snapshot.empty) {
      return;
    }

    const nowLuxon = DateTime.now().setZone(OUTBOUND_SCHEDULE_TZ);
    const userCache = new Map<string, Record<string, unknown>>();

    type EligibleDoc = {
      docId: string;
      data: Record<string, unknown>;
      schedule: ReturnType<typeof parseOutboundScheduleNotes>;
      agent: Record<string, unknown>;
    };

    const eligible: EligibleDoc[] = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const docId = doc.id;
      const userId = String(data.userId ?? '');
      const agentId = Number(data.agentId ?? 0);

      if (!userId || !agentId) {
        continue;
      }

      let userData = userCache.get(userId);
      if (!userData) {
        const userSnap = await this.firestore.collection('users').doc(userId).get();
        if (!userSnap.exists) {
          await queueRef.doc(docId).update({
            status: 'failed',
            errorMessage: 'Usuario no encontrado',
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        userData = userSnap.data() as Record<string, unknown>;
        userCache.set(userId, userData);
      }

      const agentsArray =
        (userData.agents as Array<Record<string, unknown>>) || [];
      const agent = agentsArray.find((a) => Number(a.agentId) === agentId);
      if (!agent || agent.type !== 'outbound') {
        await queueRef.doc(docId).update({
          status: 'failed',
          errorMessage: 'Agente outbound no encontrado',
          updatedAt: new Date().toISOString(),
        });
        continue;
      }

      const schedule = parseOutboundScheduleNotes(
        agent.outboundScheduleCampaignNotes as string | undefined,
      );
      const segmentation = parseOutboundSegmentationNotes(
        agent.outboundSegmentationNotes as string | undefined,
      );

      const notBeforeRaw = data.notBefore as string | undefined;
      const notBefore = notBeforeRaw
        ? DateTime.fromISO(notBeforeRaw, { setZone: true }).setZone(
            OUTBOUND_SCHEDULE_TZ,
          )
        : nowLuxon;
      if (notBefore > nowLuxon) {
        continue;
      }

      if (!isWithinCallingWindow(nowLuxon, schedule)) {
        continue;
      }

      const phoneNumber = String(data.phoneNumber ?? '');
      if (!phoneMatchesCountrySegmentation(phoneNumber, segmentation)) {
        await queueRef.doc(docId).update({
          status: 'failed',
          errorMessage:
            'Segmentación: el número no coincide con el país configurado para la campaña.',
          updatedAt: nowLuxon.toUTC().toISO()!,
        });
        continue;
      }

      const todayStr = nowLuxon.toFormat('yyyy-MM-dd');
      const maxCalls = maxCallsPerDayLimit(schedule);
      const callsTodayDate = data.callsTodayDate as string | undefined;
      const dialsTodayCount =
        callsTodayDate === todayStr ? Number(data.dialsTodayCount ?? 0) : 0;

      if (dialsTodayCount >= maxCalls) {
        await queueRef.doc(docId).update({
          notBefore: nextDayWindowOpenLuxon(nowLuxon, schedule)
            .toUTC()
            .toISO()!,
          updatedAt: nowLuxon.toUTC().toISO()!,
        });
        continue;
      }

      eligible.push({ docId, data: data as Record<string, unknown>, schedule, agent });
      if (eligible.length >= 10) {
        break;
      }
    }

    for (const item of eligible) {
      try {
        await queueRef.doc(item.docId).update({
          status: 'calling',
          updatedAt: new Date().toISOString(),
        });
        await this.processOutboundCall(
          item.docId,
          item.data,
          item.agent,
          item.schedule,
        );
      } catch (error) {
        this.logger.error(
          `Error procesando llamada a ${item.data.phoneNumber}:`,
          error,
        );
        await this.applyOutboundFailure(
          item.docId,
          item.data,
          item.schedule,
          error instanceof Error ? error.message : 'Error desconocido',
        );
      }
    }
  }

  private async applyOutboundFailure(
    docId: string,
    data: Record<string, unknown>,
    schedule: ReturnType<typeof parseOutboundScheduleNotes>,
    message: string,
  ): Promise<void> {
    const queueRef = this.firestore.collection('outbound_queue');
    const failureCount = Number(data.failureCount ?? 0);
    const failuresAfter = failureCount + 1;
    const maxR = maxRetriesAllowed(schedule);
    const nowLuxon = DateTime.now().setZone(OUTBOUND_SCHEDULE_TZ);

    if (failuresAfter <= maxR) {
      const nextNb = scheduleRetryNotBeforeLuxon(schedule, nowLuxon);
      await queueRef.doc(docId).update({
        status: 'pending',
        failureCount: failuresAfter,
        errorMessage: message.slice(0, 500),
        notBefore: nextNb.toUTC().toISO()!,
        updatedAt: nowLuxon.toUTC().toISO()!,
      });
      return;
    }

    await queueRef.doc(docId).update({
      status: 'failed',
      failureCount: failuresAfter,
      errorMessage: message.slice(0, 500),
      updatedAt: nowLuxon.toUTC().toISO()!,
    });
  }

  private async processOutboundCall(
    docId: string,
    data: Record<string, unknown>,
    agent: Record<string, unknown>,
    schedule: ReturnType<typeof parseOutboundScheduleNotes>,
  ): Promise<void> {
    const userId = String(data.userId ?? '');
    const agentId = Number(data.agentId ?? 0);
    const toPhoneNumber = String(data.phoneNumber ?? '');
    const campaignKind =
      String(data.campaignKind ?? '') ||
      String(agent.outboundCampaignKind ?? '');

    const userDocRef = this.firestore.collection('users').doc(userId);
    const userSnapshot = await userDocRef.get();

    if (!userSnapshot.exists) {
      throw new Error('Usuario no encontrado');
    }

    const userData = userSnapshot.data() as Record<string, unknown>;

    const quota = await this.usersService.hasAvailableMinutes(userId);
    if (!quota.hasMinutes) {
      throw new Error('No hay minutos disponibles');
    }

    const twilioAccountId = agent.twilioAccountId;
    const twilioArray = (userData.twilio as Array<Record<string, unknown>>) || [];
    let twilioConfig = twilioArray.find(
      (acc) => acc.twilioAccountId === twilioAccountId,
    );

    if (!twilioConfig && twilioArray.length > 0) {
      twilioConfig = twilioArray[0];
    }

    if (!twilioConfig) {
      throw new Error('Configuración de Twilio no encontrada');
    }

    let fromNumber = '';
    const agentPhoneNumbers = agent.phoneNumbers as Record<string, unknown>;
    if (agentPhoneNumbers && agentPhoneNumbers.number) {
      fromNumber = `+${agentPhoneNumbers.countryCode || ''}${agentPhoneNumbers.number}`.replace(
        '++',
        '+',
      );
    } else {
      throw new Error('El agente no tiene número configurado');
    }

    const client = new Twilio(
      String(twilioConfig.twilioSid),
      String(twilioConfig.twilioToken),
    );

    const wsUrl = getTwilioMediaStreamWebSocketUrl();
    const voiceResponse = new twiml.VoiceResponse();
    voiceResponse.pause({ length: 1 });
    const connect = voiceResponse.connect();
    const stream = connect.stream({ url: wsUrl });

    stream.parameter({ name: 'agentId', value: agentId.toString() });
    stream.parameter({
      name: 'outboundCampaign',
      value: campaignKind || 'outbound',
    });
    stream.parameter({ name: 'userId', value: userId });
    stream.parameter({ name: 'callerPhone', value: toPhoneNumber });

    if (agent.shopifyDomain) {
      stream.parameter({
        name: 'shopDomain',
        value: String(agent.shopifyDomain),
      });
    }

    this.logger.log(`Iniciando llamada outbound desde ${fromNumber} a ${toPhoneNumber}`);

    try {
      const call = await client.calls.create({
        to: toPhoneNumber,
        from: fromNumber,
        twiml: voiceResponse.toString(),
        record: false,
      });

      this.logger.log(`Llamada creada con SID: ${call.sid}`);

      const nowLuxon = DateTime.now().setZone(OUTBOUND_SCHEDULE_TZ);
      const todayStr = nowLuxon.toFormat('yyyy-MM-dd');
      const prevDate = data.callsTodayDate as string | undefined;
      const prevCount = Number(data.dialsTodayCount ?? 0);
      const nextDialCount =
        prevDate === todayStr ? prevCount + 1 : 1;

      await this.firestore.collection('outbound_queue').doc(docId).update({
        status: 'completed',
        callSid: call.sid,
        failureCount: 0,
        callsTodayDate: todayStr,
        dialsTodayCount: nextDialCount,
        errorMessage: '',
        updatedAt: nowLuxon.toUTC().toISO()!,
      });
    } catch (callError: unknown) {
      const code =
        callError && typeof callError === 'object' && 'code' in callError
          ? (callError as { code?: number }).code
          : undefined;
      if (code === 32205) {
        throw new Error(
          'Geographic Permission Required: Debes habilitar los permisos de llamadas internacionales para este país en la consola de Twilio (Voice -> Settings -> Geo Permissions).',
        );
      }
      throw callError;
    }
  }

  async checkVoiceGeographicPermissions(
    twilioSid: string,
    twilioToken: string,
    countryIsoCode: string = 'ES',
  ): Promise<boolean> {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const response = await axios.get(
        `https://voice.twilio.com/v1/DialingPermissions/Countries/${countryIsoCode}`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        },
      );

      return response.data?.dialing_permissions === true;
    } catch (error) {
      this.logger.warn(
        `No se pudo verificar el permiso geográfico para ${countryIsoCode}: ${error instanceof Error ? error.message : 'Error desconocido'}`,
      );
      return true;
    }
  }
}
