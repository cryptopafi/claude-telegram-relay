/**
 * voice-tts-call.ts
 * Google Cloud TTS for phone calls (separate from Telegram TTS)
 * Outputs LINEAR16 PCM audio for Telnyx telephony
 */

/**
 * Detect if text is primarily Romanian
 * Uses same logic as existing tts.ts
 */
function isRomanian(text: string): boolean {
  const romanianIndicators = [
    'ă', 'â', 'î', 'ș', 'ț',  // Diacritics
    'este', 'sunt', 'pentru', 'acest', 'această',  // Common words
    'la', 'de', 'cu', 'pe', 'în',
  ];

  const lowerText = text.toLowerCase();
  const indicatorCount = romanianIndicators.filter(indicator =>
    lowerText.includes(indicator)
  ).length;

  return indicatorCount >= 2;
}

/**
 * Clean text for speech synthesis
 * Remove markdown, code blocks, URLs, special characters
 */
function cleanTextForSpeech(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, '')
    // Remove inline code
    .replace(/`[^`]+`/g, '')
    // Remove URLs
    .replace(/https?:\/\/[^\s]+/g, '')
    // Remove markdown bold/italic
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    // Remove markdown headers
    .replace(/^#+\s+/gm, '')
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove emojis (basic removal)
    .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
    .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    // Remove special characters
    .replace(/[•✓✗→←↑↓]/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate speech audio using Google Cloud TTS Chirp3-HD
 *
 * @param text - Text to convert to speech
 * @param apiKey - Google Cloud API key
 * @param romanianVoice - Romanian voice name (default: ro-RO-Chirp3-HD-Aoede)
 * @param englishVoice - English voice name (default: en-US-Chirp3-HD-Aoede)
 * @returns PCM audio buffer (LINEAR16, 8000Hz, mono)
 */
export async function generateCallSpeech(
  text: string,
  apiKey: string,
  romanianVoice: string = 'ro-RO-Chirp3-HD-Aoede',
  englishVoice: string = 'en-US-Chirp3-HD-Aoede',
): Promise<Buffer> {
  // Clean text for speech
  const cleanedText = cleanTextForSpeech(text);

  if (cleanedText.length === 0) {
    throw new Error('No valid text to synthesize after cleaning');
  }

  // Detect language
  const isRo = isRomanian(cleanedText);
  const voiceName = isRo ? romanianVoice : englishVoice;
  const languageCode = isRo ? 'ro-RO' : 'en-US';

  console.log(`[TTS] Generating speech: lang=${languageCode}, voice=${voiceName}, text="${cleanedText.substring(0, 100)}..."`);

  // Google Cloud TTS API request
  const requestBody = {
    input: {
      text: cleanedText,
    },
    voice: {
      languageCode,
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'LINEAR16',  // Raw PCM for telephony
      sampleRateHertz: 8000,      // 8kHz for telephony (Telnyx standard)
      pitch: 0,
      speakingRate: 1.0,
    },
  };

  try {
    const response = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google TTS API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (!data.audioContent) {
      throw new Error('No audio content in TTS response');
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(data.audioContent, 'base64');

    console.log(`[TTS] Generated ${audioBuffer.length} bytes of audio (LINEAR16, 8kHz)`);

    return audioBuffer;

  } catch (error) {
    console.error('[TTS] Error generating speech:', error);
    throw error;
  }
}

/**
 * Convert LINEAR16 PCM to mulaw (G.711 μ-law)
 * Telnyx may expect mulaw format for playback
 */
export function pcm16ToMulaw(pcm16Buffer: Buffer): Buffer {
  const MULAW_BIAS = 0x84;
  const MULAW_CLIP = 32635;

  const mulawBuffer = Buffer.alloc(pcm16Buffer.length / 2);

  for (let i = 0; i < pcm16Buffer.length; i += 2) {
    let sample = pcm16Buffer.readInt16LE(i);

    // Get sign
    const sign = sample < 0 ? 0x80 : 0x00;
    if (sign) {
      sample = -sample;
    }

    // Clip
    if (sample > MULAW_CLIP) {
      sample = MULAW_CLIP;
    }

    // Add bias
    sample += MULAW_BIAS;

    // Calculate exponent and mantissa
    let exponent = 7;
    for (let exp = 0; exp < 8; exp++) {
      if (sample <= (0xFF << exp)) {
        exponent = exp;
        break;
      }
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0F;

    // Encode
    let mulaw = sign | (exponent << 4) | mantissa;

    // Invert bits (mulaw standard)
    mulaw = ~mulaw;

    mulawBuffer[i / 2] = mulaw;
  }

  return mulawBuffer;
}

/**
 * Generate speech and convert to mulaw for Telnyx
 */
export async function generateCallSpeechMulaw(
  text: string,
  apiKey: string,
  romanianVoice?: string,
  englishVoice?: string,
): Promise<Buffer> {
  const pcm16 = await generateCallSpeech(text, apiKey, romanianVoice, englishVoice);
  return pcm16ToMulaw(pcm16);
}
