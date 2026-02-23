/**
 * voice-agent.ts
 * Main Telnyx Direct voice conversation agent
 * HTTP server + WebSocket handler for real-time voice calls
 */

import { serve } from 'bun';
import Groq from 'groq-sdk';
import { loadVoiceConfig, VOICE_SYSTEM_PROMPT, getAgentProfile, type VoiceConfig, type AgentProfile } from './voice-config';
import { VoiceSessionManager } from './voice-session';
import { handleEmergency } from './voice-emergency';
import { VoiceActivityDetector } from './voice-vad';
import { getCortexProcedures } from './cortex-client';
import { streamTTS } from './voice-tts-stream';

// Global config and managers
let config: VoiceConfig;
let sessionManager: VoiceSessionManager;
let groq: Groq;

// WebSocket connections per call
const webSocketConnections = new Map<string, WebSocket>();

// VAD instances per call
const vadInstances = new Map<string, VoiceActivityDetector>();

// Browser test sessions
interface BrowserTestSession {
  sessionId: string;
  agentId: string;
  agentProfile: AgentProfile;
  startTime: number;
  conversationHistory: Array<{role: 'user' | 'assistant', content: string, timestamp: number}>;
}

interface BrowserAudioState {
  currentStreamId: number;
  ttsAbortController: AbortController | null;
  llmAbortController: AbortController | null;
  ttsChain: Promise<void>;
}

const browserTestSessions = new Map<string, BrowserTestSession>();
const browserVadInstances = new Map<string, VoiceActivityDetector>();
const browserAudioBuffers = new Map<string, Buffer[]>();
const browserAudioStates = new Map<string, BrowserAudioState>();

// LLM Backend: 'groq' (fast, free) or 'claude' (higher quality, slower)
const VOICE_LLM_BACKEND = process.env.VOICE_LLM_BACKEND || 'groq';

// Rate limiting
let activeWsConnections = 0;
const MAX_CONCURRENT_WS = 3;
// BUG FIX #5: Per-session rate limiting (M-3 audit correction)
const MAX_STT_PER_SESSION_PER_MINUTE = 30;
const MAX_TTS_PER_SESSION_PER_MINUTE = 50;

interface RateLimitStats {
  sttCount: number;
  ttsCount: number;
  windowStart: number;
}
const sessionRateLimits = new Map<string, RateLimitStats>();

// Cleanup stale sessions (M-3 audit correction)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, stats] of sessionRateLimits.entries()) {
    if (now - stats.windowStart > 300000) {
      sessionRateLimits.delete(sessionId);
    } else if (now - stats.windowStart > 60000) {
      stats.sttCount = 0;
      stats.ttsCount = 0;
      stats.windowStart = now;
    }
  }
}, 60000);

function checkRateLimit(sessionId: string, type: 'stt' | 'tts'): boolean {
  const now = Date.now();
  let stats = sessionRateLimits.get(sessionId);
  if (!stats || now - stats.windowStart > 60000) {
    stats = { sttCount: 0, ttsCount: 0, windowStart: now };
    sessionRateLimits.set(sessionId, stats);
  }
  const maxCount = type === 'stt' ? MAX_STT_PER_SESSION_PER_MINUTE : MAX_TTS_PER_SESSION_PER_MINUTE;
  const currentCount = type === 'stt' ? stats.sttCount : stats.ttsCount;
  if (currentCount >= maxCount) return false;
  if (type === 'stt') stats.sttCount++;
  else stats.ttsCount++;
  return true;
}



/**
 * Initialize services
 */
function initializeServices() {
  config = loadVoiceConfig();
  sessionManager = new VoiceSessionManager();

  groq = new Groq({
    apiKey: config.apiKeys.groq,
  });

  console.log('[VOICE AGENT] Services initialized');
  console.log(`[VOICE AGENT] Phone number: ${config.telnyx.phoneNumber}`);
  console.log(`[VOICE AGENT] Allowed callers: ${config.security.allowedCallers.length > 0 ? config.security.allowedCallers.join(', ') : 'ALL'}`);
}

/**
 * Telnyx Call Control API wrapper
 */
/**
 * SECURITY FIX #4: Basic Auth helper with timing-safe comparison
 */
function checkBasicAuth(
  authHeader: string | null,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return false;
  }

  try {
    const base64Credentials = authHeader.slice(6);
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
    const [username, ...passwordParts] = credentials.split(':');
    const password = passwordParts.join(':');  // Handle passwords with colons

    // Timing-safe comparison
    const usernameBuffer = Buffer.from(username);
    const expectedUsernameBuffer = Buffer.from(expectedUsername);
    const passwordBuffer = Buffer.from(password);
    const expectedPasswordBuffer = Buffer.from(expectedPassword);

    const usernameMatch = usernameBuffer.length === expectedUsernameBuffer.length &&
      crypto.timingSafeEqual(usernameBuffer, expectedUsernameBuffer);
    const passwordMatch = passwordBuffer.length === expectedPasswordBuffer.length &&
      crypto.timingSafeEqual(passwordBuffer, expectedPasswordBuffer);

    return usernameMatch && passwordMatch;
  } catch (error) {
    return false;
  }
}

/**
 * SECURITY FIX #1: Telnyx webhook signature verification
 */
async function verifyTelnyxSignature(
  payload: string,
  timestamp: string,
  signature: string,
  publicKey: string,
): Promise<boolean> {
  try {
    const signedPayload = timestamp + '|' + payload;
    const encoder = new TextEncoder();
    const data = encoder.encode(signedPayload);
    const sigBytes = Buffer.from(signature, 'base64');
    const pubKeyBytes = Buffer.from(publicKey, 'base64');

    const key = await crypto.subtle.importKey(
      'raw',
      pubKeyBytes,
      { name: 'Ed25519', namedCurve: 'Ed25519' },
      false,
      ['verify']
    );

    return await crypto.subtle.verify('Ed25519', key, sigBytes, data);
  } catch (error) {
    console.error('[WEBHOOK] Signature verification error:', error);
    return false;
  }
}

/**
 * SECURITY FIX #6: Webhook payload validation
 */
function validateTelnyxWebhook(event: any): boolean {
  if (!event || typeof event !== 'object') return false;
  if (!event.data || typeof event.data !== 'object') return false;
  if (!event.data.event_type || typeof event.data.event_type !== 'string') return false;
  if (!event.data.payload || typeof event.data.payload !== 'object') return false;
  return true;
}

class TelnyxAPI {
  private apiKey: string;
  private baseUrl = 'https://api.telnyx.com/v2';

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request(method: string, path: string, body?: any) {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Telnyx API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  async answerCall(callControlId: string) {
    return this.request('POST', `/calls/${callControlId}/actions/answer`, {});
  }

  async startStreaming(callControlId: string, streamUrl: string) {
    return this.request('POST', `/calls/${callControlId}/actions/streaming_start`, {
      stream_url: streamUrl,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: 'PCMU',
    });
  }

  async playAudio(callControlId: string, audioUrl: string) {
    return this.request('POST', `/calls/${callControlId}/actions/playback_start`, {
      audio_url: audioUrl,
    });
  }

  async hangup(callControlId: string) {
    return this.request('POST', `/calls/${callControlId}/actions/hangup`, {});
  }

  async speak(callControlId: string, text: string, voice: string = 'female') {
    return this.request('POST', `/calls/${callControlId}/actions/speak`, {
      payload: text,
      voice,
      language: 'ro-RO',
    });
  }
}

const telnyxAPI = new TelnyxAPI(process.env.TELNYX_API_KEY || '');

/**
 * Create a valid WAV file buffer from raw PCM16 data
 * Groq Whisper requires proper WAV headers, not just raw PCM
 */
function createWavBuffer(pcm16: Buffer, sampleRate: number = 8000, channels: number = 1, bitsPerSample: number = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcm16.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);

  // fmt sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);         // sub-chunk size
  header.writeUInt16LE(1, 20);          // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm16]);
}

/**
 * Transcribe audio using Groq Whisper
 */
async function transcribeAudio(audioBuffer: Buffer, sessionId: string): Promise<string> {
  if (!checkRateLimit(sessionId, 'stt')) {
    console.warn('[RATE LIMIT] STT requests exceeded, skipping');
    return '';
  }
  // Rate incremented in checkRateLimit
  try {
    // Wrap raw PCM16 in proper WAV container (Groq requires valid WAV headers)
    const wavBuffer = createWavBuffer(audioBuffer, 8000, 1, 16);
    const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      language: 'ro', // Romanian primary, but will auto-detect
      response_format: 'json',
    });

    return transcription.text || '';
  } catch (error) {
    console.error('[TRANSCRIBE] Error:', error);
    return '';
  }
}

/**
 * Get Claude response with Cortex context
 */
async function getClaudeResponse(
  callControlId: string,
  userMessage: string,
): Promise<string> {
  sessionManager.addMessage(callControlId, 'user', userMessage);

  let cortexContext = '';
  try {
    const cortexText = await getCortexProcedures(userMessage);
    if (cortexText) {
      cortexContext = '\n\nContext:\n' + cortexText;
    }
  } catch (error) {
    console.error('[CORTEX] Search error:', error);
  }

  const conversationHistory = sessionManager.getConversationHistory(callControlId);
  const history = conversationHistory
    .slice(-10)
    .map((m: any) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n');

  const prompt = `${VOICE_SYSTEM_PROMPT}${cortexContext}\n\nConversation:\n${history}\n\nIMPORTANT: Raspunde DOAR in limba romana. Maxim 1-3 propozitii, pentru conversatie vocala.`;

  try {
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const proc = Bun.spawn([claudePath, '--model', 'haiku', '-p', prompt, '--output-format', 'text'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      return 'Scuze, am o problemă tehnică.';
    }

    const response = output.trim();
    sessionManager.addMessage(callControlId, 'assistant', response);
    return response;
  } catch (error) {
    console.error('[CLAUDE CLI] Error:', error);
    return 'Scuze, nu pot răspunde momentan.';
  }
}


/**
 * Downsample 16kHz PCM16 to 8kHz for VAD
 */
function downsample16to8(pcm16_16k: Buffer): Buffer {
  const inputLength = pcm16_16k.length / 2;
  const outputLength = Math.floor(inputLength / 2);
  const output = Buffer.alloc(outputLength * 2);
  for (let i = 0; i < outputLength; i++) {
    const sample = pcm16_16k.readInt16LE(i * 4);
    output.writeInt16LE(sample, i * 2);
  }
  return output;
}

/**
 * Transcribe browser audio (16kHz)
 */
async function transcribeAudioBrowser(audioBuffer: Buffer, sessionId: string): Promise<string> {
  if (!checkRateLimit(sessionId, 'stt')) {
    console.warn('[RATE LIMIT] STT requests exceeded, skipping');
    return '';
  }
  // Rate incremented in checkRateLimit
  try {
    const wavBuffer = createWavBuffer(audioBuffer, 16000, 1, 16);
    const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });
    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-large-v3-turbo',
      language: 'ro',
      response_format: 'json',
    });
    return transcription.text || '';
  } catch (error) {
    console.error('[TRANSCRIBE BROWSER] Error:', error);
    return '';
  }
}

/**
 * Get LLM response via Groq (fast, sub-second)
 */
async function getGroqLLMResponse(systemPrompt: string, messages: Array<{role: string, content: string}>): Promise<string> {
  try {
    const groqMessages = [
      { role: 'system' as const, content: systemPrompt },
      ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: groqMessages,
      max_tokens: 200,
      temperature: 0.7,
    });

    return completion.choices[0]?.message?.content || 'Nu am putut genera un raspuns.';
  } catch (error) {
    console.error('[GROQ LLM] Error:', error);
    return '';
  }
}

/**
 * Get Claude response via CLI (backup, higher quality)
 */
async function getClaudeCLIResponse(prompt: string): Promise<string> {
  try {
    const claudePath = process.env.CLAUDE_PATH || 'claude';
    const proc = Bun.spawn([claudePath, '--model', 'haiku', '-p', prompt, '--output-format', 'text'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });

    // BUG FIX #2: Add 10s timeout
    const timeoutMs = 10000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Claude CLI timeout')), timeoutMs);
    });

    let output: string;
    let exitCode: number;
    try {
      output = await Promise.race([new Response(proc.stdout).text(), timeoutPromise]);
      exitCode = await proc.exited;
    } catch (timeoutError) {
      console.error('[CLAUDE CLI] Timeout after 10s, killing process');
      proc.kill();
      await Promise.race([proc.exited, new Promise(r => setTimeout(r, 2000))]);
      return 'Scuze, răspunsul durează prea mult. Încearcă din nou.';
    }

    if (exitCode !== 0) {
      return '';
    }
    return output.trim();
  } catch (error) {
    console.error('[CLAUDE CLI] Error:', error);
    return '';
  }
}

function splitCompleteSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let start = 0;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    const isBoundary = ch === '.' || ch === '!' || ch === '?' || ch === '\n';
    if (!isBoundary) continue;

    const next = buffer[i + 1] ?? '';
    if (ch === '\n' || next === '' || /\s/.test(next)) {
      const sentence = buffer.slice(start, i + 1).replace(/\s+/g, ' ').trim();
      if (sentence) complete.push(sentence);
      start = i + 1;
    }
  }

  return { complete, rest: buffer.slice(start) };
}

async function streamGroqLLMSentences(
  systemPrompt: string,
  messages: Array<{role: string, content: string}>,
  onSentence: (sentence: string) => Promise<void>,
  signal?: AbortSignal
): Promise<string> {
  const groqMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
  ];

  const stream = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: groqMessages,
    max_tokens: 200,
    temperature: 0.7,
    stream: true,
    // Groq SDK accepts fetch options internally; keep optional for cancellation.
    ...(signal ? { signal } : {}),
  } as any);

  let fullText = '';
  let sentenceBuffer = '';

  for await (const chunk of stream as any) {
    if (signal?.aborted) {
      throw new Error('LLM stream aborted');
    }

    const delta = chunk?.choices?.[0]?.delta?.content ?? '';
    if (!delta) continue;

    fullText += delta;
    sentenceBuffer += delta;

    const split = splitCompleteSentences(sentenceBuffer);
    sentenceBuffer = split.rest;
    for (const sentence of split.complete) {
      await onSentence(sentence);
    }
  }

  const tail = sentenceBuffer.replace(/\s+/g, ' ').trim();
  if (tail) {
    await onSentence(tail);
  }

  return fullText.replace(/\s+/g, ' ').trim();
}

function getBrowserAudioState(sessionId: string): BrowserAudioState {
  let state = browserAudioStates.get(sessionId);
  if (!state) {
    state = {
      currentStreamId: 0,
      ttsAbortController: null,
      llmAbortController: null,
      ttsChain: Promise.resolve(),
    };
    browserAudioStates.set(sessionId, state);
  }
  return state;
}

function stopBrowserAudioStream(sessionId: string, ws?: any, reason: string = 'interrupted') {
  const state = getBrowserAudioState(sessionId);
  state.currentStreamId++;

  if (state.llmAbortController) {
    state.llmAbortController.abort();
    state.llmAbortController = null;
  }
  if (state.ttsAbortController) {
    state.ttsAbortController.abort();
    state.ttsAbortController = null;
  }

  if (ws && (ws as any).readyState === 1) {
    ws.send(JSON.stringify({ type: 'audio_stop', reason }));
    ws.send(JSON.stringify({ type: 'status', status: 'listening', text: 'Ascult...' }));
  }
}

async function streamSentenceToBrowser(
  ws: any,
  sessionId: string,
  sentence: string,
): Promise<void> {
  const cleaned = sentence.replace(/\s+/g, ' ').trim();
  if (!cleaned) return;
  if (!checkRateLimit(sessionId, 'tts')) {
    throw new Error('TTS rate limit exceeded');
  }

  const state = getBrowserAudioState(sessionId);
  const streamId = state.currentStreamId;
  const abortController = new AbortController();
  state.ttsAbortController = abortController;

  if ((ws as any).readyState === 1) {
    ws.send(JSON.stringify({ type: 'status', status: 'speaking', text: 'Genie vorbeste...' }));
    ws.send(JSON.stringify({ type: 'audio_stream_start', streamId, sampleRate: 24000 }));
  }

  try {
    const streamInfo = await streamTTS({
      text: cleaned,
      groqApiKey: config.apiKeys.groq,
      elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
      signal: abortController.signal,
      onChunk: async (chunk) => {
        if (state.currentStreamId !== streamId || abortController.signal.aborted) return;
        if ((ws as any).readyState !== 1) return;
        ws.send(JSON.stringify({
          type: 'audio_chunk',
          streamId,
          provider: chunk.provider,
          sampleRate: chunk.sampleRate,
          data: chunk.pcm16.toString('base64'),
        }));
      },
    });

    if (state.currentStreamId === streamId && (ws as any).readyState === 1) {
      ws.send(JSON.stringify({ type: 'audio_stream_end', streamId, sampleRate: streamInfo.sampleRate }));
    }
  } finally {
    if (state.ttsAbortController === abortController) {
      state.ttsAbortController = null;
    }
  }
}

async function getClaudeResponseBrowser(sessionId: string, userMessage: string, ws: any): Promise<string> {
  const session = browserTestSessions.get(sessionId);
  if (!session) return 'Sesiune invalida';

  session.conversationHistory.push({ role: 'user', content: userMessage, timestamp: Date.now() });

  let cortexContext = '';
  try {
    const cortexText = await getCortexProcedures(userMessage);
    if (cortexText) {
      cortexContext = '\n\nContext:\n' + cortexText;
    }
  } catch (error) {
    console.error('[CORTEX] Error:', error);
  }

  const systemPrompt = session.agentProfile.systemPrompt + cortexContext + '\n\nIMPORTANT: Raspunde DOAR in limba romana. Maxim 1-3 propozitii, pentru conversatie vocala.';
  const historyMessages = session.conversationHistory.slice(-10).map(m => ({ role: m.role, content: m.content }));
  const state = getBrowserAudioState(sessionId);
  const responseSegments: string[] = [];

  const queueSentence = (sentence: string) => {
    const cleaned = sentence.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    responseSegments.push(cleaned);
    state.ttsChain = state.ttsChain
      .then(() => streamSentenceToBrowser(ws, sessionId, cleaned))
      .catch((err) => {
        console.error('[BROWSER TEST] Sentence TTS error:', err);
      });
  };

  if (VOICE_LLM_BACKEND === 'groq') {
    state.llmAbortController = new AbortController();
    try {
      await streamGroqLLMSentences(
        systemPrompt,
        historyMessages,
        async (sentence) => {
          queueSentence(sentence);
        },
        state.llmAbortController.signal
      );
    } catch (error) {
      if (!state.llmAbortController.signal.aborted) {
        console.error('[VOICE] Groq stream failed, fallback to Claude CLI:', error);
      }
    } finally {
      state.llmAbortController = null;
    }
  }

  if (responseSegments.length === 0) {
    const history = session.conversationHistory
      .slice(-10)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const cliPrompt = `${systemPrompt}\n\nConversation:\n${history}`;
    const fallback = await getClaudeCLIResponse(cliPrompt);
    if (fallback) {
      queueSentence(fallback);
    }
  }

  await state.ttsChain;

  const response = responseSegments.join(' ').replace(/\s+/g, ' ').trim() || 'Scuze, am o problemă tehnică momentan.';
  session.conversationHistory.push({ role: 'assistant', content: response, timestamp: Date.now() });
  return response;
}

/**
 * Handle browser test WebSocket
 */
function handleBrowserTestOpen(ws: any, sessionId: string, agentId: string = 'genie') {
  const agentProfile = getAgentProfile(agentId);
  console.log(`[BROWSER TEST] Connected: ${sessionId} | Agent: ${agentProfile.name} (${agentProfile.role})`);

  browserTestSessions.set(sessionId, { sessionId, agentId, agentProfile, startTime: Date.now(), conversationHistory: [] });
  browserVadInstances.set(sessionId, new VoiceActivityDetector({
    energyThreshold: config.vad.energyThreshold,
    silenceDurationMs: config.vad.silenceDurationMs,
    minSpeechDurationMs: config.vad.minSpeechDurationMs,
    sampleRate: 8000,
  }));
  browserAudioBuffers.set(sessionId, []);
  browserAudioStates.set(sessionId, {
    currentStreamId: 0,
    ttsAbortController: null,
    llmAbortController: null,
    ttsChain: Promise.resolve(),
  });

  ws.send(JSON.stringify({ type: 'status', status: 'connected', text: 'Conectat' }));
}

async function handleBrowserTestMessage(ws: any, sessionId: string, rawMessage: string | Buffer) {
  try {
    const msgStr = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
    const message = JSON.parse(msgStr);

    if (message.type === 'barge_in') {
      console.log(`[BROWSER TEST] Barge-in: ${sessionId}`);
      stopBrowserAudioStream(sessionId, ws, 'barge_in');
      return;
    }

    if (message.type !== 'audio') return;

    const vad = browserVadInstances.get(sessionId);
    const audioBuffer16k = browserAudioBuffers.get(sessionId);
    if (!vad || !audioBuffer16k) return;

    const pcm16_16k = Buffer.from(message.data, 'base64');
    audioBuffer16k.push(pcm16_16k);

    const pcm16_8k = downsample16to8(pcm16_16k);
    const vadResult = vad.process(pcm16_8k);

    if (vadResult.event === 'speech_start') {
      ws.send(JSON.stringify({ type: 'status', status: 'listening', text: 'Ascult...' }));
      browserAudioBuffers.set(sessionId, [pcm16_16k]);
    }

    if (vadResult.event === 'speech_end' && audioBuffer16k.length > 0) {
      console.log(`[BROWSER TEST] Speech ended`);
      ws.send(JSON.stringify({ type: 'status', status: 'thinking', text: 'Procesez...' }));

      const fullAudio = Buffer.concat(audioBuffer16k);
      const transcription = await transcribeAudioBrowser(fullAudio, sessionId);

      if (transcription) {
        console.log(`[BROWSER TEST] "${transcription}"`);
        ws.send(JSON.stringify({ type: 'transcript', role: 'user', text: transcription }));

        const response = await getClaudeResponseBrowser(sessionId, transcription, ws);
        console.log(`[BROWSER TEST] "${response}"`);
        ws.send(JSON.stringify({ type: 'transcript', role: 'assistant', text: response }));
        ws.send(JSON.stringify({ type: 'status', status: 'listening', text: 'Ascult...' }));
      }
      browserAudioBuffers.set(sessionId, []);
    }
  } catch (error) {
    console.error('[BROWSER TEST] Error:', error);
    ws.send(JSON.stringify({ type: 'status', status: 'error', text: 'Eroare' }));
  }
}

function handleBrowserTestClose(sessionId: string) {
  console.log(`[BROWSER TEST] Closed: ${sessionId}`);
  stopBrowserAudioStream(sessionId, undefined, 'session_closed');
  browserTestSessions.delete(sessionId);
  browserVadInstances.delete(sessionId);
  browserAudioBuffers.delete(sessionId);
  browserAudioStates.delete(sessionId);
}


/**
 * Handle Telnyx webhook events
 */
async function handleTelnyxWebhook(event: any): Promise<Response> {
  const eventType = event.data?.event_type;
  const payload = event.data?.payload;

  console.log(`[WEBHOOK] Event: ${eventType}`, {
    callControlId: payload?.call_control_id,
    from: payload?.from,
    to: payload?.to,
  });

  switch (eventType) {
    case 'call.initiated': {
      const callControlId = payload.call_control_id;
      const from = payload.from;
      const to = payload.to;

      console.log(`[CALL] Incoming call from ${from} to ${to}`);

      // Check if caller is allowed
      if (!sessionManager.isCallerAllowed(from, config.security.allowedCallers)) {
        console.log(`[CALL] Rejected: ${from} not in allowlist`);
        await telnyxAPI.hangup(callControlId);
        return Response.json({ status: 'rejected', reason: 'not_allowed' });
      }

      // Check daily limit
      if (sessionManager.hasExceededDailyLimit(from, config.limits.maxDailyCallsPerNumber)) {
        console.log(`[CALL] Rejected: ${from} exceeded daily limit`);
        await telnyxAPI.hangup(callControlId);
        return Response.json({ status: 'rejected', reason: 'daily_limit' });
      }

      // Answer the call
      await telnyxAPI.answerCall(callControlId);

      // Create session
      sessionManager.createSession(callControlId, from);

      // Create VAD instance
      vadInstances.set(callControlId, new VoiceActivityDetector({
        energyThreshold: config.vad.energyThreshold,
        silenceDurationMs: config.vad.silenceDurationMs,
        minSpeechDurationMs: config.vad.minSpeechDurationMs,
        sampleRate: config.voice.sampleRate,
      }));

      console.log(`[CALL] Answered call ${callControlId} from ${from}`);

      return Response.json({ status: 'answered' });
    }

    case 'call.answered': {
      const callControlId = payload.call_control_id;

      // Speak greeting
      await telnyxAPI.speak(
        callControlId,
        `Bună ziua, sunt ${config.identity.agentName}, asistentul lui ${config.identity.ownerName}. Cu ce vă pot ajuta?`,
      );

      console.log(`[CALL] Greeted caller on ${callControlId}`);

      return Response.json({ status: 'greeted' });
    }

    case 'call.hangup': {
      const callControlId = payload.call_control_id;

      // Clean up session
      const session = sessionManager.endSession(callControlId);
      vadInstances.delete(callControlId);
      webSocketConnections.delete(callControlId);

      console.log(`[CALL] Call ended: ${callControlId}`, {
        duration: session?.callDurationMs ? `${Math.round(session.callDurationMs / 1000)}s` : 'unknown',
      });

      return Response.json({ status: 'ended' });
    }

    default:
      console.log(`[WEBHOOK] Unhandled event type: ${eventType}`);
      return Response.json({ status: 'ok' });
  }
}

/**
 * Handle WebSocket media stream from Telnyx
 */
function handleTelnyxWsOpen(ws: any, callControlId: string) {
  console.log(`[WEBSOCKET] Connected for call ${callControlId}`);
  webSocketConnections.set(callControlId, ws);

  const vad = vadInstances.get(callControlId);
  if (!vad) {
    console.error(`[WEBSOCKET] No VAD instance for call ${callControlId}`);
    ws.close();
  }
}

async function handleTelnyxWsMessage(ws: any, callControlId: string, rawMessage: string | Buffer) {
  try {
    const msgStr = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
    const message = JSON.parse(msgStr);

    if (message.type !== 'media' || !message.media) return;

    const vad = vadInstances.get(callControlId);
    if (!vad) return;

    const audioPayload = message.media.payload;
    const pcm16Audio = VoiceActivityDetector.base64MulawToPCM16(audioPayload);
    const vadResult = vad.process(pcm16Audio);

    if (vadResult.event === 'speech_end' && vadResult.audioBuffer) {
      console.log(`[VAD] Speech ended, transcribing...`);

      const transcription = await transcribeAudio(vadResult.audioBuffer, callControlId);

      if (transcription) {
        console.log(`[TRANSCRIBE] "${transcription}"`);

        const session = sessionManager.getSession(callControlId);
        if (!session) return;

        const emergencyResponse = await handleEmergency(transcription, {
          telegramBotToken: config.telegram.botToken,
          telegramChatId: config.telegram.pafiChatId,
          cortexUrl: config.cortex.url,
          phoneNumber: session.phoneNumber,
        });

        let responseText: string;

        if (emergencyResponse) {
          responseText = emergencyResponse;
        } else {
          responseText = await getClaudeResponse(callControlId, transcription);
        }

        console.log(`[CLAUDE] "${responseText}"`);

        await telnyxAPI.speak(callControlId, responseText);
      }
    }
  } catch (error) {
    console.error('[WEBSOCKET] Error processing message:', error);
  }
}

function handleTelnyxWsClose(callControlId: string) {
  console.log(`[WEBSOCKET] Disconnected for call ${callControlId}`);
  webSocketConnections.delete(callControlId);
}

/**
 * HTTP server
 */
function startServer() {
  const server = serve({
    port: config.server.port,
    hostname: config.server.host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // Health check
      if (url.pathname === '/voice/health' && req.method === 'GET') {
        return Response.json({
          status: 'healthy',
          activeCalls: sessionManager.getActiveSessions().length,
          uptime: process.uptime(),
        });
      }

      // Claude Voice — personal voice app
      if (url.pathname === '/voice/claude' && req.method === 'GET') {
        const authHeader = req.headers.get('authorization');
        if (!checkBasicAuth(authHeader, config.basicAuth.username, config.basicAuth.password)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Voice System"' },
          });
        }

        try {
          let html = await Bun.file('./public/claude-voice.html').text();
          html = html.replace('__VOICE_WS_AUTH_KEY__', config.wsAuthKey);
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        } catch (error) {
          return new Response('Not found', { status: 404 });
        }
      }

      // OpenClaw Voice — team voice panel
      if ((url.pathname === '/voice/openclaw' || url.pathname === '/voice/team' || url.pathname === '/voice/test-client') && req.method === 'GET') {
        const authHeader = req.headers.get('authorization');
        if (!checkBasicAuth(authHeader, config.basicAuth.username, config.basicAuth.password)) {
          return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Basic realm="Voice System"' },
          });
        }

        try {
          let html = await Bun.file('./public/openclaw-voice.html').text();
          html = html.replace('__VOICE_WS_AUTH_KEY__', config.wsAuthKey);
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        } catch (error) {
          return new Response('Not found', { status: 404 });
        }
      }

      // Browser test WebSocket
      if (url.pathname === '/voice/test' && req.headers.get('upgrade') === 'websocket') {
        const authKey = url.searchParams.get('key');
        if (authKey !== config.wsAuthKey) {
          return new Response('Unauthorized', { status: 401 });
        }
        const agentId = url.searchParams.get('agent') || 'genie';
        const sessionId = `test-${Date.now()}-${crypto.randomUUID().split('-')[0]}`;
        const success = server.upgrade(req, { data: { sessionId, agentId, isBrowserTest: true } });
        if (success) return undefined;
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Telnyx webhook
      if (url.pathname === '/voice/webhook' && req.method === 'POST') {
        // SECURITY FIX #1: Webhook signature verification
        const signature = req.headers.get('telnyx-signature-ed25519');
        const timestamp = req.headers.get('telnyx-timestamp');

        if (!signature || !timestamp) {
          console.warn('[WEBHOOK] Missing signature headers');
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Replay attack prevention: reject if timestamp is more than 5 minutes old
        const timestampAge = Math.abs(Date.now() / 1000 - parseInt(timestamp));
        if (timestampAge > 300) {
          console.warn('[WEBHOOK] Stale timestamp, possible replay attack');
          return Response.json({ error: 'Stale request' }, { status: 403 });
        }

        try {
          const bodyText = await req.text();
          const body = JSON.parse(bodyText);

          // SECURITY FIX #6: Validate payload structure
          if (!validateTelnyxWebhook(body)) {
            console.warn('[WEBHOOK] Invalid payload structure:', JSON.stringify(body).substring(0, 200));
            return Response.json({ error: 'Invalid payload' }, { status: 400 });
          }

          if (config.telnyx.publicKey && !await verifyTelnyxSignature(bodyText, timestamp, signature, config.telnyx.publicKey)) {
            console.warn('[WEBHOOK] Invalid signature');
            return Response.json({ error: 'Invalid signature' }, { status: 403 });
          }

          return await handleTelnyxWebhook(body);
        } catch (error) {
          console.error('[WEBHOOK] Error:', error);
          return Response.json({ error: 'Internal server error' }, { status: 500 });
        }
      }

      // WebSocket upgrade for media streaming
      if (url.pathname === '/voice/stream' && req.headers.get('upgrade') === 'websocket') {
        const callControlId = url.searchParams.get('call_id');

        if (!callControlId) {
          return new Response('Missing call_id parameter', { status: 400 });
        }

        // SECURITY FIX #2: Verify call_id belongs to an active session
        const session = sessionManager.getSession(callControlId);
        if (!session) {
          console.warn(`[WEBSOCKET] Rejected: call_id ${callControlId} not in active sessions`);
          return new Response('Invalid call_id', { status: 403 });
        }

        // Replace old connection instead of rejecting (Telnyx may reconnect)
        if (webSocketConnections.has(callControlId)) {
          console.warn(`[WEBSOCKET] Replacing existing WebSocket for call_id ${callControlId}`);
          const oldWs = webSocketConnections.get(callControlId);
          try { oldWs?.close(1000, 'Replaced by new connection'); } catch {}
          webSocketConnections.delete(callControlId);
        }

        const success = server.upgrade(req, {
          data: { callControlId },
        });

        if (success) {
          return undefined;
        }
        return new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Serve PWA assets (manifest, service worker, icons)
      if (url.pathname === '/manifest.json' || url.pathname === '/manifest-genie.json' || url.pathname === '/manifest-team.json') {
        try {
          const file = await Bun.file('./public' + url.pathname).text();
          return new Response(file, { headers: { 'Content-Type': 'application/manifest+json' } });
        } catch { return new Response('Not Found', { status: 404 }); }
      }

      if (url.pathname === '/sw.js') {
        try {
          const file = await Bun.file('./public/sw.js').text();
          return new Response(file, { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/voice/' } });
        } catch { return new Response('Not Found', { status: 404 }); }
      }

      if (url.pathname.startsWith('/icons/')) {
        try {
          const filePath = './public' + url.pathname;
          const file = Bun.file(filePath);
          if (await file.exists()) {
            return new Response(file, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
          }
        } catch {}
        return new Response('Not Found', { status: 404 });
      }

      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      open(ws) {
        activeWsConnections++;
        if (activeWsConnections > MAX_CONCURRENT_WS) {
          console.warn(`[RATE LIMIT] Max ${MAX_CONCURRENT_WS} concurrent connections, rejecting`);
          ws.close(1013, 'Too many connections');
          activeWsConnections--;
          return;
        }
        const data = (ws as any).data as any;
        if (data.isBrowserTest) {
          handleBrowserTestOpen(ws as any, data.sessionId, data.agentId || 'genie');
        } else {
          handleTelnyxWsOpen(ws as any, data.callControlId);
        }
      },

      message(ws, message) {
        const data = (ws as any).data as any;
        if (data.isBrowserTest) {
          handleBrowserTestMessage(ws as any, data.sessionId, message as any);
        } else {
          handleTelnyxWsMessage(ws as any, data.callControlId, message as any);
        }
      },

      close(ws) {
        activeWsConnections--;
        const data = (ws as any).data as any;
        if (data.isBrowserTest) {
          handleBrowserTestClose(data.sessionId);
        } else {
          handleTelnyxWsClose(data.callControlId);
        }
      },
    },
  });

  console.log(`[SERVER] Voice agent listening on ${config.server.host}:${config.server.port}`);
  console.log(`[SERVER] Webhook URL: http://<your-vps-ip>:${config.server.port}/voice/webhook`);
  console.log(`[SERVER] WebSocket URL: ws://<your-vps-ip>:${config.server.port}/voice/stream?call_id=<call_id>`);
}

/**
 * Cleanup task - run every 5 minutes
 */
setInterval(() => {
  const cleaned = sessionManager.cleanupStaleSessions();
  if (cleaned > 0) {
    console.log(`[CLEANUP] Removed ${cleaned} stale sessions`);
  }
}, 5 * 60 * 1000);

/**
 * Main entry point
 */
function main() {
  try {
    initializeServices();

    console.log('='.repeat(60));
    console.log(`🎙️  ${config.identity.agentName.toUpperCase()} VOICE AGENT - Telnyx Direct`);
    console.log('='.repeat(60));

    startServer();

    console.log('\n✅ Voice agent ready to receive calls\n');
  } catch (error) {
    console.error('❌ Failed to start voice agent:', error);
    process.exit(1);
  }
}

// Start the server
main();
