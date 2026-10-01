import type { GeneratedFile, GenerationResult } from '../../types/generator';
import type { ValidationCallbacks, ValidationEvent, ValidationRuntime } from './types';

export function emitValidation(
  callbacks: ValidationCallbacks,
  type: ValidationEvent['type'],
  message: string,
  runtime?: ValidationRuntime,
) {
  callbacks.onEvent?.({
    at: new Date().toISOString(),
    type,
    runtime,
    message,
  });
}

export function assertValidationNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Validation annulée.', 'AbortError');
}

export function resultFileMap(result: GenerationResult): Map<string, GeneratedFile> {
  return new Map(result.files.map((file) => [file.path.replace(/^\/+/, ''), file]));
}

export function utf8FileMap(result: GenerationResult): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of result.files) {
    if (file.encoding === 'base64') continue;
    map.set(file.path.replace(/^\/+/, ''), file.content);
  }
  return map;
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function upsertGeneratedFile(result: GenerationResult, path: string, content: string): GenerationResult {
  const normalized = normalizeProjectPath(path);
  const nextFiles = result.files.map((file) => ({ ...file }));
  const existing = nextFiles.findIndex((file) => normalizeProjectPath(file.path) === normalized);
  const next = { path: normalized, content, encoding: 'utf8' as const };
  if (existing >= 0) nextFiles[existing] = next;
  else nextFiles.push(next);
  return { ...result, files: nextFiles };
}

export function removeAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function tail(value: string, max = 24_000): string {
  return value.length <= max ? value : value.slice(-max);
}

export function projectHas(result: GenerationResult, path: string): boolean {
  const normalized = normalizeProjectPath(path);
  return result.files.some((file) => normalizeProjectPath(file.path) === normalized);
}
