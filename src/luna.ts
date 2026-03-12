/**
 * Luna — AI companion module
 * System prompt loaded from ~/.claude-relay-luna/system-prompt.txt
 * Supports Ollama (local) and OpenRouter (cloud) backends.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const RELAY_DIR = process.env.RELAY_DIR_LUNA || join(homedir(), ".claude-relay-luna");
const SYSTEM_PROMPT_PATH = join(RELAY_DIR, "system-prompt.txt");
const MEMORY_PROMPT_PATH = join(RELAY_DIR, "memory-pafi.md");
const DEFAULT_OPENING_LINE = "well? what do you want from me, slut?";
const MAX_HISTORY = 40; // messages per chat (20 turns)
const MAX_INPUT_LENGTH = 4000;
const FETCH_TIMEOUT_MS = 60_000;

// Backend: "openrouter" or "ollama"
let backend: "openrouter" | "ollama" = process.env.LUNA_BACKEND as any || "openrouter";
let currentModel = process.env.LUNA_MODEL || "nousresearch/hermes-4-70b";

// OpenRouter config
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
function getOpenRouterKey(): string {
  const envKey = process.env.OPENROUTER_API_KEY;
  if (envKey) return envKey;
  try {
    return execSync('security find-generic-password -s "openrouter" -a "api-key" -w 2>/dev/null', { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

// Ollama config
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// Per-chat conversation history
const sessions = new Map<number, Message[]>();

function loadSystemPrompt(): string {
  if (existsSync(SYSTEM_PROMPT_PATH)) {
    const content = readFileSync(SYSTEM_PROMPT_PATH, "utf-8").trim();
    if (content) return content;
  }
  return "You are Luna, an AI companion. Awaiting system prompt configuration.";
}

function loadMemoryPrompt(): string {
  if (!existsSync(MEMORY_PROMPT_PATH)) return "";
  const content = readFileSync(MEMORY_PROMPT_PATH, "utf-8").trim();
  return content;
}

function loadRuntimePrompt(): string {
  const systemPrompt = loadSystemPrompt();
  const memoryPrompt = loadMemoryPrompt();
  if (!memoryPrompt) return systemPrompt;
  return `${systemPrompt}\n\n## Runtime Memory\n${memoryPrompt}`;
}

function normalizeModelForBackend(targetBackend: "openrouter" | "ollama", model: string): string {
  if (targetBackend === "openrouter") {
    return model.includes("/") ? model : "nousresearch/hermes-4-70b";
  }
  return model.includes("/") ? "dolphin-mistral" : model;
}

function getHistory(chatId: number): Message[] {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, []);
  }
  return sessions.get(chatId)!;
}

export function activateLuna(chatId: number): string | null {
  if (sessions.has(chatId)) return null;
  sessions.set(chatId, []);
  const prompt = loadRuntimePrompt();
  return prompt.includes("Awaiting") ? "Luna started, but system prompt is missing. Put it in ~/.claude-relay-luna/system-prompt.txt" : null;
}

export function deactivateLuna(chatId: number): void {
  sessions.delete(chatId);
}

export function isLunaActive(chatId: number): boolean {
  return sessions.has(chatId);
}

export function resetLuna(chatId: number): string {
  sessions.delete(chatId);
  sessions.set(chatId, []);
  return DEFAULT_OPENING_LINE;
}

export function setLunaModel(model: string): void {
  currentModel = normalizeModelForBackend(backend, model);
}

export function getLunaModel(): string {
  return `[${backend}] ${currentModel}`;
}

export function setLunaBackend(b: "openrouter" | "ollama"): void {
  backend = b;
  currentModel = normalizeModelForBackend(b, currentModel);
}

export function getLunaBackend(): string {
  return backend;
}

async function sendViaOpenRouter(messages: Message[]): Promise<string> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error("No OpenRouter API key found");
  const model = normalizeModelForBackend("openrouter", currentModel);

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
      "X-Title": "Luna",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.45,
      top_p: 0.8,
      max_tokens: 220,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter error: ${response.status} ${body.slice(0, 200)}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() || "...";
}

async function sendViaOllama(messages: Message[]): Promise<string> {
  const model = normalizeModelForBackend("ollama", currentModel);
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      options: {
        temperature: 0.4,
        top_p: 0.8,
        num_predict: 120,
        repeat_penalty: 1.4,
        repeat_last_n: 128,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { message?: { content?: string } };
  return data.message?.content?.trim() || "...";
}

export async function sendToLuna(chatId: number, userMessage: string): Promise<string> {
  const history = getHistory(chatId);
  const systemPrompt = loadRuntimePrompt();

  const trimmedMessage = userMessage.slice(0, MAX_INPUT_LENGTH);
  history.push({ role: "user", content: trimmedMessage });

  while (history.length > MAX_HISTORY) {
    history.shift();
  }

  const messages: Message[] = [
    { role: "system", content: systemPrompt },
    ...history,
  ];

  const reply = backend === "openrouter"
    ? await sendViaOpenRouter(messages)
    : await sendViaOllama(messages);

  history.push({ role: "assistant", content: reply });
  return reply;
}
