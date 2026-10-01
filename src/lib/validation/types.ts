import type { AiCallTraceEvent, AiSettings, GenerationResult } from '../../types/generator';

export type ValidationRuntime = 'webcontainer' | 'php-wasm' | 'wasmer' | 'compatibility-gate';
export type ValidationStatus = 'idle' | 'preparing' | 'running' | 'correcting' | 'passed' | 'failed' | 'partial' | 'unsupported';

export interface ValidationCommandResult {
  runtime: ValidationRuntime;
  label: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  output: string;
  durationMs: number;
}

export interface RuntimeValidationResult {
  runtime: ValidationRuntime;
  label: string;
  supported: boolean;
  passed: boolean;
  partial: boolean;
  commands: ValidationCommandResult[];
  notes: string[];
}

export interface ValidationAttempt {
  index: number;
  startedAt: string;
  finishedAt: string;
  passed: boolean;
  partial: boolean;
  runtimes: RuntimeValidationResult[];
  changedFiles: string[];
  aiSummary?: string;
}

export interface ValidationLoopOutcome {
  status: ValidationStatus;
  result: GenerationResult;
  attempts: ValidationAttempt[];
  unsupported: string[];
  previewAvailable: boolean;
  previewRuntime: ValidationRuntime | null;
  message: string;
}

export interface PreviewSessionInfo {
  runtime: ValidationRuntime;
  url: string;
  port?: number;
  label: string;
}

export interface ValidationEvent {
  at: string;
  type: 'info' | 'command' | 'output' | 'success' | 'error' | 'repair';
  runtime?: ValidationRuntime;
  message: string;
}

export interface ValidationCallbacks {
  signal?: AbortSignal;
  onEvent?: (event: ValidationEvent) => void;
  onProjectUpdate?: (result: GenerationResult) => void;
  onAiTrace?: (event: AiCallTraceEvent) => void;
}

export interface RuntimeRunner {
  readonly runtime: ValidationRuntime;
  readonly label: string;
  readonly canPreview: boolean;
  prepare(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void>;
  apply(result: GenerationResult, callbacks: ValidationCallbacks): Promise<void>;
  validate(callbacks: ValidationCallbacks): Promise<RuntimeValidationResult>;
  startPreview?(callbacks: ValidationCallbacks): Promise<PreviewSessionInfo>;
  dispose(): Promise<void>;
}

export interface ValidationContext {
  settings: AiSettings;
  maxFixLoops?: number;
}
