import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Twilio, twiml } from 'twilio';
import { getFirestore } from '../firebase/firebase.config';
import { getTwilioMediaStreamWebSocketUrl } from './twilio-media-stream-url';
import { UsersService } from '../users/users.service';
import { TwilioService as CoreTwilioService } from '../twilio/twilio.service'; // Renombramos si es necesario o no lo usamos
import axios from 'axios';

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);
  private firestore = getFirestore();

  constructor(
    private readonly usersService: UsersService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleOutboundQueue() {
    this.logger.log('Revisando cola de llamadas outbound...');
    const queueRef = this.firestore.collection('outbound_queue');
    const snapshot = await queueRef
      .where('status', '==', 'pending')
      .limit(10) // Procesar de 10 en 10 para no saturar
      .get();

    if (snapshot.empty) {
      return;
    }

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const docId = doc.id;
      
      try {
        await queueRef.doc(docId).update({ status: 'calling', updatedAt: new Date().toISOString() });
        await this.processOutboundCall(data.userId, data.agentId, data.phoneNumber, data.campaignKind, docId);
      } catch (error) {
        this.logger.error(`Error procesando llamada a ${data.phoneNumber}:`, error);
        await queueRef.doc(docId).update({ 
          status: 'failed', 
          errorMessage: error instanceof Error ? error.message : 'Error desconocido',
          updatedAt: new Date().toISOString() 
        });
      }
    }
  }

  private async processOutboundCall(userId: string, agentId: number, toPhoneNumber: string, campaignKind: string, docId: string) {
    const userDocRef = this.firestore.collection('users').doc(userId);
    const userSnapshot = await userDocRef.get();

    if (!userSnapshot.exists) {
      throw new Error('Usuario no encontrado');
    }

    const userData = userSnapshot.data() as Record<string, any>;
    
    // Validar cupo
    const quota = await this.usersService.hasAvailableMinutes(userId);
    if (!quota.hasMinutes) {
      throw new Error('No hay minutos disponibles');
    }

    // Encontrar agente
    const agentsArray = userData.agents as Array<Record<string, any>> || [];
    const agent = agentsArray.find((a) => a.agentId === agentId);

    if (!agent) {
      throw new Error('Agente no encontrado');
    }

    // Obtener configuración de Twilio del agente
    const twilioAccountId = agent.twilioAccountId;
    const twilioArray = userData.twilio as Array<any> || [];
    let twilioConfig = twilioArray.find((acc) => acc.twilioAccountId === twilioAccountId);

    if (!twilioConfig && twilioArray.length > 0) {
      twilioConfig = twilioArray[0]; // Fallback
    }

    if (!twilioConfig) {
      throw new Error('Configuración de Twilio no encontrada');
    }

    // Obtener número desde el que llamamos
    let fromNumber = '';
    const agentPhoneNumbers = agent.phoneNumbers as any;
    if (agentPhoneNumbers && agentPhoneNumbers.number) {
      fromNumber = `+${agentPhoneNumbers.countryCode || ''}${agentPhoneNumbers.number}`.replace('++', '+');
    } else {
      throw new Error('El agente no tiene número configurado');
    }

    // Instanciar cliente Twilio
    const client = new Twilio(twilioConfig.twilioSid, twilioConfig.twilioToken);

    // Preparar TwiML
    const wsUrl = getTwilioMediaStreamWebSocketUrl();
    const voiceResponse = new twiml.VoiceResponse();
    voiceResponse.pause({ length: 1 });
    const connect = voiceResponse.connect();
    const stream = connect.stream({ url: wsUrl });

    // Pasar parámetros al stream
    stream.parameter({ name: 'agentId', value: agentId.toString() });
    stream.parameter({ name: 'outboundCampaign', value: campaignKind || 'outbound' });
    stream.parameter({ name: 'userId', value: userId });
    stream.parameter({ name: 'callerPhone', value: toPhoneNumber }); // Para el outbound, el callerPhone es a quién llamamos para mantener consistencia con variables de session

    if (agent.shopifyDomain) {
      stream.parameter({ name: 'shopDomain', value: agent.shopifyDomain });
    }

    // Emitir llamada
    this.logger.log(`Iniciando llamada outbound desde ${fromNumber} a ${toPhoneNumber}`);
    
    try {
      const call = await client.calls.create({
        to: toPhoneNumber,
        from: fromNumber,
        twiml: voiceResponse.toString(),
        record: false, // Puedes cambiarlo si se requiere grabar
      });

      this.logger.log(`Llamada creada con SID: ${call.sid}`);

      // Actualizar estado
      await this.firestore.collection('outbound_queue').doc(docId).update({
        status: 'completed',
        callSid: call.sid,
        updatedAt: new Date().toISOString(),
      });
    } catch (callError: any) {
      if (callError.code === 32205) {
        throw new Error('Geographic Permission Required: Debes habilitar los permisos de llamadas internacionales para este país en la consola de Twilio (Voice -> Settings -> Geo Permissions).');
      }
      throw callError;
    }
  }

  // Helper para validación geográfica manual en Twilio
  async checkVoiceGeographicPermissions(twilioSid: string, twilioToken: string, countryIsoCode: string = 'ES'): Promise<boolean> {
    try {
      const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
      const response = await axios.get(
        `https://voice.twilio.com/v1/DialingPermissions/Countries/${countryIsoCode}`,
        {
          headers: {
            Authorization: `Basic ${auth}`,
          },
        }
      );
      
      return response.data?.dialing_permissions === true;
    } catch (error) {
      this.logger.warn(`No se pudo verificar el permiso geográfico para ${countryIsoCode}: ${error instanceof Error ? error.message : 'Error desconocido'}`);
      // Asumimos true para no bloquear el flujo, Twilio devolverá error al llamar si no tiene permiso
      return true;
    }
  }
}
