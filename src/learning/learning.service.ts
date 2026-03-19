import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as admin from 'firebase-admin';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);
  private readonly openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
  private readonly datasetPath = path.resolve(process.cwd(), 'dataset/calls_training.jsonl');

  constructor() {
    // Asegurar que el directorio dataset existe
    const dir = path.dirname(this.datasetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Ejecuta el pipeline de evaluación cada día a las 2 AM
   * Lee las llamadas no procesadas, las evalúa usando GPT-4o-mini
   * y guarda las mejores en un formato apto para Fine-tuning.
   */
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async processCallLogs() {
    this.logger.log('Iniciando pipeline de aprendizaje automático...');
    
    try {
      const db = admin.firestore();
      
      // Obtener llamadas no procesadas. Filtramos la duración en memoria para 
      // evitar requerir un índice compuesto en Firestore
      const callsSnapshot = await db.collection('calls_logs')
        .where('processedForLearning', '==', false)
        .limit(50) // Procesar en batches para no sobrecargar
        .get();

      if (callsSnapshot.empty) {
        this.logger.log('No hay nuevas llamadas para procesar.');
        return;
      }

      this.logger.log(`Encontradas ${callsSnapshot.size} llamadas para evaluar.`);

      for (const doc of callsSnapshot.docs) {
        const callData = doc.data();
        const callId = doc.id;
        
        // Filtrar duración localmente
        if (callData.duration <= 20) {
          await doc.ref.update({
            processedForLearning: true,
            learningScore: 0,
            addedToDataset: false,
            skippedReason: 'duration_too_short'
          });
          continue;
        }
        
        try {
          const score = await this.evaluateCall(callData.history);
          
          const isEligible = score >= 7;

          // Si es buena llamada, la guardamos en la colección de dataset y en JSONL
          if (isEligible) {
            // Formato ChatML para OpenAI Fine-Tuning
            const jsonlLine = JSON.stringify({
              messages: [
                { role: 'system', content: 'agente telefónico claro y natural' },
                ...callData.history.filter((msg: any) => msg.content)
              ]
            }) + '\n';

            fs.appendFileSync(this.datasetPath, jsonlLine, 'utf8');

            await db.collection('learning_dataset').add({
              originalCallId: callId,
              userId: callData.userId,
              score,
              history: callData.history,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }

          // Marcar como procesada
          await doc.ref.update({
            processedForLearning: true,
            learningScore: score,
            addedToDataset: isEligible
          });

          this.logger.log(`Llamada ${callId} evaluada. Score: ${score}. Elegible: ${isEligible}`);
        } catch (evalError) {
          this.logger.error(`Error evaluando la llamada ${callId}:`, evalError);
        }
      }

      this.logger.log('Pipeline de aprendizaje finalizado con éxito.');
    } catch (error) {
      this.logger.error('Error general en el pipeline de aprendizaje:', error);
    }
  }

  /**
   * Envía el historial de la llamada a un modelo LLM pequeño para que
   * califique la calidad de la conversación.
   */
  private async evaluateCall(history: {role: string, content: string}[]): Promise<number> {
    if (!history || history.length < 4) return 0; // Conversaciones muy cortas se descartan

    const conversationText = history
      .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const prompt = `
Eres un evaluador de calidad para agentes telefónicos de IA.
Tu objetivo es leer la siguiente transcripción y evaluar qué tan natural, resolutiva y fluida fue la conversación.

Criterios de evaluación:
- ¿El agente respondió correctamente sin repetir preguntas innecesariamente?
- ¿El usuario se notó frustrado o repitió información por errores del agente?
- ¿La conversación fluyó con naturalidad?

Responde ÚNICAMENTE con un número entero del 0 al 10 que represente el score general. Un 10 es una llamada perfecta que podría usarse para entrenar a la IA. Un < 7 tiene defectos que no queremos enseñar.

TRANSCRIPCIÓN:
${conversationText}
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini', // Modelo económico y rápido para evaluación
        messages: [{ role: 'system', content: prompt }],
        temperature: 0.1, // Baja temperatura para consistencia
        max_tokens: 10,
      });

      const scoreText = response.choices[0]?.message?.content?.trim() || '0';
      const scoreMatch = scoreText.match(/\d+/);
      
      if (scoreMatch) {
        return Math.min(10, Math.max(0, parseInt(scoreMatch[0], 10)));
      }
      return 0;
    } catch (error) {
      this.logger.warn('Fallo al evaluar con OpenAI, asumiendo score 0', error);
      return 0;
    }
  }
}
