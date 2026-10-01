import type { GenerationResult } from '../../types/generator';
import type { RuntimeRunner, RuntimeValidationResult, ValidationCallbacks, ValidationCommandResult } from './types';
import { assertValidationNotAborted, decodeBase64, emitValidation, normalizeProjectPath } from './utils';

export class WasmerRunner implements RuntimeRunner {
  readonly runtime = 'wasmer' as const;
  readonly label = 'WASI/WASIX · Wasmer';
  readonly canPreview = false;

  private result: GenerationResult | null = null;
  private wasmer: any = null;

  async prepare(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    assertValidationNotAborted(callbacks.signal);
    if (!window.crossOriginIsolated) {
      throw new Error('Wasmer browser nécessite SharedArrayBuffer et donc COOP/COEP.');
    }
    this.result = result;
    if (!this.wasmer) {
      emitValidation(callbacks, 'info', 'Initialisation du runtime WASI/WASIX Wasmer…', this.runtime);
      const { Wasmer } = await import('@wasmer/sdk/browser');
      this.wasmer = new Wasmer();
    }
  }

  async apply(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    this.result = result;
    if (!this.wasmer) await this.prepare(result, callbacks);
  }

  async validate(callbacks: ValidationCallbacks): Promise<RuntimeValidationResult> {
    if (!this.result || !this.wasmer) throw new Error('Wasmer non initialisé.');
    const wasmFiles = this.result.files.filter((file) => normalizeProjectPath(file.path).endsWith('.wasm'));
    const testFiles = wasmFiles.filter((file) => /(^|\/)(test|tests)(\/|[-_.])|\.test\.wasm$|test\.wasm$/i.test(normalizeProjectPath(file.path)));
    const candidates = testFiles.length ? testFiles : wasmFiles.slice(0, 1);
    const commands: ValidationCommandResult[] = [];
    const notes: string[] = [];

    if (!candidates.length) {
      notes.push('Aucun artefact .wasm précompilé à exécuter. Les sources natives ne sont pas compilées implicitement dans le navigateur.');
      return { runtime: this.runtime, label: this.label, supported: true, passed: true, partial: true, commands, notes };
    }

    for (const file of candidates) {
      assertValidationNotAborted(callbacks.signal);
      const path = normalizeProjectPath(file.path);
      const started = performance.now();
      emitValidation(callbacks, 'command', `$ wasmer run ${path}`, this.runtime);
      let sandbox: any = null;
      try {
        const bytes = file.encoding === 'base64' ? decodeBase64(file.content) : new TextEncoder().encode(file.content);
        const pkg = await this.wasmer.packages.load(bytes);
        sandbox = await this.wasmer.sandboxes.create({ packages: [pkg] });
        const output = await sandbox.command(pkg).run();
        const text = output.text();
        if (text) emitValidation(callbacks, 'output', text, this.runtime);
        commands.push({
          runtime: this.runtime,
          label: `WASM · ${path}`,
          command: `wasmer run ${path}`,
          status: 'passed',
          exitCode: 0,
          output: text,
          durationMs: Math.round(performance.now() - started),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitValidation(callbacks, 'output', message, this.runtime);
        commands.push({
          runtime: this.runtime,
          label: `WASM · ${path}`,
          command: `wasmer run ${path}`,
          status: 'failed',
          exitCode: null,
          output: message,
          durationMs: Math.round(performance.now() - started),
        });
      } finally {
        if (sandbox) {
          try { await sandbox.close(); } catch { /* sandbox déjà fermé */ }
        }
      }
    }

    const failed = commands.some((command) => command.status === 'failed');
    if (!testFiles.length) notes.push('Aucun artefact de test explicite trouvé : un seul .wasm a été exécuté comme smoke test.');
    return { runtime: this.runtime, label: this.label, supported: true, passed: !failed, partial: !testFiles.length, commands, notes };
  }

  async dispose(): Promise<void> {
    if (this.wasmer) await this.wasmer.close?.();
    this.wasmer = null;
    this.result = null;
  }
}
