# Telegram — Relay de comandă și control pentru Genie

Componenta Telegram conectează conversațiile din bot la runtime-ul Claude/Genie și la fluxurile de memorie. Scriptul central `relay.ts` tratează autentificarea userului, istoricul conversației, comenzi, voice notes și bridge-ul către proceduri/Cortex.

Acest proiect este canalul principal de operare remote pentru Pafi: task management, status checks, execuții asistate și sincronizare cu memory repo. Include protecții de access control și lock file pentru a evita instanțe duble.

**Folosește**: Bun/TypeScript, `grammy`, integrare CLI Claude, curl/HTTP API-uri externe.

**Canale / Integrări**: Telegram Bot API, Cortex client, memorie locală (`tasks`, `memory`), TTS/transcribe modules.

**Produce**:
- Mesaje command-response între Pafi și Genie.
- Persistență de istoric conversație și task updates automate.

**Schedule**: serviciu permanent via LaunchAgent (`com.claude.telegram-relay.plist`).

**Salvează în**: `~/.claude-relay/` (session/history/temp), `memory/tasks/pafi-tasks.md`, Cortex când este activat intent-ul.

**Foldere cheie**:
- Script principal: `~/repos/godagoo/claude-telegram-relay/src/relay.ts`
- Config: `~/repos/godagoo/claude-telegram-relay/.env` [TBD — de completat cu Pafi]
- Logs: `~/repos/godagoo/claude-telegram-relay/logs/`

**Status**: Active — botul este componentă operațională de zi cu zi.
