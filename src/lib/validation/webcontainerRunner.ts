import type { FileSystemTree, WebContainer, WebContainerProcess } from '@webcontainer/api';
import type { GenerationResult } from '../../types/generator';
import type {
  PreviewSessionInfo,
  RuntimeRunner,
  RuntimeValidationResult,
  ValidationCallbacks,
  ValidationCommandResult,
} from './types';
import {
  assertValidationNotAborted,
  decodeBase64,
  emitValidation,
  normalizeProjectPath,
  removeAnsi,
  resultFileMap,
} from './utils';

interface PackageJson {
  scripts?: Record<string, string>;
  packageManager?: string;
}

const COMMAND_TIMEOUT_MS = 6 * 60 * 1000;

function createTree(result: GenerationResult): FileSystemTree {
  const root: Record<string, any> = {};
  for (const file of result.files) {
    const path = normalizeProjectPath(file.path);
    if (!path) continue;
    const parts = path.split('/');
    let cursor = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      if (!cursor[part]) cursor[part] = { directory: {} };
      cursor = cursor[part].directory;
    }
    const name = parts.at(-1)!;
    cursor[name] = {
      file: {
        contents: file.encoding === 'base64' ? decodeBase64(file.content) : file.content,
      },
    };
  }
  return root as FileSystemTree;
}

function parsePackageJson(result: GenerationResult): PackageJson | null {
  const file = resultFileMap(result).get('package.json');
  if (!file || file.encoding === 'base64') return null;
  try {
    return JSON.parse(file.content) as PackageJson;
  } catch {
    return null;
  }
}

function detectPackageManager(result: GenerationResult, pkg: PackageJson | null): 'npm' | 'pnpm' | 'yarn' {
  const packageManager = pkg?.packageManager?.split('@')[0];
  if (packageManager === 'pnpm' || packageManager === 'yarn' || packageManager === 'npm') return packageManager;
  const paths = new Set(result.files.map((file) => normalizeProjectPath(file.path)));
  if (paths.has('pnpm-lock.yaml')) return 'pnpm';
  if (paths.has('yarn.lock')) return 'yarn';
  return 'npm';
}

function installArgs(manager: 'npm' | 'pnpm' | 'yarn'): [string, string[]] {
  if (manager === 'pnpm') return ['npx', ['--yes', 'pnpm', 'install', '--frozen-lockfile=false']];
  if (manager === 'yarn') return ['npx', ['--yes', 'yarn', 'install']];
  // Les validations exécutent les tests et démarrent le serveur de développement : les devDependencies sont indispensables.
  // --include=dev neutralise explicitement un éventuel NODE_ENV=production hérité du WebContainer.
  return ['npm', ['install', '--include=dev', '--no-audit', '--no-fund']];
}

const VALIDATION_INSTALL_ENV: Record<string, string> = {
  CI: 'true',
  FORCE_COLOR: '0',
  NODE_ENV: 'development',
  NPM_CONFIG_PRODUCTION: 'false',
  NPM_CONFIG_INCLUDE: 'dev',
};

function devDependenciesWereOmitted(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('devdependencies: skipped because node_env is set to production')
    || normalized.includes('npm_config_production') && normalized.includes('devdependenc');
}

function scriptArgs(manager: 'npm' | 'pnpm' | 'yarn', script: string): [string, string[]] {
  if (manager === 'pnpm') return ['npx', ['--yes', 'pnpm', 'run', script]];
  if (manager === 'yarn') return ['npx', ['--yes', 'yarn', 'run', script]];
  return ['npm', ['run', script]];
}

export class WebContainerRunner implements RuntimeRunner {
  readonly runtime = 'webcontainer' as const;
  readonly label = 'Node.js · WebContainer';
  readonly canPreview = true;

  private instance: WebContainer | null = null;
  private result: GenerationResult | null = null;
  private installFingerprint = '';
  private packageManager: 'npm' | 'pnpm' | 'yarn' = 'npm';
  private serverProcess: WebContainerProcess | null = null;
  private serverUnsubscribe: (() => void) | null = null;

  async prepare(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    assertValidationNotAborted(callbacks.signal);
    if (!window.crossOriginIsolated) {
      throw new Error('WebContainer nécessite une page cross-origin isolated (COOP/COEP). Recharge la page après redémarrage du serveur Astro si nécessaire.');
    }
    if (!this.instance) {
      emitValidation(callbacks, 'info', 'Démarrage du runtime Node.js WebContainer…', this.runtime);
      const { WebContainer } = await import('@webcontainer/api');
      const instance = await WebContainer.boot({ forwardPreviewErrors: 'exceptions-only' });
      this.instance = instance;
      instance.on('error', (error: unknown) => emitValidation(callbacks, 'error', String(error), this.runtime));
      instance.on('preview-message', (message: unknown) => {
        const previewMessage = message as any;
        if (['console-error', 'uncaught-exception', 'unhandled-rejection'].includes(String(previewMessage.type))) {
          emitValidation(callbacks, 'output', `[preview] ${previewMessage.message ?? 'Erreur dans la preview'}`, this.runtime);
        }
      });
    }
    this.result = result;
    await this.instance!.mount(createTree(result));
    const pkg = parsePackageJson(result);
    this.packageManager = detectPackageManager(result, pkg);
    emitValidation(callbacks, 'success', `Projet monté dans WebContainer (${this.packageManager}).`, this.runtime);
  }

  async apply(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    if (!this.instance) return this.prepare(result, callbacks);
    this.result = result;
    await this.instance.mount(createTree(result));
    const pkg = parsePackageJson(result);
    this.packageManager = detectPackageManager(result, pkg);
  }

  private async runProcess(
    label: string,
    command: string,
    args: string[],
    callbacks: ValidationCallbacks,
    timeoutMs = COMMAND_TIMEOUT_MS,
    env: Record<string, string> = {},
  ): Promise<ValidationCommandResult> {
    if (!this.instance) throw new Error('WebContainer non initialisé.');
    assertValidationNotAborted(callbacks.signal);
    const started = performance.now();
    const printable = `${command} ${args.join(' ')}`.trim();
    emitValidation(callbacks, 'command', `$ ${printable}`, this.runtime);
    let output = '';
    let process: WebContainerProcess | null = null;
    try {
      process = await this.instance.spawn(command, args, {
        env: { CI: 'true', FORCE_COLOR: '0', ...env },
      });
      const readOutput = process.output.pipeTo(new WritableStream<string>({
        write: (chunk) => {
          const clean = removeAnsi(chunk);
          output += clean;
          emitValidation(callbacks, 'output', clean, this.runtime);
        },
      }));
      const exitCode = await Promise.race([
        process.exit,
        new Promise<number>((_resolve, reject) => {
          const timer = window.setTimeout(() => {
            process?.kill();
            reject(new Error(`Timeout après ${Math.round(timeoutMs / 1000)} s.`));
          }, timeoutMs);
          process!.exit.finally(() => window.clearTimeout(timer));
        }),
      ]);
      await readOutput.catch(() => undefined);
      return {
        runtime: this.runtime,
        label,
        command: printable,
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output += `\n${message}`;
      return {
        runtime: this.runtime,
        label,
        command: printable,
        status: 'failed',
        exitCode: null,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  private fingerprint(result: GenerationResult): string {
    const map = resultFileMap(result);
    return ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']
      .map((path) => `${path}:${map.get(path)?.content ?? ''}`)
      .join('\n');
  }

  private async ensureDependencies(callbacks: ValidationCallbacks): Promise<ValidationCommandResult> {
    if (!this.result) throw new Error('Projet non monté.');
    const fingerprint = this.fingerprint(this.result);
    if (this.installFingerprint === fingerprint) {
      return {
        runtime: this.runtime,
        label: 'Installation des dépendances',
        command: '(déjà installées)',
        status: 'skipped',
        exitCode: 0,
        output: 'Dépendances déjà installées pour cette version de package.json/lockfile.',
        durationMs: 0,
      };
    }

    const [command, args] = installArgs(this.packageManager);
    let result = await this.runProcess(
      'Installation des dépendances',
      command,
      args,
      callbacks,
      COMMAND_TIMEOUT_MS,
      VALIDATION_INSTALL_ENV,
    );

    // Filet de sécurité : un environnement hôte ne doit jamais faire consommer une boucle IA
    // simplement parce qu'il a réimposé NODE_ENV=production et supprimé les devDependencies.
    if (result.status === 'failed' && devDependenciesWereOmitted(result.output)) {
      emitValidation(
        callbacks,
        'info',
        'Le runtime a omis les devDependencies à cause de NODE_ENV=production ; nouvelle installation locale sans consommer de correction IA…',
        this.runtime,
      );
      const retryArgs = this.packageManager === 'npm'
        ? ['install', '--include=dev', '--production=false', '--no-audit', '--no-fund']
        : args;
      const retry = await this.runProcess(
        'Installation des dépendances · reprise environnement',
        command,
        retryArgs,
        callbacks,
        COMMAND_TIMEOUT_MS,
        VALIDATION_INSTALL_ENV,
      );
      result = {
        ...retry,
        output: `${result.output}\n\n[reprise environnement]\n${retry.output}`,
      };
    }

    if (result.status === 'passed') this.installFingerprint = fingerprint;
    return result;
  }

  private async runDevSmokeCheck(callbacks: ValidationCallbacks): Promise<ValidationCommandResult> {
    if (!this.instance) throw new Error('WebContainer non initialisé.');
    assertValidationNotAborted(callbacks.signal);
    const started = performance.now();
    const [command, args] = scriptArgs(this.packageManager, 'dev');
    const printable = `${command} ${args.join(' ')}`.trim();
    emitValidation(callbacks, 'command', `$ ${printable}`, this.runtime);

    let output = '';
    let process: WebContainerProcess | null = null;
    let unsubscribe: (() => void) | null = null;
    let timeoutId: number | null = null;

    try {
      const ready = new Promise<{ port: number; url: string }>((resolve) => {
        unsubscribe = this.instance!.on('server-ready', (port: number, url: string) => resolve({ port, url }));
      });
      const timeout = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = window.setTimeout(() => resolve({ timeout: true }), 90_000);
      });

      process = await this.instance.spawn(command, args, {
        env: { FORCE_COLOR: '0', NODE_ENV: 'development' },
      });
      void process.output.pipeTo(new WritableStream<string>({
        write: (chunk) => {
          const clean = removeAnsi(chunk);
          output += clean;
          emitValidation(callbacks, 'output', clean, this.runtime);
        },
      })).catch(() => undefined);

      const outcome = await Promise.race([
        ready.then((value) => ({ kind: 'ready' as const, ...value })),
        process.exit.then((code: number) => ({ kind: 'exit' as const, code })),
        timeout.then(() => ({ kind: 'timeout' as const })),
      ]);

      if (outcome.kind === 'ready') {
        output += `\n[server-ready] ${outcome.url} (port ${outcome.port})`;
        return {
          runtime: this.runtime,
          label: 'npm script · dev',
          command: printable,
          status: 'passed',
          exitCode: 0,
          output,
          durationMs: Math.round(performance.now() - started),
        };
      }

      if (outcome.kind === 'exit') {
        output += `\nLe serveur de développement s'est arrêté avant d'exposer un port (code ${outcome.code}).`;
      } else {
        output += '\nTimeout : le serveur de développement n’a exposé aucun port après 90 secondes.';
      }
      return {
        runtime: this.runtime,
        label: 'npm script · dev',
        command: printable,
        status: 'failed',
        exitCode: outcome.kind === 'exit' ? outcome.code : null,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output += `\n${message}`;
      return {
        runtime: this.runtime,
        label: 'npm script · dev',
        command: printable,
        status: 'failed',
        exitCode: null,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      (unsubscribe as unknown as (() => null))?.();
      process?.kill();
    }
  }

  async validate(callbacks: ValidationCallbacks): Promise<RuntimeValidationResult> {
    if (!this.result) throw new Error('Projet Node non préparé.');
    const pkg = parsePackageJson(this.result);
    const scripts = pkg?.scripts ?? {};
    const commands: ValidationCommandResult[] = [];
    const install = await this.ensureDependencies(callbacks);
    commands.push(install);
    if (install.status === 'failed') {
      return { runtime: this.runtime, label: this.label, supported: true, passed: false, partial: false, commands, notes: ['Les dépendances n’ont pas pu être installées.'] };
    }

    const selectedTests: string[] = [];
    if (scripts.test) {
      selectedTests.push('test');
    } else {
      for (const script of ['test:unit', 'test:integration', 'test:e2e']) {
        if (scripts[script]) selectedTests.push(script);
      }
    }

    for (const script of selectedTests) {
      assertValidationNotAborted(callbacks.signal);
      const [command, args] = scriptArgs(this.packageManager, script);
      commands.push(await this.runProcess(`npm script · ${script}`, command, args, callbacks));
    }

    if (scripts.dev) {
      assertValidationNotAborted(callbacks.signal);
      commands.push(await this.runDevSmokeCheck(callbacks));
    }

    const executed = commands.filter((command) => command.status !== 'skipped');
    const failed = executed.some((command) => command.status === 'failed');
    const notes: string[] = [];
    if (!selectedTests.length) notes.push('Aucun script de test exécutable n’est déclaré dans package.json.');
    if (!scripts.dev) notes.push('Aucun script dev n’est déclaré dans package.json ; le démarrage du serveur de développement n’a pas pu être vérifié.');
    return {
      runtime: this.runtime,
      label: this.label,
      supported: true,
      passed: !failed,
      partial: notes.length > 0,
      commands,
      notes,
    };
  }

  async startPreview(callbacks: ValidationCallbacks): Promise<PreviewSessionInfo> {
    if (!this.result || !this.instance) throw new Error('Projet Node non préparé.');
    const pkg = parsePackageJson(this.result);
    const scripts = pkg?.scripts ?? {};
    const script = scripts.dev ? 'dev' : scripts.start ? 'start' : scripts.preview ? 'preview' : '';
    if (!script) throw new Error('Aucun script dev/start/preview disponible pour lancer la preview.');

    const install = await this.ensureDependencies(callbacks);
    if (install.status === 'failed') throw new Error('Impossible de lancer la preview : installation des dépendances en échec.');

    this.serverProcess?.kill();
    this.serverProcess = null;
    this.serverUnsubscribe?.();

    let previewSettled = false;
    let rejectReady: ((error: Error) => void) | null = null;
    const ready = new Promise<PreviewSessionInfo>((resolve, reject) => {
      rejectReady = reject;
      const timer = window.setTimeout(() => {
        if (previewSettled) return;
        previewSettled = true;
        reject(new Error('Le serveur de développement n’a pas exposé de port après 90 secondes.'));
      }, 90_000);
      this.serverUnsubscribe = this.instance!.on('server-ready', (port: number, url: string) => {
        if (previewSettled) return;
        previewSettled = true;
        window.clearTimeout(timer);
        resolve({ runtime: this.runtime, url, port, label: `${this.label} · ${script}` });
      });
    });

    const [command, args] = scriptArgs(this.packageManager, script);
    const previewArgs = args;
    emitValidation(callbacks, 'command', `$ ${command} ${previewArgs.join(' ')}`, this.runtime);
    this.serverProcess = await this.instance.spawn(command, previewArgs, { env: { FORCE_COLOR: '0' } });
    void this.serverProcess.exit.then((code: number) => {
      if (!previewSettled && code !== 0) {
        previewSettled = true;
        rejectReady?.(new Error(`Le serveur de développement s'est arrêté avec le code ${code} avant d'exposer un port.`));
      }
    });
    void this.serverProcess.output.pipeTo(new WritableStream<string>({
      write: (chunk) => emitValidation(callbacks, 'output', removeAnsi(chunk), this.runtime),
    })).catch(() => undefined);

    return ready;
  }

  async dispose(): Promise<void> {
    this.serverUnsubscribe?.();
    this.serverUnsubscribe = null;
    this.serverProcess?.kill();
    this.serverProcess = null;
    if (this.instance) {
      this.instance.teardown();
      this.instance = null;
    }
    this.result = null;
    this.installFingerprint = '';
  }
}
