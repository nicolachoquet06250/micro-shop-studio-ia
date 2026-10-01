import type { PHP } from '@php-wasm/universal';
import type { GenerationResult } from '../../types/generator';
import type { RuntimeRunner, RuntimeValidationResult, ValidationCallbacks, ValidationCommandResult } from './types';
import { assertValidationNotAborted, decodeBase64, emitValidation, normalizeProjectPath } from './utils';

export class PhpWasmRunner implements RuntimeRunner {
  readonly runtime = 'php-wasm' as const;
  readonly label = 'PHP · PHP.wasm';
  readonly canPreview = false;

  private php: PHP | null = null;
  private result: GenerationResult | null = null;

  async prepare(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    assertValidationNotAborted(callbacks.signal);
    if (!this.php) {
      emitValidation(callbacks, 'info', 'Chargement de PHP 8.4 WebAssembly…', this.runtime);
      const [{ PHP, loadPHPRuntime }, { getPHPLoaderModule }] = await Promise.all([
        import('@php-wasm/universal'),
        import('@php-wasm/web-8-4'),
      ]);
      const phpLoaderModule = await getPHPLoaderModule();
      this.php = new PHP(await loadPHPRuntime(phpLoaderModule));
    }
    this.result = result;
    this.php.mkdir('/workspace');
    await this.writeProject(result);
    emitValidation(callbacks, 'success', 'Projet monté dans PHP.wasm.', this.runtime);
  }

  private async writeProject(result: GenerationResult) {
    if (!this.php) return;
    for (const file of result.files) {
      const path = normalizeProjectPath(file.path);
      if (!path) continue;
      const fullPath = `/workspace/${path}`;
      const parent = fullPath.split('/').slice(0, -1).join('/') || '/workspace';
      this.php.mkdir(parent);
      this.php.writeFile(fullPath, file.encoding === 'base64' ? decodeBase64(file.content) : file.content);
    }
  }

  async apply(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    this.result = result;
    if (!this.php) return this.prepare(result, callbacks);
    await this.writeProject(result);
  }

  private async runPhp(
    label: string,
    command: string,
    request: { code?: string; scriptPath?: string },
    callbacks: ValidationCallbacks,
  ): Promise<ValidationCommandResult> {
    if (!this.php) throw new Error('PHP.wasm non initialisé.');
    const started = performance.now();
    emitValidation(callbacks, 'command', `$ ${command}`, this.runtime);
    let output = '';
    try {
      const response: any = await this.php.runStream(request);
      const [stdout, stderr, exitCodeValue] = await Promise.all([
        response.stdoutText as Promise<string>,
        response.stderrText as Promise<string>,
        response.exitCode as Promise<number>,
      ]);
      if (stdout) {
        output += stdout;
        emitValidation(callbacks, 'output', stdout, this.runtime);
      }
      if (stderr) {
        output += stderr;
        emitValidation(callbacks, 'output', stderr, this.runtime);
      }
      const exitCode = Number(exitCodeValue);
      return {
        runtime: this.runtime,
        label,
        command,
        status: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output += message;
      emitValidation(callbacks, 'output', message, this.runtime);
      return {
        runtime: this.runtime,
        label,
        command,
        status: 'failed',
        exitCode: null,
        output,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }

  async validate(callbacks: ValidationCallbacks): Promise<RuntimeValidationResult> {
    if (!this.result || !this.php) throw new Error('Projet PHP non préparé.');
    const phpFiles = this.result.files
      .map((file) => normalizeProjectPath(file.path))
      .filter((path) => path.endsWith('.php') && !path.startsWith('vendor/'));
    const commands: ValidationCommandResult[] = [];
    const notes: string[] = [];

    if (phpFiles.length) {
      const list = JSON.stringify(phpFiles.map((path) => `/workspace/${path}`));
      const syntaxCode = `<?php\n$files = json_decode('${list.replace(/'/g, "\\'")}', true);\n$failed = 0;\nforeach ($files as $file) {\n  try {\n    token_get_all(file_get_contents($file), TOKEN_PARSE);\n    echo "PASS syntax $file\\n";\n  } catch (ParseError $e) {\n    $failed = 1;\n    file_put_contents('php://stderr', "FAIL syntax $file: " . $e->getMessage() . "\\n", FILE_APPEND);\n  }\n}\n`;
      const syntax = await this.runPhp('Syntaxe PHP', `php -l (${phpFiles.length} fichiers via TOKEN_PARSE)`, { code: syntaxCode }, callbacks);
      if (/FAIL syntax /i.test(syntax.output)) {
        syntax.status = 'failed';
        syntax.exitCode = 1;
      }
      commands.push(syntax);
    }

    const phpunit = this.result.files.find((file) => normalizeProjectPath(file.path) === 'vendor/bin/phpunit');
    if (phpunit) {
      this.php.setSkipShebang(true);
      commands.push(await this.runPhp('PHPUnit', 'vendor/bin/phpunit', { scriptPath: '/workspace/vendor/bin/phpunit' }, callbacks));
    } else {
      notes.push('PHPUnit non exécuté : vendor/bin/phpunit absent. PHP.wasm ne lance pas automatiquement Composer dans le navigateur.');
    }

    if (!phpFiles.length) notes.push('Aucun fichier PHP trouvé.');
    const failed = commands.some((command) => command.status === 'failed');
    return {
      runtime: this.runtime,
      label: this.label,
      supported: true,
      passed: !failed,
      partial: !phpunit,
      commands,
      notes,
    };
  }

  async dispose(): Promise<void> {
    if (this.php) {
      const disposeSymbol = (Symbol as any).dispose;
      if (disposeSymbol) (this.php as any)[disposeSymbol]?.();
      this.php = null;
    }
    this.result = null;
  }
}
