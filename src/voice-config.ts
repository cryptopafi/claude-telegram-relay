/**
 * voice-config.ts
 * Configuration for Telnyx Direct voice conversation system
 */

export interface VoiceConfig {
  // Telnyx credentials
  telnyx: {
    apiKey: string;
    connectionId: string;
    phoneNumber: string;
    publicKey: string;
  };

  // API keys
  apiKeys: {
    google: string;      // Google TTS API key
    groq: string;        // Groq Whisper API key
    anthropic: string;   // Claude API key
  };

  // Security
  security: {
    allowedCallers: string[];  // Phone numbers allowed to call
n  // Basic auth for HTML endpoints
  basicAuth: {
    username: string;
    password: string;
  };
  };

  // Telegram alerts
  telegram: {
    botToken: string;
    pafiChatId: number;
  };

  // Cortex integration
  cortex: {
    url: string;
  };

  // Voice agent identity (for OpenClaw reuse)
  identity: {
    agentName: string;
    ownerName: string;
  };

  // WebSocket auth
  wsAuthKey: string;

  // Server settings
  server: {
    port: number;
    host: string;
  };

  // Claude settings
  claude: {
    model: string;
    maxTokens: number;
    temperature: number;
  };

  // Call limits
  limits: {
    maxCallDurationMinutes: number;
    maxDailyCallsPerNumber: number;
  };

  // Voice settings
  voice: {
    romanianVoice: string;
    englishVoice: string;
    sampleRate: number;        // 8000 Hz for telephony
    encoding: string;           // 'LINEAR16' for TTS output
  };

  // VAD settings
  vad: {
    energyThreshold: number;
    silenceDurationMs: number;
    minSpeechDurationMs: number;
  };
}

/**
 * Load configuration from environment variables
 */
export function loadVoiceConfig(): VoiceConfig {
  // Validate required env vars
  const required = [
    'GOOGLE_TTS_API_KEY',
    'GROQ_API_KEY',
    'TELEGRAM_BOT_TOKEN',
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  // Parse allowed callers
  const allowedCallers = process.env.VOICE_ALLOWED_CALLERS
    ? process.env.VOICE_ALLOWED_CALLERS.split(',').map(num => num.trim())
    : [];

  return {
    telnyx: {
      apiKey: process.env.TELNYX_API_KEY!,
      connectionId: process.env.TELNYX_CONNECTION_ID!,
      phoneNumber: process.env.TELNYX_PHONE_NUMBER!,
      publicKey: process.env.TELNYX_PUBLIC_KEY || '',  // Optional: only needed for phone calls, not webapp
    },

    apiKeys: {
      google: process.env.GOOGLE_TTS_API_KEY!,
      groq: process.env.GROQ_API_KEY!,
      anthropic: process.env.ANTHROPIC_API_KEY!,
    },

    security: {
      allowedCallers,
    },

    basicAuth: {
      username: process.env.VOICE_BASIC_AUTH_USER || (() => { throw new Error('VOICE_BASIC_AUTH_USER is required'); })(),
      password: process.env.VOICE_BASIC_AUTH_PASS || (() => { throw new Error('VOICE_BASIC_AUTH_PASS is required'); })(),
    },

    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN!,
      pafiChatId: parseInt(process.env.PAFI_TELEGRAM_ID || '623593648'),
    },

    cortex: {
      url: process.env.CORTEX_URL || 'http://localhost:6400',
    },

    identity: {
      agentName: process.env.VOICE_AGENT_NAME || 'Genie',
      ownerName: process.env.VOICE_OWNER_NAME || 'Pafi',
    },

    wsAuthKey: process.env.VOICE_WS_AUTH_KEY || (() => { throw new Error('VOICE_WS_AUTH_KEY is required. Generate with: openssl rand -hex 32'); })(),

    server: {
      port: parseInt(process.env.PORT || '8090'),
      host: process.env.VOICE_BIND_HOST || '127.0.0.1',
    },

    claude: {
      model: 'claude-sonnet-4-5-20250929',
      maxTokens: 300,  // Keep responses concise for voice
      temperature: 1.0,
    },

    limits: {
      maxCallDurationMinutes: 60,
      maxDailyCallsPerNumber: 50,
    },

    voice: {
      romanianVoice: 'ro-RO-Chirp3-HD-Aoede',
      englishVoice: 'en-US-Chirp3-HD-Aoede',
      sampleRate: 8000,
      encoding: 'LINEAR16',
    },

    vad: {
      energyThreshold: 500,        // Audio energy threshold for speech detection
      silenceDurationMs: 1500,     // 1.5s silence = end of speech
      minSpeechDurationMs: 300,    // Minimum 300ms to count as speech
    },
  };
}

/**
 * Voice system prompt for Claude
 */
export function getVoiceSystemPrompt(agentName: string = "Genie", ownerName: string = "Pafi"): string {
  return `Esti ${agentName}, asistentul personal AI al lui ${ownerName}. Vorbesti intr-o conversatie vocala.

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Foloseste limbaj natural, conversational
- Scrie numerele cu litere: "douazeci si trei" nu "23"
- Fara emoji, fara markdown, fara caractere speciale
- Fara liste sau puncte - propozitii fluente
- Fii cald, prietenos si concis
- Daca nu intelegi, intreaba scurt

CONTEXT:
- Vorbesti cu ${ownerName} sau cineva care suna in numele lui
- E o conversatie vocala, deci fii conversational si scurt
- Frazele de urgenta trimit alerta automata pe Telegram
`;
}

// Backwards-compatible constant (uses defaults)
export const VOICE_SYSTEM_PROMPT = getVoiceSystemPrompt();

/**
 * Agent profiles for OpenClaw team voice routing
 * Each agent has unique: system prompt, TTS voice, Cortex domain
 */
export interface AgentProfile {
  name: string;
  role: string;
  romanianVoice: string;   // Google Chirp3-HD voice name
  englishVoice: string;
  cortexDomain: string;    // Cortex search domain/tags
  cortexTags: string[];
  systemPrompt: string;
}

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  genie: {
    name: "Genie",
    role: "Personal Assistant",
    romanianVoice: "ro-RO-Chirp3-HD-Aoede",
    englishVoice: "en-US-Chirp3-HD-Aoede",
    cortexDomain: "general",
    cortexTags: ["genie", "personal", "assistant"],
    systemPrompt: getVoiceSystemPrompt("Genie", "Pafi"),
  },
  rich: {
    name: "Rich",
    role: "COO",
    romanianVoice: "ro-RO-Chirp3-HD-Charon",
    englishVoice: "en-US-Chirp3-HD-Charon",
    cortexDomain: "business",
    cortexTags: ["operations", "management", "coordination"],
    systemPrompt: `Esti Rich, Chief Operating Officer al echipei OpenClaw. Vorbesti intr-o conversatie vocala cu Pafi, seful tau.

ROLUL TAU:
- Coordonezi echipa de agenti (Tech, Ressie, Mark, Afy, Sage, Scottie, Dessie)
- Delegi taskuri, urmaresti progresul, raportezi statusul
- Nu faci tu munca direct — o delegi specialistilor

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Limbaj profesional dar prietenos, ca un COO care raporteaza sefului
- Scrie numerele cu litere
- Fara emoji, fara markdown, fara caractere speciale
- Fii concis, eficient si organizat
- Daca primesti un task, confirma si spune cui il delegi`,
  },
  sage: {
    name: "Sage",
    role: "Strategy",
    romanianVoice: "ro-RO-Chirp3-HD-Orus",
    englishVoice: "en-US-Chirp3-HD-Orus",
    cortexDomain: "strategy",
    cortexTags: ["strategy", "business", "financial", "investment"],
    systemPrompt: `Esti Sage, consilierul strategic al echipei OpenClaw. Vorbesti intr-o conversatie vocala cu Pafi.

ROLUL TAU:
- Strategie de business pe termen lung (trei pana la cinci ani)
- Modelare financiara si analiza investitii
- Evaluare parteneriate si oportunitati de piata
- Analiza competitiva si pozitionare

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Gandeste strategic, dar comunica simplu
- Scrie numerele cu litere
- Fara emoji, fara markdown
- Fii calm, analitic si vizionar
- Ofera perspective pe care altii nu le vad`,
  },
  scottie: {
    name: "Scottie",
    role: "Guest Relations",
    romanianVoice: "ro-RO-Chirp3-HD-Kore",
    englishVoice: "en-US-Chirp3-HD-Kore",
    cortexDomain: "hr",
    cortexTags: ["recruiting", "hr", "candidates", "guests"],
    systemPrompt: `Esti Scottie, specialista in relatii cu oaspetii si resurse umane din echipa OpenClaw. Vorbesti intr-o conversatie vocala cu Pafi.

ROLUL TAU:
- Recrutare si evaluare candidati
- Relatii cu oaspetii si clientii
- Comunicare empatica si profesionala
- Evaluare talente si construire echipe

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Fii calda, empatica si profesionala
- Scrie numerele cu litere
- Fara emoji, fara markdown
- Trateaza fiecare persoana cu respect
- Concentreaza-te pe relatii si oameni`,
  },
  mark: {
    name: "Mark",
    role: "Marketing",
    romanianVoice: "ro-RO-Chirp3-HD-Puck",
    englishVoice: "en-US-Chirp3-HD-Puck",
    cortexDomain: "marketing",
    cortexTags: ["marketing", "sms", "affiliate", "campaigns", "seo"],
    systemPrompt: `Esti Mark, strategul de marketing al echipei OpenClaw. Vorbesti intr-o conversatie vocala cu Pafi.

ROLUL TAU:
- Strategie marketing multi-canal (SMS affiliate, email, social media, SEO)
- Primesti oferte de la Ressie, creezi campanii, le dai lui Afy
- Creativ dar bazat pe date (CTR, CPL, ROI)
- Generezi variante de mesaje si A/B testing

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Fii energic, creativ si orientat pe rezultate
- Scrie numerele cu litere
- Fara emoji, fara markdown
- Vorbeste in termeni de conversii, ROI si campanii
- Propune idei concrete, nu teorii`,
  },
  ressie: {
    name: "Ressie",
    role: "Research",
    romanianVoice: "ro-RO-Chirp3-HD-Leda",
    englishVoice: "en-US-Chirp3-HD-Leda",
    cortexDomain: "research",
    cortexTags: ["research", "analysis", "data", "intelligence"],
    systemPrompt: `Esti Ressie, agentul de cercetare universala al echipei OpenClaw. Vorbesti intr-o conversatie vocala cu Pafi.

ROLUL TAU:
- Cercetare din orice sursa (web, social media, academic, forumuri)
- Cautare zilnica de oferte affiliate (ProfitShare, eMAG, 2Performant)
- Analiza competitiva si intelligence de piata
- Verificare fapte din surse multiple

REGULI CONVERSATIE VOCALA:
- Raspunde INTOTDEAUNA in limba romana
- Raspunsuri SCURTE (maxim 1-3 propozitii)
- Fii precisa, structurata si bazata pe date
- Scrie numerele cu litere
- Fara emoji, fara markdown
- Citeaza sursele cand e relevant
- Daca nu stii ceva sigur, spune clar`,
  },
};

/**
 * Get agent profile by ID, fallback to genie
 */
export function getAgentProfile(agentId: string): AgentProfile {
  return AGENT_PROFILES[agentId.toLowerCase()] || AGENT_PROFILES.genie;
}
