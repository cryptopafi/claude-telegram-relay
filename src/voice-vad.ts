/**
 * voice-vad.ts
 * Energy-based Voice Activity Detection (VAD)
 * Detects when someone is speaking vs silence
 */

export type VADEvent = 'speech_start' | 'speech_end' | 'speaking';

export interface VADConfig {
  energyThreshold: number;      // Audio energy threshold for speech
  silenceDurationMs: number;     // How long silence before speech_end
  minSpeechDurationMs: number;   // Minimum duration to count as speech
  sampleRate: number;            // Audio sample rate (8000 for telephony)
}

export interface VADResult {
  event: VADEvent | null;
  energy: number;
  audioBuffer: Buffer | null;  // Buffered audio during speech
}

/**
 * Voice Activity Detector
 * Uses energy-based detection to identify speech
 */
export class VoiceActivityDetector {
  private config: VADConfig;
  private isSpeaking: boolean = false;
  private speechStartTime: number = 0;
  private lastSpeechTime: number = 0;
  private audioBuffer: Buffer[] = [];
  private audioBufferSize: number = 0; // BUG FIX #4: Track buffer size incrementally

  constructor(config: VADConfig) {
    this.config = config;
  }

  /**
   * Calculate RMS (Root Mean Square) energy of PCM audio
   * PCM data is 16-bit signed integers
   */
  private calculateEnergy(buffer: Buffer): number {
    if (buffer.length === 0) {
      return 0;
    }

    let sum = 0;
    const samples = buffer.length / 2; // 16-bit = 2 bytes per sample

    for (let i = 0; i < buffer.length; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }

    const rms = Math.sqrt(sum / samples);
    return rms;
  }

  /**
   * Process audio chunk and detect voice activity
   *
   * @param audioChunk - PCM audio data (LINEAR16, 16-bit signed)
   * @returns VAD result with event and buffered audio
   */
  process(audioChunk: Buffer): VADResult {
    const energy = this.calculateEnergy(audioChunk);
    const now = Date.now();
    const isSpeechEnergy = energy > this.config.energyThreshold;

    let event: VADEvent | null = null;
    let audioBuffer: Buffer | null = null;

    // BUG FIX #4: Max buffer = 10MB
    const maxBufferBytes = 10 * 1024 * 1024;

    // Speech detection state machine
    if (isSpeechEnergy) {
      this.lastSpeechTime = now;

      if (!this.isSpeaking) {
        // Speech started
        this.isSpeaking = true;
        this.speechStartTime = now;
        this.audioBuffer = [audioChunk];
        this.audioBufferSize = audioChunk.length;
        event = 'speech_start';
      } else {
        // Continue speaking
        // BUG FIX #4: Check buffer limit before adding
        if (this.audioBufferSize + audioChunk.length > maxBufferBytes) {
          console.warn('[VAD] Buffer limit reached, dropping chunk');
        } else {
          this.audioBuffer.push(audioChunk);
          this.audioBufferSize += audioChunk.length;
        }
        event = 'speaking';
      }
    } else {
      // Low energy (silence)
      if (this.isSpeaking) {
        const silenceDuration = now - this.lastSpeechTime;
        const speechDuration = now - this.speechStartTime;

        if (silenceDuration >= this.config.silenceDurationMs) {
          // Speech ended
          this.isSpeaking = false;

          // Only return buffered audio if speech was long enough
          if (speechDuration >= this.config.minSpeechDurationMs) {
            audioBuffer = Buffer.concat(this.audioBuffer);
            event = 'speech_end';
          }

          this.audioBuffer = [];
          this.audioBufferSize = 0;
        } else {
          // Still in speech, just a brief pause
          // BUG FIX #4: Check buffer limit
          if (this.audioBufferSize + audioChunk.length > maxBufferBytes) {
            console.warn('[VAD] Buffer limit reached, dropping chunk');
          } else {
            this.audioBuffer.push(audioChunk);
            this.audioBufferSize += audioChunk.length;
          }
          event = 'speaking';
        }
      }
    }

    return {
      event,
      energy,
      audioBuffer,
    };
  }

  /**
   * Reset VAD state
   */
  reset(): void {
    this.isSpeaking = false;
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.audioBuffer = [];
    this.audioBufferSize = 0; // BUG FIX #4: Reset buffer size
  }

  /**
   * Get current state
   */
  getState(): {
    isSpeaking: boolean;
    speechDurationMs: number;
    audioBufferSize: number;
  } {
    return {
      isSpeaking: this.isSpeaking,
      speechDurationMs: this.isSpeaking ? Date.now() - this.speechStartTime : 0,
      audioBufferSize: this.audioBufferSize, // BUG FIX #4: Return tracked size
    };
  }

  /**
   * Convert mulaw to PCM16
   * Telnyx sends audio in mulaw format, we need PCM16 for energy calculation
   */
  static mulawToPCM16(mulawBuffer: Buffer): Buffer {
    const MULAW_BIAS = 0x84;
    const MULAW_MAX = 0x1FFF;

    const pcm16 = Buffer.alloc(mulawBuffer.length * 2);

    for (let i = 0; i < mulawBuffer.length; i++) {
      const mulaw = mulawBuffer[i];

      // Invert bits
      const inverted = ~mulaw;

      // Extract sign, exponent, mantissa
      const sign = (inverted >> 7) & 0x01;
      const exponent = (inverted >> 4) & 0x07;
      const mantissa = inverted & 0x0F;

      // Calculate linear value
      let linear = ((mantissa << 3) + MULAW_BIAS) << exponent;

      // Apply sign
      if (sign === 0) {
        linear = -linear;
      }

      // Clamp to 16-bit range
      linear = Math.max(-32768, Math.min(32767, linear));

      // Write to PCM buffer
      pcm16.writeInt16LE(linear, i * 2);
    }

    return pcm16;
  }

  /**
   * Convert base64 mulaw audio to PCM16 buffer
   */
  static base64MulawToPCM16(base64Audio: string): Buffer {
    const mulawBuffer = Buffer.from(base64Audio, 'base64');
    return this.mulawToPCM16(mulawBuffer);
  }
}
