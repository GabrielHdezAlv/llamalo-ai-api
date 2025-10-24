export interface FishAsrInit {
  type: 'asr_init';
  sample_rate: number;
  language: string;
}

export interface FishAsrAudio {
  type: 'asr_audio';
  audio: string; // base64 PCM16
}

export interface FishAsrStop {
  type: 'asr_stop';
}

export interface FishAsrTranscript {
  type: 'asr_transcript';
  text: string;
  is_final: boolean;
}

export interface FishTtsInit {
  type: 'tts_init';
  voice_id: string;
  sample_rate: number;
  language: string;
}

export interface FishTtsText {
  type: 'tts_text';
  text: string;
}

export interface FishTtsAudio {
  type: 'tts_audio';
  audio: string;
  is_final?: boolean;
}
