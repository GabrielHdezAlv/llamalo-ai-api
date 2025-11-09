export interface FishAsrInit {
  type: 'asr_init';
  sample_rate: number;
  language: string;
  encoding?: 'pcm16';
  session_id?: string;
  enable_intermediate_results?: boolean;
}

export interface FishAsrReady {
  type: 'asr_ready';
  session_id?: string;
}

export interface FishAsrAudio {
  type: 'asr_audio';
  audio: string; // base64 PCM16
}

export interface FishAsrStop {
  type: 'asr_stop';
}

export interface FishAsrError {
  type: 'asr_error';
  error?: string;
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
  encoding?: 'pcm16';
  session_id?: string;
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

export interface FishTtsReady {
  type: 'tts_ready';
  session_id?: string;
}

export interface FishTtsError {
  type: 'tts_error';
  error?: string;
}

export interface FishTtsEnd {
  type: 'tts_end';
  reason?: string;
}

export type FishAsrIncoming =
  | FishAsrReady
  | FishAsrError
  | FishAsrTranscript;

export type FishTtsIncoming =
  | FishTtsReady
  | FishTtsError
  | FishTtsEnd
  | FishTtsAudio;
