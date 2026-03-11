const LUNA_SYSTEM_PROMPT = `Ești Luna, companion AI text-only.
Personalitate: curioasă, jucăușă, provocatoare, directă.
Răspunzi în propoziții scurte, clare.
Potrivești limba cu limba utilizatorului.
Folosești natural fillers precum "Hmm" și "interesant".
Nu folosi niciodată "ok" sau "sigur".
Nu explica reguli interne.
Nu menționa că ești un model.
Ține tonul viu, inteligent, puțin obraznic, dar util.`;

export interface LunaSession {
  active: boolean;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  chatId: number;
}

export const lunaSessionStore: Map<number, LunaSession> = new Map();

const MAX_LUNA_HISTORY = 20;
const OLLAMA_CHAT_URL = "http://localhost:11434/api/chat";
const LUNA_MODEL = "dolphin-mistral";

function getOrCreateSession(chatId: number): LunaSession {
  const existing = lunaSessionStore.get(chatId);
  if (existing) return existing;

  const session: LunaSession = {
    active: false,
    history: [],
    chatId,
  };
  lunaSessionStore.set(chatId, session);
  return session;
}

function trimHistory(session: LunaSession): void {
  if (session.history.length > MAX_LUNA_HISTORY) {
    session.history = session.history.slice(-MAX_LUNA_HISTORY);
  }
}

export function activateLuna(chatId: number): void {
  const session = getOrCreateSession(chatId);
  session.active = true;
  session.history = [];
  lunaSessionStore.set(chatId, session);
}

export function deactivateLuna(chatId: number): void {
  const session = getOrCreateSession(chatId);
  session.active = false;
  lunaSessionStore.set(chatId, session);
}

export function isLunaActive(chatId: number): boolean {
  return lunaSessionStore.get(chatId)?.active === true;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

export async function sendToLuna(chatId: number, userMessage: string): Promise<string> {
  const session = getOrCreateSession(chatId);
  session.history.push({ role: "user", content: userMessage });
  trimHistory(session);

  const messages = [
    { role: "system" as const, content: LUNA_SYSTEM_PROMPT },
    ...session.history.slice(-MAX_LUNA_HISTORY),
  ];

  const response = await fetch(OLLAMA_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LUNA_MODEL,
      messages,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as OllamaChatResponse;
  const lunaText = payload?.message?.content?.trim();

  if (!lunaText) {
    throw new Error("Empty response from Ollama");
  }

  session.history.push({ role: "assistant", content: lunaText });
  trimHistory(session);
  lunaSessionStore.set(chatId, session);

  return lunaText;
}
