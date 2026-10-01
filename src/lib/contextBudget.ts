import type { AiCallTraceEvent, AiSettings } from '../types/generator';
import { chatCompletion, type ChatMessage, type MessageContent } from './openai';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 131_072;
export const RESERVED_OUTPUT_TOKENS = 16_384;
export const CONTEXT_SAFETY_MARGIN_TOKENS = 4_096;
export const DEFAULT_INPUT_BUDGET_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS - RESERVED_OUTPUT_TOKENS - CONTEXT_SAFETY_MARGIN_TOKENS;

const FALLBACK_CHARS_PER_TOKEN = 3;
const CHUNK_TARGET_CHARS = 66_000;
const TASK_ANCHOR_CHARS = 18_000;
const MAX_CONSOLIDATION_PASSES = 5;

export interface ContextBudgetCallbacks {
  onInfo?: (message: string) => void;
  onTrace?: (event: AiCallTraceEvent) => void;
  signal?: AbortSignal;
}

export interface ContextLedgerChunk {
  id: string;
  index: number;
  content: string;
  estimatedTokens: number;
}

export interface ContextLedgerEntry {
  id: string;
  stage: string;
  createdAt: string;
  originalTokens: number;
  finalTokens: number;
  tokenizer: 'provider' | 'estimated';
  chunkIds: string[];
  ledger: string;
}

export class ContextLedgerStore {
  readonly chunks: ContextLedgerChunk[] = [];
  readonly entries: ContextLedgerEntry[] = [];

  addChunk(stageId: string, index: number, content: string): string {
    const id = `${stageId}-chunk-${String(index).padStart(3, '0')}`;
    if (!this.chunks.some((chunk) => chunk.id === id)) {
      this.chunks.push({ id, index, content, estimatedTokens: estimateTextTokens(content) });
    }
    return id;
  }

  addEntry(entry: ContextLedgerEntry): void {
    this.entries.push(entry);
  }

  toFiles(): Array<{ path: string; content: string }> {
    if (!this.entries.length) return [];
    const metadata = {
      schema_version: 1,
      strategy: 'map-reduce-context-ledger',
      context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      reserved_output_tokens: RESERVED_OUTPUT_TOKENS,
      safety_margin_tokens: CONTEXT_SAFETY_MARGIN_TOKENS,
      entries: this.entries.map(({ ledger, ...entry }) => entry),
    };
    const files: Array<{ path: string; content: string }> = [
      { path: '.ai/context/ledger.json', content: `${JSON.stringify(metadata, null, 2)}\n` },
    ];
    for (const chunk of this.chunks) {
      files.push({ path: `.ai/context/chunks/${chunk.id}.txt`, content: chunk.content.endsWith('\n') ? chunk.content : `${chunk.content}\n` });
    }
    for (const entry of this.entries) {
      files.push({
        path: `.ai/context/stage-contexts/${entry.id}.md`,
        content: `# Contexte consolidé — ${entry.stage}\n\n${entry.ledger.trim()}\n`,
      });
    }
    return files;
  }
}

interface TokenCountResult {
  tokens: number;
  source: 'provider' | 'estimated';
}

function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content.map((part) => part.type === 'text' ? part.text : '[IMAGE]').join('\n');
}

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / FALLBACK_CHARS_PER_TOKEN));
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => total + 8 + estimateTextTokens(contentToText(message.content)), 4);
}

export async function countMessagesTokens(settings: AiSettings, messages: ChatMessage[], signal?: AbortSignal): Promise<TokenCountResult> {
  try {
    const response = await fetch('/api/openai/tokenize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        payload: { model: settings.model, messages },
      }),
      signal,
    });
    if (response.ok) {
      const payload = await response.json() as {
        count?: unknown;
        tokens?: unknown[];
        token_ids?: unknown[];
        source?: unknown;
      };
      const count = typeof payload.count === 'number'
        ? payload.count
        : Array.isArray(payload.tokens)
          ? payload.tokens.length
          : Array.isArray(payload.token_ids)
            ? payload.token_ids.length
            : NaN;
      if (Number.isFinite(count) && count >= 0) {
        return {
          tokens: count,
          source: payload.source === 'estimated' ? 'estimated' : 'provider',
        };
      }
    }
  } catch {
    // /tokenize n'est pas standard OpenAI. Le fallback conservateur garde le générateur compatible.
  }
  return { tokens: estimateMessagesTokens(messages), source: 'estimated' };
}

function slug(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 72) || 'stage';
}

function splitText(text: string, target = CHUNK_TARGET_CHARS): string[] {
  if (text.length <= target) return [text];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + target);
    if (end < text.length) {
      const section = text.lastIndexOf('\n=====', end);
      const paragraph = text.lastIndexOf('\n\n', end);
      const newline = text.lastIndexOf('\n', end);
      const candidate = Math.max(section, paragraph, newline);
      if (candidate > cursor + Math.floor(target * 0.55)) end = candidate;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

function flattenContext(messages: ChatMessage[]): string {
  return messages.map((message) => `===== MESSAGE ${message.role.toUpperCase()} =====\n${contentToText(message.content)}`).join('\n\n');
}

function taskAnchor(messages: ChatMessage[]): string {
  const user = messages.find((message) => message.role === 'user');
  const text = user ? contentToText(user.content) : '';
  const artifactIndex = text.search(/\n\s*===== (?:ARTEFACT|FICHIER|MESSAGE)/i);
  const useful = artifactIndex > 0 ? text.slice(0, artifactIndex) : text;
  return useful.slice(0, TASK_ANCHOR_CHARS);
}

function preservedSystem(messages: ChatMessage[]): ChatMessage | null {
  const first = messages.find((message) => message.role === 'system');
  return first ? { ...first } : null;
}

async function extractLedgerChunk(
  settings: AiSettings,
  stage: string,
  chunk: string,
  index: number,
  total: number,
  callbacks: ContextBudgetCallbacks,
): Promise<string> {
  const system = [
    'Tu construis un Context Ledger pour une autre IA qui exécutera ensuite la tâche.',
    'Préserve CHAQUE information distincte du fragment : exigences, contraintes, décisions, valeurs, noms exacts, chemins, interfaces, signatures, règles métier, sécurité, i18n, tests, dépendances et relations.',
    'Ne supprime une information que si elle est strictement dupliquée dans ce même fragment.',
    'Pour le code source, conserve les symboles, signatures, exports, imports, structures et comportements nécessaires à une modification compatible.',
    'N’invente rien. N’interprète pas une absence comme une permission.',
    'Retourne uniquement un ledger textuel compact, structuré par puces et sections. Aucun commentaire sur ton travail.',
  ].join('\n');
  const user = `Étape cible: ${stage}\nFragment de contexte ${index}/${total}.\n\n===== CONTEXTE BRUT =====\n${chunk}`;
  const result = await chatCompletion(settings, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], {
    thinking: false,
    temperature: settings.temperature,
    maxTokens: 12_000,
    signal: callbacks.signal,
    trace: { stage, kind: 'other' },
    onTrace: callbacks.onTrace,
  });
  return result.content.trim();
}

async function consolidateLedger(
  settings: AiSettings,
  stage: string,
  ledgers: string[],
  callbacks: ContextBudgetCallbacks,
): Promise<string> {
  let current = ledgers.filter(Boolean);
  for (let pass = 1; pass <= MAX_CONSOLIDATION_PASSES && current.length > 1; pass += 1) {
    const combined = current.join('\n\n===== LEDGER SUIVANT =====\n\n');
    const testMessages: ChatMessage[] = [
      { role: 'system', content: 'Consolidation déterministe de Context Ledger.' },
      { role: 'user', content: combined },
    ];
    const count = await countMessagesTokens(settings, testMessages, callbacks.signal);
    if (count.tokens <= Math.floor(DEFAULT_INPUT_BUDGET_TOKENS * 0.68)) return combined;

    const groups = splitText(combined, CHUNK_TARGET_CHARS * 2);
    const next: string[] = [];
    callbacks.onInfo?.(`Contexte toujours volumineux : consolidation du ledger (passe ${pass}, ${groups.length} groupe(s)).`);
    for (let index = 0; index < groups.length; index += 1) {
      const system = [
        'Fusionne les fragments de Context Ledger ci-dessous sans perdre aucune information distincte.',
        'Déduplique seulement les répétitions strictes. Préserve les valeurs exactes, exceptions, chemins, symboles, signatures, exigences et contradictions éventuelles.',
        'Retourne uniquement le ledger consolidé, sans prose introductive.',
      ].join('\n');
      const result = await chatCompletion(settings, [
        { role: 'system', content: system },
        { role: 'user', content: groups[index] },
      ], {
        thinking: false,
        temperature: settings.temperature,
        maxTokens: 12_000,
        signal: callbacks.signal,
        trace: { stage, kind: 'other' },
        onTrace: callbacks.onTrace,
      });
      next.push(result.content.trim());
    }
    current = next;
  }
  return current.join('\n\n===== LEDGER SUIVANT =====\n\n');
}

export async function fitMessagesToContext(
  settings: AiSettings,
  messages: ChatMessage[],
  stage: string,
  store: ContextLedgerStore,
  callbacks: ContextBudgetCallbacks = {},
): Promise<ChatMessage[]> {
  const originalCount = await countMessagesTokens(settings, messages, callbacks.signal);
  if (originalCount.tokens <= DEFAULT_INPUT_BUDGET_TOKENS) return messages;

  callbacks.onInfo?.(
    `Contexte de ${originalCount.tokens.toLocaleString('fr-FR')} tokens (${originalCount.source}) : préparation automatique d’un Context Ledger avant l’appel.`,
  );

  const raw = flattenContext(messages);
  const chunks = splitText(raw);
  const stageId = `${slug(stage)}-${Date.now().toString(36)}`;
  const chunkIds = chunks.map((chunk, index) => store.addChunk(stageId, index + 1, chunk));
  const mapped: string[] = [];

  for (let index = 0; index < chunks.length; index += 1) {
    callbacks.onInfo?.(`Indexation du contexte ${index + 1}/${chunks.length} pour ${stage}.`);
    mapped.push(await extractLedgerChunk(settings, stage, chunks[index], index + 1, chunks.length, callbacks));
  }

  const ledger = await consolidateLedger(settings, stage, mapped, callbacks);
  const anchor = taskAnchor(messages);
  const system = preservedSystem(messages);
  const imageParts = messages
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === 'image_url');
  const userText = [
    anchor,
    '',
    '===== CONTEXT LEDGER CONSOLIDÉ =====',
    'Le ledger ci-dessous a été construit à partir de l’intégralité du contexte brut. Toutes les contraintes qu’il contient sont obligatoires au même titre que le prompt original.',
    ledger,
  ].join('\n');
  const finalUserContent: MessageContent = imageParts.length
    ? [{ type: 'text', text: userText }, ...imageParts]
    : userText;
  let fitted: ChatMessage[] = [
    ...(system ? [system] : []),
    { role: 'user', content: finalUserContent },
  ];
  let finalCount = await countMessagesTokens(settings, fitted, callbacks.signal);

  // Si le system prompt original est lui-même massif, son contenu est déjà présent
  // dans les chunks bruts et donc dans le ledger. On remplace alors uniquement son
  // enveloppe par une instruction minimale pour ne pas compter deux fois le réseau.
  if (finalCount.tokens > DEFAULT_INPUT_BUDGET_TOKENS && system) {
    fitted = [
      {
        role: 'system',
        content: [
          'Exécute strictement la tâche demandée à partir du Context Ledger consolidé.',
          'Le ledger représente l’intégralité du contexte source, y compris les instructions du réseau d’agents.',
          'Toutes les contraintes, décisions, signatures, chemins et règles qu’il contient sont obligatoires.',
          'N’invente aucune information absente du ledger.',
        ].join('\n'),
      },
      { role: 'user', content: finalUserContent },
    ];
    finalCount = await countMessagesTokens(settings, fitted, callbacks.signal);
  }

  if (finalCount.tokens > DEFAULT_INPUT_BUDGET_TOKENS) {
    throw new Error(
      `Le Context Ledger de l’étape « ${stage} » reste trop volumineux (${finalCount.tokens.toLocaleString('fr-FR')} tokens) ` +
      `pour la fenêtre de ${DEFAULT_CONTEXT_WINDOW_TOKENS.toLocaleString('fr-FR')} tokens.`,
    );
  }

  store.addEntry({
    id: stageId,
    stage,
    createdAt: new Date().toISOString(),
    originalTokens: originalCount.tokens,
    finalTokens: finalCount.tokens,
    tokenizer: originalCount.source,
    chunkIds,
    ledger,
  });
  callbacks.onInfo?.(`Context Ledger prêt : ${originalCount.tokens.toLocaleString('fr-FR')} → ${finalCount.tokens.toLocaleString('fr-FR')} tokens.`);
  return fitted;
}
