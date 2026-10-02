export type DegenerationCode =
  | 'repeated-token-unit'
  | 'monotonic-identifier-growth'
  | 'exact-line-repetition'
  | 'repeated-block'
  | 'near-identical-line-family'
  | 'low-lexical-novelty';

export interface DegenerationFinding {
  code: DegenerationCode;
  reason: string;
  sample: string;
  index: number;
  score?: number;
}

const TOKEN_RE = /[A-Za-z_$][A-Za-z0-9_$-]{15,}/g;
const WORD_RE = /[A-Za-zÀ-ÿ_$][A-Za-zÀ-ÿ0-9_$-]{1,}/g;
const MIN_REPEATED_UNIT = 2;
const MAX_REPEATED_UNIT = 16;
const MIN_REPEATS = 3;

function repeatedSuffix(token: string): { unit: string; repeats: number } | null {
  const lower = token.toLowerCase();
  for (let size = MIN_REPEATED_UNIT; size <= Math.min(MAX_REPEATED_UNIT, Math.floor(lower.length / MIN_REPEATS)); size += 1) {
    const unit = lower.slice(-size);
    let repeats = 1;
    let cursor = lower.length - size * 2;
    while (cursor >= 0 && lower.slice(cursor, cursor + size) === unit) {
      repeats += 1;
      cursor -= size;
    }
    if (repeats >= MIN_REPEATS && repeats * size >= 12) return { unit, repeats };
  }
  return null;
}

function repeatedInnerUnit(token: string): { unit: string; repeats: number } | null {
  const lower = token.toLowerCase();
  for (let size = MIN_REPEATED_UNIT; size <= MAX_REPEATED_UNIT; size += 1) {
    for (let start = Math.max(0, lower.length - 96); start + size * MIN_REPEATS <= lower.length; start += 1) {
      const unit = lower.slice(start, start + size);
      let repeats = 1;
      let cursor = start + size;
      while (cursor + size <= lower.length && lower.slice(cursor, cursor + size) === unit) {
        repeats += 1;
        cursor += size;
      }
      if (repeats >= MIN_REPEATS && repeats * size >= 15) return { unit, repeats };
    }
  }
  return null;
}

function normalizedLine(line: string): string {
  // On conserve volontairement les littéraux et identifiants. Les effacer ferait
  // considérer comme identiques des lignes JSON/i18n parfaitement légitimes.
  return line.trim().replace(/\s+/g, ' ');
}

function commonPrefixRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  let same = 0;
  const limit = Math.min(a.length, b.length);
  while (same < limit && a[same] === b[same]) same += 1;
  return same / max;
}

function detectExactLineRepetition(tail: string, scanStart: number): DegenerationFinding | null {
  const lines = tail.split(/\r?\n/);
  let previous = '';
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizedLine(lines[i]);
    if (line.length < 16) {
      previous = '';
      count = 0;
      continue;
    }
    if (line === previous) count += 1;
    else {
      previous = line;
      count = 1;
    }
    if (count >= 5) {
      return {
        code: 'exact-line-repetition',
        reason: `même ligne structurelle répétée ${count} fois consécutivement`,
        sample: lines[i].slice(0, 180),
        index: scanStart,
        score: Math.min(1, count / 8),
      };
    }
  }
  return null;
}

function detectRepeatedBlock(tail: string, scanStart: number): DegenerationFinding | null {
  const compact = tail.slice(-24_000);
  // Cherche des blocs consécutifs répétés. Les tailles sont assez grandes pour
  // éviter les faux positifs liés à des petites structures de code légitimes.
  for (const size of [96, 160, 256, 384, 512]) {
    if (compact.length < size * 3) continue;
    for (let end = compact.length; end >= Math.max(size * 3, compact.length - 6_000); end -= Math.max(16, Math.floor(size / 4))) {
      const a = compact.slice(end - size, end);
      const b = compact.slice(end - size * 2, end - size);
      const c = compact.slice(end - size * 3, end - size * 2);
      if (a === b && b === c && /[A-Za-z0-9]/.test(a)) {
        return {
          code: 'repeated-block',
          reason: `bloc de ${size} caractères répété au moins 3 fois consécutivement`,
          sample: a.slice(0, 180),
          index: scanStart + Math.max(0, tail.length - compact.length + end - size * 3),
          score: 1,
        };
      }
    }
  }
  return null;
}

function detectNearIdenticalLineFamily(tail: string, scanStart: number): DegenerationFinding | null {
  const rawLines = tail.split(/\r?\n/).slice(-160);
  const lines = rawLines
    .map((raw) => ({ raw, normalized: normalizedLine(raw) }))
    .filter((item) => item.normalized.length >= 24);

  let streak = 0;
  for (let i = 1; i < lines.length; i += 1) {
    const previous = lines[i - 1].normalized;
    const current = lines[i].normalized;
    const ratio = commonPrefixRatio(previous.toLowerCase(), current.toLowerCase());
    const grows = current.length >= previous.length;
    const closeLength = Math.abs(current.length - previous.length) <= Math.max(20, previous.length * 0.35);
    if (ratio >= 0.82 && grows && closeLength) streak += 1;
    else streak = Math.max(0, streak - 1);

    if (streak >= 7) {
      return {
        code: 'near-identical-line-family',
        reason: 'famille de lignes quasi identiques produite de manière répétitive',
        sample: lines[i].raw.slice(0, 180),
        index: scanStart,
        score: Math.min(1, ratio),
      };
    }
  }
  return null;
}

function detectLowLexicalNovelty(tail: string, scanStart: number): DegenerationFinding | null {
  const sample = tail.slice(-20_000);
  const words = (sample.match(WORD_RE) ?? []).map((word) => word.toLowerCase());
  if (words.length < 300) return null;

  const unique = new Set(words);
  const ratio = unique.size / words.length;
  const frequencies = new Map<string, number>();
  for (const word of words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const dominant = Math.max(...frequencies.values()) / words.length;

  // Seuil volontairement strict : du code répétitif normal ne doit pas être rejeté.
  if (ratio < 0.075 && dominant > 0.08) {
    const dominantToken = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    return {
      code: 'low-lexical-novelty',
      reason: `nouveauté lexicale anormalement faible (${(ratio * 100).toFixed(1)} %, token dominant ${(dominant * 100).toFixed(1)} %)`,
      sample: dominantToken,
      index: scanStart + Math.max(0, tail.length - sample.length),
      score: 1 - ratio,
    };
  }
  return null;
}

/**
 * Détecte plusieurs familles de dérives autoregressives. Le détecteur reste
 * conservateur : il préfère laisser passer une répétition légitime plutôt que
 * d'interrompre du code valide.
 */
export function detectDegeneration(text: string): DegenerationFinding | null {
  if (text.length < 1_500) return null;
  const scanStart = Math.max(0, text.length - 64_000);
  const tail = text.slice(scanStart);

  for (const match of tail.matchAll(TOKEN_RE)) {
    const token = match[0];
    const absoluteIndex = scanStart + (match.index ?? 0);
    if (token.length >= 24) {
      const suffix = repeatedSuffix(token) ?? repeatedInnerUnit(token);
      if (suffix) {
        return {
          code: 'repeated-token-unit',
          reason: `motif « ${suffix.unit} » répété ${suffix.repeats} fois dans un même token`,
          sample: token.slice(0, 160),
          index: absoluteIndex,
          score: Math.min(1, suffix.repeats / 6),
        };
      }
    }
  }

  const lines = tail.split(/\r?\n/).slice(-140);
  const identifiers = lines
    .map((line, lineIndex) => {
      const m = line.match(/^\s*([A-Za-z_$][A-Za-z0-9_$-]{8,})\s*[:=]/);
      return m ? { value: m[1], lineIndex } : null;
    })
    .filter((value): value is { value: string; lineIndex: number } => Boolean(value));

  let suspicious = 0;
  for (let i = 1; i < identifiers.length; i += 1) {
    const previous = identifiers[i - 1].value;
    const current = identifiers[i].value;
    const previousTail = previous.slice(-32).toLowerCase();
    const currentTail = current.slice(-48).toLowerCase();
    const repetition = repeatedSuffix(current) ?? repeatedInnerUnit(current);
    const sharesLongTail = previousTail.length >= 16 && currentTail.includes(previousTail.slice(-16));
    if (repetition || (sharesLongTail && current.length > previous.length + 4)) suspicious += 1;
    else suspicious = Math.max(0, suspicious - 1);

    if (suspicious >= 6) {
      return {
        code: 'monotonic-identifier-growth',
        reason: 'croissance monotone d’une famille d’identifiants',
        sample: current.slice(0, 160),
        index: Math.max(scanStart, text.length - tail.length),
        score: Math.min(1, suspicious / 8),
      };
    }
  }

  return detectExactLineRepetition(tail, scanStart)
    ?? detectRepeatedBlock(tail, scanStart)
    ?? detectNearIdenticalLineFamily(tail, scanStart)
    ?? detectLowLexicalNovelty(tail, scanStart);
}
