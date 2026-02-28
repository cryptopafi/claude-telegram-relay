# Voice PWA — Interfață vocală web pentru Genie

Voice PWA este stratul de conversație vocală live care permite interacțiune hands-free cu sistemul. Interfața web din `claude-voice.html` oferă UI de apel, transcript și controale, iar backend-ul din `voice-agent.ts` gestionează WebSocket, VAD, STT, LLM și TTS.

Proiectul este optimizat pentru latență și flux conversațional continuu: sesiuni active, history limitat, barge-in și streaming audio. În arhitectura NEXUS, Voice PWA este "fața" vocală a lui Genie, conectată la modelele și regulile infrastructurii existente.

**Folosește**: Bun/TypeScript, Groq SDK, WebSocket, VAD, TTS streaming, HTML/CSS/JS PWA.

**Canale / Integrări**: browser mobil/desktop, `voice-agent.ts`, Cortex procedures (context), servicii STT/LLM/TTS.

**Produce**:
- Conversații vocale în timp real cu transcript user/assistant.
- Telemetrie de latență și stări de sesiune pentru debugging.

**Schedule**: serviciu runtime persistent (voice agent) + interacțiune on-demand din browser.

**Salvează în**: sesiuni volatile în memorie + logs backend [TBD — de completat cu Pafi].

**Foldere cheie**:
- Script principal: `~/repos/godagoo/claude-telegram-relay/src/voice-agent.ts`
- Config: `~/repos/godagoo/claude-telegram-relay/src/voice-config.ts`
- Logs: `~/repos/godagoo/claude-telegram-relay/logs/` [TBD — de completat cu Pafi]

**Status**: Active — folosit pentru testare și tuning de latență/VAD.
