import { networkContext } from '../network';
import { chatCompletion, parseJsonResponse, type ChatMessage } from '../openai';
import { ContextLedgerStore, fitMessagesToContext } from '../contextBudget';
import type { AiSettings, GenerationResult } from '../../types/generator';
import type { RuntimeValidationResult, ValidationCallbacks } from './types';
import { emitValidation, normalizeProjectPath, tail, upsertGeneratedFile } from './utils';

interface FixPlan {
  summary?: string;
  files?: Array<{
    path?: string;
    reason?: string;
    contextPaths?: string[];
  }>;
}

const FIX_NETWORK = [
  'agents/15-micro-shop-fix-coordinator.agent.md',
  'agents/13b-micro-shop-testing-engineer.agent.md',
  'agents/13a-micro-shop-code-quality.agent.md',
  'skills/validation-loop/SKILL.md',
  'contracts/testing-contract.md',
];

function safePath(value: string): string | null {
  const path = normalizeProjectPath(value);
  if (!path || path.startsWith('../') || path.includes('/../') || path.startsWith('.git/')) return null;
  return path;
}

function validationEvidence(runtimes: RuntimeValidationResult[]): string {
  return runtimes.flatMap((runtime) => runtime.commands
    .filter((command) => command.status === 'failed')
    .map((command) => [
      `RUNTIME: ${runtime.label}`,
      `COMMANDE: ${command.command}`,
      `SORTIE:\n${tail(command.output, 16_000)}`,
    ].join('\n'))).join('\n\n---\n\n');
}

function fileManifest(result: GenerationResult): string {
  return result.files
    .filter((file) => !file.path.startsWith('.agents/'))
    .map((file) => file.path)
    .sort()
    .slice(0, 500)
    .join('\n');
}

function getTextFile(result: GenerationResult, path: string): string {
  const file = result.files.find((candidate) => normalizeProjectPath(candidate.path) === path);
  return file && file.encoding !== 'base64' ? file.content : '';
}

function normalizeGeneratedContent(path: string, raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (/\.md$/i.test(path)) return `${normalized.trimEnd()}\n`;
  const trimmed = normalized.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/)?.[1];
  return `${(fenced ?? normalized).trimEnd()}\n`;
}

async function generateFixedFile(
  settings: AiSettings,
  path: string,
  reason: string,
  current: string,
  contexts: string,
  evidence: string,
  callbacks: ValidationCallbacks,
): Promise<string> {
  const system = [
    'Tu appliques une correction ciblée après exécution réelle des validations du projet.',
    `Tu dois produire exactement un fichier complet : ${path}.`,
    'Les logs de test/build fournis sont des preuves réelles : corrige leur cause sans inventer de succès.',
    'Retourne uniquement le contenu du fichier, sans JSON, sans explication et sans fence artificielle.',
    path.endsWith('.md')
      ? 'Markdown est autorisé dans ce fichier .md.'
      : 'Ce fichier n’est pas un .md : aucun Markdown ni fence Markdown.',
    networkContext(FIX_NETWORK),
  ].join('\n');
  const user = [
    `CAUSE À CORRIGER: ${reason}`,
    '',
    'RÉSULTATS RÉELS DES VALIDATIONS:',
    evidence,
    '',
    `CONTENU ACTUEL DE ${path}:`,
    current || '(fichier absent — le créer si le plan le demande)',
    '',
    'FICHIERS DE CONTEXTE:',
    contexts || '(aucun)',
  ].join('\n');

  let accumulated = '';
  const contextLedger = new ContextLedgerStore();
  let messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  for (let part = 1; part <= 16; part += 1) {
    const correctionStage = part === 1 ? `validation · correction ${path}` : `validation · correction ${path} · fragment ${part}`;
    const fittedMessages = await fitMessagesToContext(settings, messages, correctionStage, contextLedger, {
      signal: callbacks.signal,
      onTrace: callbacks.onAiTrace,
      onInfo: (message) => emitValidation(callbacks, 'repair', message),
    });
    const result = await chatCompletion(settings, fittedMessages, {
      thinking: false,
      signal: callbacks.signal,
      trace: { stage: correctionStage, kind: 'validation-file' },
      onTrace: callbacks.onAiTrace,
      onRetry(info) {
        emitValidation(callbacks, 'repair', `Réponse vide pendant la correction de ${path}; retry ${info.attempt}/${info.maxAttempts}.`);
      },
    });
    if (!result.content) throw new Error(`Correction vide pour ${path}.`);
    accumulated += result.content;
    if (result.finishReason !== 'length') return normalizeGeneratedContent(path, accumulated);

    const end = accumulated.slice(-16_000);
    messages = [
      {
        role: 'system',
        content: [
          `Continue exactement le fichier ${path}.`,
          'Le fragment précédent a été coupé par la limite de sortie.',
          'Ne réfléchis pas à nouveau et ne recommence pas le fichier.',
          'Retourne uniquement la suite après le dernier caractère déjà généré.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `FIN DÉJÀ GÉNÉRÉE (ne pas répéter):\n${end}\n\nContinue immédiatement.`,
      },
    ];
  }
  throw new Error(`Correction de ${path} trop longue après 16 fragments.`);
}

export async function repairFromValidation(
  result: GenerationResult,
  runtimes: RuntimeValidationResult[],
  settings: AiSettings,
  callbacks: ValidationCallbacks,
): Promise<{ result: GenerationResult; changedFiles: string[]; summary: string }> {
  const evidence = validationEvidence(runtimes);
  if (!evidence.trim()) return { result, changedFiles: [], summary: 'Aucune erreur exécutable à corriger.' };

  emitValidation(callbacks, 'repair', 'Le fix-coordinator analyse les résultats réels des tests/builds…');
  const planningMessages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        'Tu es le coordinateur de correction du projet généré.',
        'Analyse uniquement les erreurs réellement observées et retourne un plan JSON minimal.',
        'Schéma attendu: {"summary":"...","files":[{"path":"...","reason":"...","contextPaths":["..."]}]}',
        'Maximum 6 fichiers. Ne planifie que des fichiers nécessaires à la correction.',
        networkContext(FIX_NETWORK),
      ].join('\n'),
    },
    {
      role: 'user',
      content: `RÉSULTATS RÉELS:\n${evidence}\n\nFICHIERS DISPONIBLES:\n${fileManifest(result)}`,
    },
  ];
  const planningLedger = new ContextLedgerStore();
  const fittedPlanningMessages = await fitMessagesToContext(settings, planningMessages, 'validation · plan de correction', planningLedger, {
    signal: callbacks.signal,
    onTrace: callbacks.onAiTrace,
    onInfo: (message) => emitValidation(callbacks, 'repair', message),
  });
  const planning = await chatCompletion(settings, fittedPlanningMessages, {
    json: true,
    thinking: true,
    signal: callbacks.signal,
    trace: { stage: 'validation · plan de correction', kind: 'validation-plan' },
    onTrace: callbacks.onAiTrace,
  });

  if (planning.finishReason === 'length') throw new Error('Le plan de correction a été tronqué par la limite du modèle.');
  const plan = parseJsonResponse<FixPlan>(planning.content);
  const targets = (plan.files ?? []).slice(0, 6)
    .map((entry) => ({
      path: safePath(entry.path ?? ''),
      reason: entry.reason?.trim() || 'Corriger les validations en échec.',
      contextPaths: (entry.contextPaths ?? []).map((path) => safePath(path)).filter((path): path is string => Boolean(path)).slice(0, 8),
    }))
    .filter((entry): entry is { path: string; reason: string; contextPaths: string[] } => Boolean(entry.path));

  if (!targets.length) {
    const summary = plan.summary?.trim()
      || 'Les validations ont échoué, mais le fix-coordinator n’a identifié aucun fichier à corriger automatiquement.';
    emitValidation(callbacks, 'error', summary);
    return { result, changedFiles: [], summary };
  }

  let updated = result;
  const changedFiles: string[] = [];
  for (const target of targets) {
    const current = getTextFile(updated, target.path);
    const contexts = target.contextPaths
      .filter((path) => path !== target.path)
      .map((path) => {
        const content = getTextFile(updated, path);
        return content ? `===== ${path} =====\n${tail(content, 20_000)}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    emitValidation(callbacks, 'repair', `Correction IA de ${target.path}…`);
    const content = await generateFixedFile(settings, target.path, target.reason, current, contexts, evidence, callbacks);
    updated = upsertGeneratedFile(updated, target.path, content);
    changedFiles.push(target.path);
    callbacks.onProjectUpdate?.(updated);
  }

  return {
    result: updated,
    changedFiles,
    summary: plan.summary?.trim() || `Correction de ${changedFiles.length} fichier(s).`,
  };
}
