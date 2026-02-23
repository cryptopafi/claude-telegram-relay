/**
 * voice-tts-stream.ts
 * Streaming TTS helpers for browser voice sessions.
 *
 * Primary: ElevenLabs streaming PCM (if ELEVENLABS_API_KEY exists)
 * Fallback: Groq TTS WAV stream converted to PCM chunks
 */

export type TTSProvider = 'elevenlabs' | 'groq';

export interface TTSChunk {
  provider: TTSProvider;
  sampleRate: number;
  pcm16: Buffer;
}

export interface StreamTTSOptions {
  text: string;
  groqApiKey: string;
  elevenLabsApiKey?: string;
  elevenLabsVoiceId?: string;
  groqVoice?: string;
  signal?: AbortSignal;
  onChunk: (chunk: TTSChunk) => Promise<void> | void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('TTS stream aborted');
  }
}

function ensureText(text: string): string {
  const cleaned = text.trim();
  if (!cleaned) {
    throw new Error('TTS text is empty');
  }
  return cleaned;
}

export function findWavDataOffset(buffer: Buffer): number {
  if (buffer.length < 12) return -1;
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF') return -1;
  if (buffer.slice(8, 12).toString('ascii') !== 'WAVE') return -1;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const next = offset + 8 + chunkSize + (chunkSize % 2);

    if (chunkId === 'data') {
      if (offset + 8 <= buffer.length) return offset + 8;
      return -1;
    }

    if (next > buffer.length) return -1;
    offset = next;
  }

  return -1;
}

async function streamElevenLabsPcm(options: StreamTTSOptions): Promise<void> {
  const text = ensureText(options.text);
  const apiKey = options.elevenLabsApiKey;
  if (!apiKey) {
    throw new Error('ELEVENLABS_API_KEY missing');
  }

  const voiceId = options.elevenLabsVoiceId || process.env['ELEVENLABS_VOICE_ID'] || 'EXAVITQu4vr4xnSDxMaL';
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=1`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        model_id: process.env['ELEVENLABS_MODEL_ID'] || 'eleven_multilingual_v2',
        text,
      }),
      signal: options.signal,
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`ElevenLabs streaming TTS failed (${response.status}): ${errorText}`);
  }

  const body = response.body;
  if (!body) throw new Error('ElevenLabs response has no stream body');

  const reader = body.getReader();
  let pending = Buffer.alloc(0);

  while (true) {
    throwIfAborted(options.signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    let chunk = Buffer.concat([pending, Buffer.from(value)]);
    if (chunk.length % 2 !== 0) {
      pending = chunk.slice(-1);
      chunk = chunk.slice(0, -1);
    } else {
      pending = Buffer.alloc(0);
    }

    if (chunk.length > 0) {
      await options.onChunk({
        provider: 'elevenlabs',
        sampleRate: 24000,
        pcm16: chunk,
      });
    }
  }

  if (pending.length > 0) {
    await options.onChunk({
      provider: 'elevenlabs',
      sampleRate: 24000,
      pcm16: Buffer.from([pending[0], 0]),
    });
  }
}

async function streamGroqWavAsPcm(options: StreamTTSOptions): Promise<void> {
  const text = ensureText(options.text);
  const groqVoice = options.groqVoice || process.env['GROQ_TTS_VOICE'] || 'Aaliyah-PlayAI';

  const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${options.groqApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'playai-tts',
      voice: groqVoice,
      input: text,
      response_format: 'wav',
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Groq TTS failed (${response.status}): ${errorText}`);
  }

  const body = response.body;
  if (!body) {
    throw new Error('Groq TTS response has no stream body');
  }

  const reader = body.getReader();
  let pendingWav = Buffer.alloc(0);
  let wavDataStarted = false;
  let pendingPcm = Buffer.alloc(0);

  while (true) {
    throwIfAborted(options.signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.length === 0) continue;

    const incoming = Buffer.from(value);

    if (!wavDataStarted) {
      pendingWav = Buffer.concat([pendingWav, incoming]);
      const dataOffset = findWavDataOffset(pendingWav);
      if (dataOffset === -1) continue;
      const wavData = pendingWav.slice(dataOffset);
      pendingWav = Buffer.alloc(0);
      wavDataStarted = true;
      if (wavData.length > 0) {
        pendingPcm = Buffer.concat([pendingPcm, wavData]);
      }
    } else {
      pendingPcm = Buffer.concat([pendingPcm, incoming]);
    }

    if (pendingPcm.length >= 2048) {
      let chunk = pendingPcm;
      if (chunk.length % 2 !== 0) {
        chunk = chunk.slice(0, -1);
        pendingPcm = pendingPcm.slice(-1);
      } else {
        pendingPcm = Buffer.alloc(0);
      }

      if (chunk.length > 0) {
        await options.onChunk({
          provider: 'groq',
          sampleRate: 24000,
          pcm16: chunk,
        });
      }
    }
  }

  if (pendingPcm.length > 0) {
    let finalPcm = pendingPcm;
    if (finalPcm.length % 2 !== 0) {
      finalPcm = finalPcm.slice(0, -1);
    }
    if (finalPcm.length > 0) {
      await options.onChunk({
        provider: 'groq',
        sampleRate: 24000,
        pcm16: finalPcm,
      });
    }
  }
}

const TTS_TIMEOUT_MS = 30_000;

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`TTS timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    controller.abort(signal.reason);
  });
  return controller.signal;
}

export async function streamTTS(options: StreamTTSOptions): Promise<{ provider: TTSProvider; sampleRate: number }> {
  throwIfAborted(options.signal);

  const timedSignal = withTimeout(options.signal, TTS_TIMEOUT_MS);
  const optionsWithTimeout: StreamTTSOptions = { ...options, signal: timedSignal };

  if (options.elevenLabsApiKey) {
    try {
      await streamElevenLabsPcm(optionsWithTimeout);
      return { provider: 'elevenlabs', sampleRate: 24000 };
    } catch (err) {
      if (options.signal?.aborted) throw err;
      console.warn('[TTS] ElevenLabs failed, falling back to Groq:', err);
    }
  }

  await streamGroqWavAsPcm(optionsWithTimeout);
  return { provider: 'groq', sampleRate: 24000 };
}
