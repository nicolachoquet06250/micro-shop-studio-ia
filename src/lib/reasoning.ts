import type { AiSettings } from '../types/generator';

export type ReasoningPreference = 'auto' | 'reasoning_effort' | 'vllm' | 'prompt' | 'none';
export type ReasoningStrategy = Exclude<ReasoningPreference, 'auto'>;

interface ReasoningCapabilityState {
  preferred?: ReasoningStrategy;
  rejected?: ReasoningStrategy[];
}

const STORAGE_PREFIX = 'micro-shop-generator:reasoning-capability:v1:';
const memoryCache = new Map<string, ReasoningCapabilityState>();

function capabilityKey(settings: AiSettings): string {
  const baseUrl = settings.baseUrl.trim().replace(/\/+$/, '');
  return `${baseUrl}::${settings.model.trim()}`;
}

function storageKey(settings: AiSettings): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(capabilityKey(settings))}`;
}

function readState(settings: AiSettings): ReasoningCapabilityState {
  const key = capabilityKey(settings);
  const memory = memoryCache.get(key);
  if (memory) return { ...memory, rejected: [...(memory.rejected ?? [])] };

  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(storageKey(settings));
      if (raw) {
        const parsed = JSON.parse(raw) as ReasoningCapabilityState;
        const state = {
          preferred: parsed.preferred,
          rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
        } satisfies ReasoningCapabilityState;
        memoryCache.set(key, state);
        return { ...state, rejected: [...(state.rejected ?? [])] };
      }
    } catch {
      // Un cache corrompu ne doit jamais bloquer les appels IA.
    }
  }

  return { rejected: [] };
}

function writeState(settings: AiSettings, state: ReasoningCapabilityState): void {
  const normalized: ReasoningCapabilityState = {
    preferred: state.preferred,
    rejected: [...new Set(state.rejected ?? [])],
  };
  memoryCache.set(capabilityKey(settings), normalized);
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(storageKey(settings), JSON.stringify(normalized));
    } catch {
      // Le cache est une optimisation, jamais une dépendance fonctionnelle.
    }
  }
}

export function reasoningCandidates(settings: AiSettings, thinking?: boolean): ReasoningStrategy[] {
  if (typeof thinking !== 'boolean') return ['none'];

  const preference = settings.reasoningStrategy ?? 'auto';
  if (preference !== 'auto') return [preference];

  const state = readState(settings);
  const rejected = new Set(state.rejected ?? []);
  const ordered: ReasoningStrategy[] = ['reasoning_effort', 'vllm', 'prompt'];
  const available = ordered.filter((strategy) => !rejected.has(strategy));

  if (state.preferred && available.includes(state.preferred)) {
    return [state.preferred, ...available.filter((strategy) => strategy !== state.preferred)];
  }

  return available.length ? available : ['prompt'];
}

export function rememberReasoningStrategy(settings: AiSettings, strategy: ReasoningStrategy): void {
  if ((settings.reasoningStrategy ?? 'auto') !== 'auto' || strategy === 'none') return;
  const state = readState(settings);
  writeState(settings, {
    preferred: strategy,
    rejected: (state.rejected ?? []).filter((candidate) => candidate !== strategy),
  });
}

export function rejectReasoningStrategy(settings: AiSettings, strategy: ReasoningStrategy): void {
  if ((settings.reasoningStrategy ?? 'auto') !== 'auto' || strategy === 'none' || strategy === 'prompt') return;
  const state = readState(settings);
  const rejected = new Set(state.rejected ?? []);
  rejected.add(strategy);
  writeState(settings, {
    preferred: state.preferred === strategy ? undefined : state.preferred,
    rejected: [...rejected],
  });
}

export function clearReasoningCapabilityCache(settings?: AiSettings): void {
  if (settings) {
    memoryCache.delete(capabilityKey(settings));
    if (typeof window !== 'undefined') localStorage.removeItem(storageKey(settings));
    return;
  }

  memoryCache.clear();
  if (typeof window !== 'undefined') {
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) localStorage.removeItem(key);
    }
  }
}

export function applyReasoningPayload(
  payload: Record<string, unknown>,
  strategy: ReasoningStrategy,
  enabled: boolean,
): void {
  if (strategy === 'reasoning_effort') {
    payload.reasoning_effort = enabled ? 'medium' : 'none';
  } else if (strategy === 'vllm') {
    payload.chat_template_kwargs = { enable_thinking: enabled };
  }
}

export function reasoningPromptInstruction(enabled: boolean): string {
  if (enabled) {
    return [
      '/think',
      'Le raisonnement approfondi est autorisé pour cette étape de conception/analyse.',
      'Après ton raisonnement, produis impérativement la réponse finale demandée dans le format attendu.',
    ].join('\n');
  }

  return [
    '/no_think',
    'Cette étape est une tâche d’exécution déjà planifiée.',
    'N’utilise pas de phase de raisonnement étendue : produis directement la réponse finale demandée.',
  ].join('\n');
}

export function isReasoningCompatibilityError(message: string, strategy: ReasoningStrategy): boolean {
  const text = message.toLowerCase();
  const generic = [
    'unknown field',
    'unknown parameter',
    'unrecognized',
    'unsupported',
    'not supported',
    'extra_forbidden',
    'unexpected keyword',
    'unexpected field',
    'additional properties',
    'invalid parameter',
  ].some((needle) => text.includes(needle));

  if (strategy === 'reasoning_effort') return text.includes('reasoning_effort') || generic;
  if (strategy === 'vllm') return text.includes('chat_template_kwargs') || text.includes('enable_thinking') || generic;
  return false;
}

export function reasoningStrategyLabel(strategy: ReasoningPreference): string {
  switch (strategy) {
    case 'auto': return 'Automatique';
    case 'reasoning_effort': return 'OpenAI-compatible (reasoning_effort)';
    case 'vllm': return 'vLLM (chat_template_kwargs)';
    case 'prompt': return 'Prompt portable';
    case 'none': return 'Aucun contrôle';
  }
}
