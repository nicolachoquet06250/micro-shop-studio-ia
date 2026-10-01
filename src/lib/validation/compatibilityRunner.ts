import type { GenerationResult } from '../../types/generator';
import type { RuntimeRunner, RuntimeValidationResult, ValidationCallbacks } from './types';
import { emitValidation, normalizeProjectPath } from './utils';

export class CompatibilityGateRunner implements RuntimeRunner {
  readonly runtime = 'compatibility-gate' as const;
  readonly label = 'Java / Go / Rust · garde de compatibilité';
  readonly canPreview = false;
  private notes: string[] = [];

  constructor(result: GenerationResult) {
    const paths = new Set(result.files.map((file) => normalizeProjectPath(file.path)));
    const hasWasm = [...paths].some((path) => path.endsWith('.wasm'));
    if (paths.has('go.mod')) {
      this.notes.push(hasWasm
        ? 'Go détecté : seuls les artefacts WASI/WASM précompilés sont exécutés par Wasmer ; go test natif n’est pas revendiqué.'
        : 'Go détecté : pas de go test navigateur, car la compatibilité WASI/WASM du projet n’est pas démontrée.');
    }
    if (paths.has('Cargo.toml')) {
      this.notes.push(hasWasm
        ? 'Rust détecté : seuls les artefacts WASI/WASM précompilés sont exécutés par Wasmer ; cargo test natif n’est pas revendiqué.'
        : 'Rust détecté : pas de cargo test navigateur tant que la cible WASI/WASM et les crates compatibles ne sont pas garanties.');
    }
    if (paths.has('pom.xml') || paths.has('build.gradle') || paths.has('build.gradle.kts')) {
      this.notes.push('Java détecté : Maven/Gradle/JDK ne sont pas exécutés dans le navigateur tant qu’un runtime de build compatible n’est pas garanti.');
    }
  }

  async prepare(_result: GenerationResult, callbacks: ValidationCallbacks): Promise<void> {
    for (const note of this.notes) emitValidation(callbacks, 'info', note, this.runtime);
  }

  async apply(_result: GenerationResult, _callbacks: ValidationCallbacks): Promise<void> {}

  async validate(_callbacks: ValidationCallbacks): Promise<RuntimeValidationResult> {
    return {
      runtime: this.runtime,
      label: this.label,
      supported: false,
      passed: true,
      partial: true,
      commands: [],
      notes: [...this.notes],
    };
  }

  async dispose(): Promise<void> {}
}
