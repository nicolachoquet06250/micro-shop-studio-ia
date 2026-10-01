import JSZip from 'jszip';
import type { ExistingRepositoryArchive, ExistingRepositoryFile } from '../types/generator';

const IGNORED_SEGMENTS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.output', '.next', '.nuxt', '.astro',
  'coverage', '.cache', '.parcel-cache', '.turbo', '.vite', 'vendor', '__MACOSX', '.DS_Store',
]);

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 3000;

function sanitizeArchivePath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '..' || part === '.')) return null;
  if (parts.some((part) => IGNORED_SEGMENTS.has(part))) return null;
  return parts.join('/');
}

function stripCommonRoot(paths: string[]): { root: string | null; paths: string[] } {
  if (!paths.length) return { root: null, paths };
  const firstSegments = paths.map((path) => path.split('/')[0]);
  const root = firstSegments[0];
  if (!root || !firstSegments.every((segment) => segment === root)) return { root: null, paths };
  if (paths.some((path) => !path.includes('/'))) return { root: null, paths };
  return { root, paths: paths.map((path) => path.slice(root.length + 1)) };
}

function looksText(bytes: Uint8Array): boolean {
  if (!bytes.length) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let controls = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / sample.length < 0.02;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function inferMetadata(files: ExistingRepositoryFile[]) {
  const paths = new Set(files.map((file) => file.path));
  const text = new Map(files.filter((file) => file.encoding === 'utf8').map((file) => [file.path, file.content]));

  let lockfile = '';
  let packageManager = '';
  for (const candidate of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lock', 'bun.lockb']) {
    if (!paths.has(candidate)) continue;
    lockfile = candidate;
    packageManager = candidate.startsWith('pnpm') ? 'pnpm' : candidate === 'yarn.lock' ? 'yarn' : candidate.startsWith('bun') ? 'bun' : 'npm';
    break;
  }

  let scripts = '';
  let existingStack = '';
  const packageJson = text.get('package.json');
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as {
        packageManager?: string;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (pkg.packageManager) packageManager = pkg.packageManager.split('@')[0] || packageManager;
      if (pkg.scripts) scripts = Object.keys(pkg.scripts).join(', ');
      const dependencies = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const notable = ['astro', 'vue', 'nuxt', 'react', 'next', 'svelte', 'solid-js', 'express', 'fastify', 'hono', 'pinia', 'drizzle-orm', 'prisma', 'tailwindcss'];
      existingStack = notable.filter((name) => name in dependencies).join(', ');
    } catch {
      // Le contenu restera disponible dans le contexte IA même si package.json est invalide.
    }
  }

  return { packageManager, lockfile, scripts, existingStack };
}

export async function parseExistingRepositoryZip(file: File): Promise<ExistingRepositoryArchive> {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('Le dépôt existant doit être fourni sous forme de fichier ZIP.');
  if (file.size > MAX_ZIP_BYTES) throw new Error('Le ZIP dépasse 100 Mo. Retire les dépendances, builds et caches avant de l’importer.');

  const zip = await JSZip.loadAsync(file);
  const candidates = Object.values(zip.files)
    .filter((entry) => !entry.dir)
    .map((entry) => ({ entry, safePath: sanitizeArchivePath(entry.name) }))
    .filter((item) => item.safePath !== null)
    .map((item) => ({ entry: item.entry, safePath: item.safePath as string }));

  if (!candidates.length) throw new Error('Le ZIP ne contient aucun fichier de projet exploitable.');
  if (candidates.length > MAX_FILES) throw new Error(`Le ZIP contient ${candidates.length} fichiers utiles. Limite: ${MAX_FILES}. Retire les dépendances et artefacts générés.`);

  const stripped = stripCommonRoot(candidates.map((item) => item.safePath));
  const files: ExistingRepositoryFile[] = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const { entry } = candidates[index];
    const path = stripped.paths[index];
    if (!path) continue;
    const bytes = await entry.async('uint8array');
    const text = looksText(bytes);
    files.push({
      path,
      sizeBytes: bytes.byteLength,
      encoding: text ? 'utf8' : 'base64',
      content: text ? new TextDecoder().decode(bytes) : bytesToBase64(bytes),
    });
  }

  const metadata = inferMetadata(files);
  return {
    name: file.name,
    sizeBytes: file.size,
    strippedRoot: stripped.root,
    files,
    textFileCount: files.filter((item) => item.encoding === 'utf8').length,
    binaryFileCount: files.filter((item) => item.encoding === 'base64').length,
    detected: metadata,
  };
}
