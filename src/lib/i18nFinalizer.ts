export interface I18nKeyUsage {
  key: string;
  usages: Array<{ path: string; line: number; excerpt: string }>;
}

export interface I18nKeyRegistry {
  keys: string[];
  usages: Record<string, I18nKeyUsage['usages']>;
}

const SCANNABLE_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|astro|svelte|html|php|twig|njk|hbs|mustache|mdx)$/i;
const EXCLUDED_PATH = /(^|\/)(?:node_modules|dist|build|coverage|\.ai|\.agents|tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/i;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{1,159}$/;

function lineNumberAt(content: string, index: number): number {
  let lines = 1;
  for (let i = 0; i < index; i += 1) if (content.charCodeAt(i) === 10) lines += 1;
  return lines;
}

function excerptAt(content: string, index: number): string {
  const start = Math.max(0, content.lastIndexOf('\n', index) + 1);
  const endIndex = content.indexOf('\n', index);
  const end = endIndex < 0 ? content.length : endIndex;
  return content.slice(start, end).trim().slice(0, 500);
}

function addUsage(target: Map<string, I18nKeyUsage['usages']>, key: string, path: string, content: string, index: number) {
  const normalized = key.trim();
  if (!KEY_PATTERN.test(normalized)) return;
  const usages = target.get(normalized) ?? [];
  if (usages.length < 6) {
    const usage = { path, line: lineNumberAt(content, index), excerpt: excerptAt(content, index) };
    if (!usages.some((item) => item.path === usage.path && item.line === usage.line && item.excerpt === usage.excerpt)) usages.push(usage);
    target.set(normalized, usages);
  }
}

/** Extrait de façon déterministe les clés i18n réellement référencées par le code. */
export function extractI18nKeyRegistry(files: Map<string, string>, resourcePaths: Set<string>): I18nKeyRegistry {
  const found = new Map<string, I18nKeyUsage['usages']>();

  for (const [path, content] of files) {
    if (!SCANNABLE_EXTENSIONS.test(path) || EXCLUDED_PATH.test(path) || resourcePaths.has(path)) continue;
    const hasI18nMarker = /(?:useI18n|useTranslations|useTranslation|vue-i18n|next-intl|i18next|\$t\s*\(|i18n\.t\s*\(|\bv-t\b|i18nKey)/.test(content);

    const namespacedVariables = new Set<string>();
    // next-intl: const t = useTranslations('checkout'); t('submit')
    for (const namespaceMatch of content.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*useTranslations\(\s*(['"`])([A-Za-z0-9_.:-]+)\2\s*\)/g)) {
      const variable = namespaceMatch[1];
      const namespace = namespaceMatch[3];
      namespacedVariables.add(variable);
      const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const callPattern = new RegExp(`\\b${escapedVariable}\\s*\\(\\s*(['\"])([A-Za-z0-9_.:-]+)\\1`, 'g');
      for (const match of content.matchAll(callPattern)) {
        addUsage(found, `${namespace}.${match[2]}`, path, content, match.index ?? 0);
      }
    }

    const directPatterns = [
      /(?:\$t|i18n\.t|translate|trans|__)\s*\(\s*(['"`])([A-Za-z0-9_.:-]+)\1/g,
      /\bv-t\s*=\s*(['"])(?:['"])?([A-Za-z0-9_.:-]+)(?:['"])?\1/g,
      /\b(?:i18nKey|translationKey|messageKey|message-key)\s*=\s*(['"])([A-Za-z0-9_.:-]+)\1/g,
    ];

    for (const pattern of directPatterns) {
      for (const match of content.matchAll(pattern)) {
        const key = match[2];
        if (!hasI18nMarker && !key.includes('.') && !key.includes(':')) continue;
        addUsage(found, key, path, content, match.index ?? 0);
      }
    }

    // useI18n/i18next peuvent exposer une fonction t non namespacée.
    if (hasI18nMarker && !namespacedVariables.has('t')) {
      for (const match of content.matchAll(/(?<![$A-Za-z0-9_.])t\s*\(\s*(['"`])([A-Za-z0-9_.:-]+)\1/g)) {
        addUsage(found, match[2], path, content, match.index ?? 0);
      }
    }
  }

  const keys = [...found.keys()].sort((a, b) => a.localeCompare(b));
  return { keys, usages: Object.fromEntries(keys.map((key) => [key, found.get(key) ?? []])) };
}

export function chunkKeys(keys: string[], size = 80): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < keys.length; index += size) chunks.push(keys.slice(index, index + size));
  return chunks;
}

function setNested(target: Record<string, unknown>, key: string, value: string) {
  const segments = key.split('.').filter(Boolean);
  if (segments.length <= 1) {
    target[key] = value;
    return;
  }

  let cursor: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

export function nestedCatalog(translations: Record<string, string>): Record<string, unknown> {
  const nested: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(translations).sort(([a], [b]) => a.localeCompare(b))) setNested(nested, key, value);
  return nested;
}

function escapeProperties(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([:=])/g, '\\$1');
}

export function renderStructuredCatalogFile(path: string, payload: Record<string, unknown>, existing = ''): string {
  const json = JSON.stringify(payload, null, 2);
  const lower = path.toLowerCase();

  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml')) return `${json}\n`;
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
    if (/\bexport\s+const\s+messages\b/.test(existing)) return `export const messages = ${json} as const;\n`;
    return `export default ${json} as const;\n`;
  }
  if (lower.endsWith('.mjs') || lower.endsWith('.js') || lower.endsWith('.jsx')) {
    if (/\bmodule\.exports\b/.test(existing)) return `module.exports = ${json};\n`;
    return `export default ${json};\n`;
  }
  if (lower.endsWith('.cjs')) return `module.exports = ${json};\n`;

  // JSON est volontairement le fallback : il reste déterministe et est valide
  // dans de nombreux formats de données textuels. Les plans de génération sont
  // instruits pour privilégier JSON/TS/JS pour les catalogues finaux.
  return `${json}\n`;
}

export function renderCatalogFile(path: string, translations: Record<string, string>, existing = ''): string {
  if (path.toLowerCase().endsWith('.properties')) {
    return `${Object.entries(translations).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${escapeProperties(key)}=${escapeProperties(value)}`).join('\n')}\n`;
  }
  return renderStructuredCatalogFile(path, nestedCatalog(translations), existing);
}

function pathScore(path: string, key: string): number {
  const normalizedPath = path.toLowerCase().replace(/[^a-z0-9]+/g, '.');
  const root = key.toLowerCase().split(/[.:]/)[0];
  if (!root) return 0;
  if (normalizedPath.includes(`.${root}.`)) return 4;
  if (normalizedPath.endsWith(`.${root}.json`) || normalizedPath.endsWith(`.${root}.ts`) || normalizedPath.endsWith(`.${root}.js`)) return 5;
  if (normalizedPath.includes(root)) return 2;
  return 0;
}

export function partitionTranslations(paths: string[], translations: Record<string, string>): Map<string, Record<string, string>> {
  const normalizedPaths = [...new Set(paths)];
  const result = new Map(normalizedPaths.map((path) => [path, {} as Record<string, string>]));
  if (!normalizedPaths.length) return result;
  if (normalizedPaths.length === 1) {
    result.set(normalizedPaths[0], { ...translations });
    return result;
  }

  for (const [key, value] of Object.entries(translations)) {
    const ranked = normalizedPaths
      .map((path, index) => ({ path, index, score: pathScore(path, key) }))
      .sort((a, b) => b.score - a.score || a.index - b.index);
    result.get(ranked[0].path)![key] = value;
  }
  return result;
}
