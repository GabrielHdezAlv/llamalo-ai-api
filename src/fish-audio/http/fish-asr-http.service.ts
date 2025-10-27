import { Injectable } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class FishAsrHttpService {
  private fishApiKey = process.env.FISH_API_KEY;
  private language = process.env.FISH_LANG || 'es-ES';

  async transcribeAudio(audioBuffer: Buffer): Promise<string> {
    try {
      console.log('🎙️ Transcribiendo audio ASR HTTP...');
      
      const formData = new FormData();
      formData.append('audio', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
      formData.append('language', this.language);

      const response = await axios.post(
        'https://api.fish.audio/v1/asr',
        formData,
        {
          headers: {
            Authorization: `Bearer ${this.fishApiKey}`,
            'Content-Type': 'multipart/form-data',
          },
        },
      );

      const transcript = response.data?.text || '';
      console.log('✅ Audio transcrito:', transcript);
      
      return transcript;
    } catch (error) {
      console.error('❌ Error transcribiendo audio ASR:', error);
      throw error;
    }
  }

  async transcribeFromBase64(audioBase64: string): Promise<string> {
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      return await this.transcribeAudio(audioBuffer);
    } catch (error) {
      console.error('❌ Error transcribiendo desde base64:', error);
      throw error;
    }
  }
}
