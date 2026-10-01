import type { AiSettings, GenerationResult } from '../../types/generator';
import { CompatibilityGateRunner } from './compatibilityRunner';
import { PhpWasmRunner } from './phpWasmRunner';
import { repairFromValidation } from './repair';
import type {
  PreviewSessionInfo,
  RuntimeRunner,
  RuntimeValidationResult,
  ValidationAttempt,
  ValidationCallbacks,
  ValidationLoopOutcome,
} from './types';
import { emitValidation, normalizeProjectPath, upsertGeneratedFile } from './utils';
import { WasmerRunner } from './wasmerRunner';
import { WebContainerRunner } from './webcontainerRunner';

export type {
  PreviewSessionInfo,
  RuntimeValidationResult,
  ValidationAttempt,
  ValidationCallbacks,
  ValidationCommandResult,
  ValidationEvent,
  ValidationLoopOutcome,
  ValidationStatus,
} from './types';

let activeRunners: RuntimeRunner[] = [];
let activeResult: GenerationResult | null = null;

function pathsOf(result: GenerationResult): Set<string> {
  return new Set(result.files.map((file) => normalizeProjectPath(file.path)));
}

function detectRunners(result: GenerationResult): RuntimeRunner[] {
  const paths = pathsOf(result);
  const runners: RuntimeRunner[] = [];
  if (paths.has('package.json')) runners.push(new WebContainerRunner());
  if (paths.has('composer.json') || [...paths].some((path) => path.endsWith('.php'))) runners.push(new PhpWasmRunner());
  if (paths.has('wasmer.toml') || [...paths].some((path) => path.endsWith('.wasm'))) runners.push(new WasmerRunner());
  if (paths.has('go.mod') || paths.has('Cargo.toml') || paths.has('pom.xml') || paths.has('build.gradle') || paths.has('build.gradle.kts')) {
    runners.push(new CompatibilityGateRunner(result));
  }
  return runners;
}

function outcomeStatus(runtimes: RuntimeValidationResult[]): { passed: boolean; partial: boolean } {
  const executable = runtimes.filter((runtime) => runtime.supported);
  const failed = executable.some((runtime) => !runtime.passed);
  const partial = runtimes.some((runtime) => runtime.partial || !runtime.supported);
  return { passed: !failed, partial };
}

function compactValidationJson(attempts: ValidationAttempt[]) {
  return attempts.map((attempt) => ({
    index: attempt.index,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    passed: attempt.passed,
    partial: attempt.partial,
    changedFiles: attempt.changedFiles,
    aiSummary: attempt.aiSummary ?? null,
    runtimes: attempt.runtimes.map((runtime) => ({
      runtime: runtime.runtime,
      label: runtime.label,
      supported: runtime.supported,
      passed: runtime.passed,
      partial: runtime.partial,
      notes: runtime.notes,
      commands: runtime.commands.map((command) => ({
        label: command.label,
        command: command.command,
        status: command.status,
        exitCode: command.exitCode,
        durationMs: command.durationMs,
      })),
    })),
  }));
}

function validationMarkdown(attempts: ValidationAttempt[], status: string, unsupported: string[]): string {
  const last = attempts.at(-1);
  const lines = [
    '# Rapport de validation navigateur',
    '',
    `Statut : **${status.toUpperCase()}**`,
    '',
    `Nombre de passes : **${attempts.length}**`,
    '',
  ];
  if (unsupported.length) {
    lines.push('## Limites de runtime', '', ...unsupported.map((item) => `- ${item}`), '');
  }
  if (last) {
    lines.push('## Dernière passe', '');
    for (const runtime of last.runtimes) {
      lines.push(`### ${runtime.label}`, '');
      lines.push(`- Supporté : ${runtime.supported ? 'oui' : 'non'}`);
      lines.push(`- Résultat : ${runtime.passed ? 'PASS' : 'FAIL'}${runtime.partial ? ' (partiel)' : ''}`);
      for (const note of runtime.notes) lines.push(`- Note : ${note}`);
      lines.push('');
      if (runtime.commands.length) {
        lines.push('| Commande | Statut | Code | Durée |', '|---|---:|---:|---:|');
        for (const command of runtime.commands) {
          lines.push(`| \`${command.command.replace(/\|/g, '\\|')}\` | ${command.status} | ${command.exitCode ?? '—'} | ${command.durationMs} ms |`);
        }
        lines.push('');
      }
    }
  }
  lines.push('> Ce rapport est produit à partir des commandes réellement exécutées dans les runtimes navigateur disponibles. Les runtimes non compatibles sont signalés explicitement et ne sont jamais déclarés comme testés.', '');
  return lines.join('\n');
}

function persistValidationArtifacts(
  result: GenerationResult,
  attempts: ValidationAttempt[],
  status: string,
  unsupported: string[],
): GenerationResult {
  let updated = upsertGeneratedFile(
    result,
    '.ai/runtime-validation.json',
    `${JSON.stringify({ status, attempts: compactValidationJson(attempts), unsupported }, null, 2)}\n`,
  );
  updated = upsertGeneratedFile(
    updated,
    '.ai/testing/rapport-validation.md',
    validationMarkdown(attempts, status, unsupported),
  );
  return {
    ...updated,
    artifacts: {
      ...updated.artifacts,
      RUNTIME_VALIDATION: { status, attempts: compactValidationJson(attempts), unsupported },
    },
  };
}

export async function disposeValidationRuntime(): Promise<void> {
  const current = activeRunners;
  activeRunners = [];
  activeResult = null;
  await Promise.allSettled(current.map((runner) => runner.dispose()));
}

export async function runValidationLoop(
  initialResult: GenerationResult,
  settings: AiSettings,
  callbacks: ValidationCallbacks = {},
  maxFixLoops = 5,
): Promise<ValidationLoopOutcome> {
  await disposeValidationRuntime();
  let result = initialResult;
  const attempts: ValidationAttempt[] = [];
  const runners = detectRunners(result);
  activeRunners = runners;
  activeResult = result;

  if (!runners.length) {
    const message = 'Aucun runtime navigateur compatible n’a été détecté pour ce projet.';
    emitValidation(callbacks, 'info', message);
    return { status: 'unsupported', result, attempts, unsupported: [message], previewAvailable: false, previewRuntime: null, message };
  }

  const unavailable = new Map<RuntimeRunner, string>();
  for (const runner of runners) {
    try {
      await runner.prepare(result, callbacks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unavailable.set(runner, message);
      emitValidation(callbacks, 'error', `${runner.label}: ${message}`, runner.runtime);
    }
  }

  for (let loop = 0; loop <= maxFixLoops; loop += 1) {
    const startedAt = new Date().toISOString();
    emitValidation(callbacks, 'info', `Passe de validation ${loop + 1}/${maxFixLoops + 1}.`);
    const runtimes: RuntimeValidationResult[] = [];

    for (const runner of runners) {
      const unavailableReason = unavailable.get(runner);
      if (unavailableReason) {
        runtimes.push({
          runtime: runner.runtime,
          label: runner.label,
          supported: false,
          passed: true,
          partial: true,
          commands: [],
          notes: [`Runtime indisponible : ${unavailableReason}`],
        });
        continue;
      }
      runtimes.push(await runner.validate(callbacks));
    }

    const state = outcomeStatus(runtimes);
    const unsupported = runtimes.flatMap((runtime) => runtime.supported ? [] : runtime.notes);
    const attempt: ValidationAttempt = {
      index: loop + 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed: state.passed,
      partial: state.partial,
      runtimes,
      changedFiles: [],
    };
    attempts.push(attempt);

    if (state.passed) {
      const status = state.partial ? 'partial' : 'passed';
      result = persistValidationArtifacts(result, attempts, status, unsupported);
      activeResult = result;
      callbacks.onProjectUpdate?.(result);
      emitValidation(callbacks, 'success', state.partial ? 'Validation terminée avec limites de runtime.' : 'Toutes les validations exécutables passent.');
      const previewRunner = runners.find((runner) => runner.canPreview && !unavailable.has(runner));
      return {
        status,
        result,
        attempts,
        unsupported,
        previewAvailable: Boolean(previewRunner),
        previewRuntime: previewRunner?.runtime ?? null,
        message: state.partial ? 'Validation exécutable réussie, avec certaines vérifications non disponibles dans le navigateur.' : 'Validation réussie.',
      };
    }

    if (loop >= maxFixLoops) {
      const unsupported = runtimes.flatMap((runtime) => runtime.supported ? [] : runtime.notes);
      result = persistValidationArtifacts(result, attempts, 'failed', unsupported);
      activeResult = result;
      callbacks.onProjectUpdate?.(result);
      return {
        status: 'failed',
        result,
        attempts,
        unsupported,
        previewAvailable: false,
        previewRuntime: null,
        message: `Les validations échouent encore après ${maxFixLoops} boucle(s) de correction IA.`,
      };
    }

    emitValidation(callbacks, 'repair', `Échecs détectés : correction IA ${loop + 1}/${maxFixLoops}.`);
    let repair;
    try {
      repair = await repairFromValidation(result, runtimes, settings, callbacks);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitValidation(callbacks, 'error', `Correction automatique interrompue : ${message}`);
      const unsupported = runtimes.flatMap((runtime) => runtime.supported ? [] : runtime.notes);
      result = persistValidationArtifacts(result, attempts, 'failed', unsupported);
      activeResult = result;
      callbacks.onProjectUpdate?.(result);
      return {
        status: 'failed',
        result,
        attempts,
        unsupported,
        previewAvailable: false,
        previewRuntime: null,
        message: `Validation en échec. La correction automatique n’a pas pu être appliquée : ${message}`,
      };
    }

    result = repair.result;
    attempt.changedFiles = repair.changedFiles;
    attempt.aiSummary = repair.summary;
    activeResult = result;

    if (!repair.changedFiles.length) {
      const unsupported = runtimes.flatMap((runtime) => runtime.supported ? [] : runtime.notes);
      result = persistValidationArtifacts(result, attempts, 'failed', unsupported);
      activeResult = result;
      callbacks.onProjectUpdate?.(result);
      emitValidation(callbacks, 'error', 'Validation en échec : aucune correction automatique applicable. Le projet généré reste disponible.');
      return {
        status: 'failed',
        result,
        attempts,
        unsupported,
        previewAvailable: false,
        previewRuntime: null,
        message: repair.summary || 'Validation en échec : aucune correction automatique applicable.',
      };
    }

    for (const runner of runners) {
      if (unavailable.has(runner)) continue;
      try {
        await runner.apply(result, callbacks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        unavailable.set(runner, message);
        emitValidation(callbacks, 'error', `${runner.label} après correction: ${message}`, runner.runtime);
      }
    }
  }

  throw new Error('Boucle de validation terminée sans état final.');
}

export async function startValidationPreview(callbacks: ValidationCallbacks = {}): Promise<PreviewSessionInfo> {
  if (!activeResult) throw new Error('Aucun projet validé n’est chargé dans les runtimes.');
  const runner = activeRunners.find((candidate) => candidate.canPreview && candidate.startPreview);
  if (!runner?.startPreview) throw new Error('Aucun runner de preview n’est disponible pour ce projet.');
  return runner.startPreview(callbacks);
}
