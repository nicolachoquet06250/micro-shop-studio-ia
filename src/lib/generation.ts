import JSZip from 'jszip';
import type { AiCallTraceEvent, AiPromptPreview, AiSettings, GeneratedFile, GenerationResult, GeneratorForm, GenerationLog } from '../types/generator';
import { chatCompletion, parseJsonResponse, type ChatMessage, type ChatTextPart, type ChatImagePart } from './openai';
import { buildNetworkManifest, embeddedNetworkFiles, networkContext } from './network';
import { buildProjectInput } from './projectInput';
import { reasoningCandidates, reasoningPromptInstruction } from './reasoning';
import { ContextLedgerStore, fitMessagesToContext } from './contextBudget';

export interface GenerationStreamEvent {
  stage: string;
  phase: 'start' | 'delta' | 'reasoning' | 'done';
  delta?: string;
  reasoningDelta?: string;
  receivedChars: number;
  receivedReasoningChars?: number;
}

export type GenerationStepAction = 'restart' | 'abandon';

export interface GenerationStepState {
  stage: string | null;
  active: boolean;
}

interface AbandonedStepRecord {
  stage: string;
  at: string;
  kind: 'analysis' | 'file';
  target?: string;
}

interface GenerationNetworkState {
  abandonedSteps: AbandonedStepRecord[];
}

export class GenerationStepController {
  private controller: AbortController | null = null;
  private stage: string | null = null;
  private action: GenerationStepAction | null = null;
  private detachParent: (() => void) | null = null;

  begin(stage: string, parentSignal?: AbortSignal): AbortSignal {
    this.finish(this.stage);
    this.stage = stage;
    this.action = null;
    this.controller = new AbortController();

    if (parentSignal) {
      const abortFromParent = () => this.controller?.abort(parentSignal.reason);
      if (parentSignal.aborted) abortFromParent();
      else {
        parentSignal.addEventListener('abort', abortFromParent, { once: true });
        this.detachParent = () => parentSignal.removeEventListener('abort', abortFromParent);
      }
    }

    return this.controller.signal;
  }

  restartCurrent(): boolean { return this.request('restart'); }
  abandonCurrent(): boolean { return this.request('abandon'); }

  private request(action: GenerationStepAction): boolean {
    if (!this.controller || !this.stage || this.controller.signal.aborted) return false;
    this.action = action;
    this.controller.abort(action);
    return true;
  }

  consumeAction(stage: string): GenerationStepAction | null {
    if (this.stage !== stage) return null;
    const action = this.action;
    this.action = null;
    return action;
  }

  finish(stage: string | null): void {
    if (stage && this.stage !== stage) return;
    this.detachParent?.();
    this.detachParent = null;
    this.controller = null;
    this.stage = null;
  }
}

interface GenerateCallbacks {
  onLog?: (entry: GenerationLog) => void;
  onStream?: (event: GenerationStreamEvent) => void;
  onAiTrace?: (event: AiCallTraceEvent) => void;
  onStepState?: (state: GenerationStepState) => void;
  stepController?: GenerationStepController;
  generationState?: GenerationNetworkState;
  contextLedger?: ContextLedgerStore;
  signal?: AbortSignal;
}

interface RoutingResult {
  PROJECT_SPEC?: unknown;
  projectSpec?: unknown;
  selectedAgents?: string[];
  assumptions?: string[];
  blockingQuestions?: string[];
}

interface BuildBatch {
  id: string;
  objective: string;
  owner: string;
  files: string[];
  contextPaths?: string[];
}

interface I18nBuildPlan {
  enabled: boolean;
  defaultLocale?: string | null;
  locales: Array<{
    code: string;
    resourceFiles: string[];
  }>;
  configFiles?: string[];
  verificationFiles?: string[];
}

interface BuildPlan {
  batches: BuildBatch[];
  i18n?: I18nBuildPlan;
  notes?: string[];
}

interface I18nApplicationContext {
  enabled: boolean;
  locales: string[];
  defaultLocale: string | null;
  requirements: string[];
}

interface DataModelArtifact {
  [key: string]: unknown;
}

interface DataModelDiagramResult {
  diagram?: {
    title?: string;
    description?: string;
    mermaid?: string;
  };
}

interface DiagramSpec {
  id: string;
  title: string;
  description?: string;
  mermaid: string;
}

interface DiagramBundle {
  diagrams?: DiagramSpec[];
}

interface ExistingRepositoryContext {
  enabled: boolean;
  archiveName: string | null;
  fileCount: number;
  textFileCount: number;
  binaryFileCount: number;
  paths: string[];
  criticalFiles: Array<{ path: string; content: string }>;
  rules: string[];
}

const CORE = 'skills/micro-shop-core-rules/SKILL.md';

function nowId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(callbacks: GenerateCallbacks, stage: string, status: GenerationLog['status'], message: string) {
  callbacks.onLog?.({ id: nowId(), at: new Date().toISOString(), stage, status, message });
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Génération annulée.', 'AbortError');
}

function stableJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function stripDataModelPresentation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDataModelPresentation);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !['diagram', 'mermaid'].includes(key.toLowerCase()))
      .map(([key, nested]) => [key, stripDataModelPresentation(nested)]),
  );
}

function artifactMessage(name: string, value: unknown): string {
  return `\n\n===== ARTEFACT ${name} =====\n${stableJson(value)}`;
}

function abandonedArtifact(stage: string) {
  return { __abandoned: true, stage, status: 'ABANDONED_BY_USER' } as const;
}

function isAbandonedArtifact(value: unknown): value is ReturnType<typeof abandonedArtifact> {
  return Boolean(value && typeof value === 'object' && (value as { __abandoned?: boolean }).__abandoned);
}

function generationStateMessage(callbacks: GenerateCallbacks): string {
  const state = callbacks.generationState;
  if (!state?.abandonedSteps.length) return '';
  return artifactMessage('GENERATION_STATE', {
    abandonedSteps: state.abandonedSteps,
    instruction: 'Les étapes listées ont été volontairement abandonnées par l’utilisateur. Ne les considère pas comme réussies et ne tente pas de les recréer implicitement. Continue avec les informations disponibles.',
  });
}

function markStepAbandoned(callbacks: GenerateCallbacks, stage: string, kind: AbandonedStepRecord['kind'], target?: string) {
  callbacks.generationState ??= { abandonedSteps: [] };
  callbacks.generationState.abandonedSteps.push({ stage, at: new Date().toISOString(), kind, target });
}

function beginControlledStep(callbacks: GenerateCallbacks, stage: string): AbortSignal | undefined {
  if (!callbacks.stepController) return callbacks.signal;
  const signal = callbacks.stepController.begin(stage, callbacks.signal);
  callbacks.onStepState?.({ stage, active: true });
  return signal;
}

function finishControlledStep(callbacks: GenerateCallbacks, stage: string) {
  callbacks.stepController?.finish(stage);
  callbacks.onStepState?.({ stage: null, active: false });
}

function consumeStepAction(callbacks: GenerateCallbacks, stage: string): GenerationStepAction | null {
  return callbacks.stepController?.consumeAction(stage) ?? null;
}

function buildI18nApplicationContext(form: GeneratorForm): I18nApplicationContext {
  const locales = form.business.internationalization
    ? [...new Set(form.business.locales.map((locale) => locale.trim().toLowerCase()).filter(Boolean))]
    : [];

  return {
    enabled: form.business.internationalization,
    locales,
    defaultLocale: locales.includes(form.business.defaultLocale) ? form.business.defaultLocale : (locales[0] ?? null),
    requirements: form.business.internationalization
      ? [
          'La liste de langues sélectionnée est exhaustive : ne supprimer, ne remplacer et ne rajouter aucune langue.',
          'Tous les textes statiques visibles par un utilisateur doivent être référencés par des clés i18n dans le code, jamais écrits en dur dans les pages, composants ou templates.',
          'Les libellés concernés incluent navigation, boutons, labels, placeholders, validations, erreurs, toasts, états vides, textes d’aide, métadonnées SEO statiques et contenus statiques des e-mails transactionnels.',
          'Les contenus métier dynamiques provenant de la base de données ou saisis par les utilisateurs ne sont pas des wordings statiques et ne doivent pas être remplacés artificiellement par des clés.',
          'Chaque clé de traduction doit disposer d’une traduction réelle dans chacune des langues sélectionnées ; aucune langue ne peut dépendre d’un fallback pour compenser une clé manquante.',
          'Les catalogues de traduction de toutes les langues doivent avoir le même ensemble de clés.',
          'La configuration i18n, le routage/localisation et les tests doivent être cohérents avec le framework réellement choisi dans TECH_STACK.',
        ]
      : [],
  };
}

function buildExistingRepositoryContext(form: GeneratorForm): ExistingRepositoryContext {
  const archive = form.project.existingRepository ? form.repository.archive : null;
  if (!archive) {
    return {
      enabled: false,
      archiveName: null,
      fileCount: 0,
      textFileCount: 0,
      binaryFileCount: 0,
      paths: [],
      criticalFiles: [],
      rules: [],
    };
  }

  const score = (path: string) => {
    const lower = path.toLowerCase();
    if (/^(package\.json|composer\.json|go\.mod|cargo\.toml|pyproject\.toml|requirements\.txt)$/.test(lower)) return 100;
    if (/^(astro|vite|nuxt|next|svelte|tsconfig|eslint|prettier|drizzle|prisma|tailwind|docker|compose)/.test(lower.split('/').pop() ?? '')) return 90;
    if (/^(agents\.md|claude\.md|readme\.md|\.env\.example|\.env\.sample)$/.test(lower)) return 85;
    if (lower.includes('schema') || lower.includes('migration')) return 75;
    if (lower.startsWith('src/') || lower.startsWith('app/') || lower.startsWith('server/')) return 50;
    return 10;
  };

  const candidates = archive.files
    .filter((file) => file.encoding === 'utf8')
    .sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path));

  const criticalFiles: Array<{ path: string; content: string }> = [];
  let budget = 120_000;
  for (const file of candidates) {
    if (criticalFiles.length >= 24 || budget <= 0) break;
    const content = file.content.length > 24_000
      ? `${file.content.slice(0, 16_000)}

/* … extrait tronqué pour le contexte initial … */

${file.content.slice(-8_000)}`
      : file.content;
    if (content.length > budget && criticalFiles.length >= 6) continue;
    criticalFiles.push({ path: file.path, content: content.slice(0, budget) });
    budget -= Math.min(content.length, budget);
  }

  return {
    enabled: true,
    archiveName: archive.name,
    fileCount: archive.files.length,
    textFileCount: archive.textFileCount,
    binaryFileCount: archive.binaryFileCount,
    paths: archive.files.map((file) => file.path),
    criticalFiles,
    rules: [
      'Le ZIP importé est la base réelle du projet : préserver les fichiers, conventions et architecture existants sauf modification explicitement nécessaire.',
      'Ne pas recréer un nouveau starter si le dépôt contient déjà une application exploitable.',
      'Préserver les fichiers non concernés et les fichiers binaires ; ne modifier que les chemins nécessaires à la demande.',
      'Réutiliser le gestionnaire de paquets, les scripts, le framework et les conventions détectés tant qu’aucune contrainte explicite utilisateur ne demande de changement.',
      'Lorsqu’un fichier existant doit être modifié, partir de son contenu actuel et préserver les comportements non concernés.',
      'Le BUILD_PLAN peut omettre les fichiers existants qui ne nécessitent aucune modification : ils seront conservés automatiquement dans le ZIP final.',
    ],
  };
}

function existingRepositoryPrompt(context: ExistingRepositoryContext): string {
  if (!context.enabled) return 'DÉPÔT EXISTANT: aucun, génération d’un nouveau projet.';
  const critical = context.criticalFiles
    .map((file) => `\n===== FICHIER DU DÉPÔT ${file.path} =====\n${file.content}`)
    .join('\n');
  return [
    'DÉPÔT EXISTANT: OUI — CONTRAINTES À PRÉSERVER.',
    `Archive: ${context.archiveName}.`,
    `Fichiers: ${context.fileCount} (${context.textFileCount} texte, ${context.binaryFileCount} binaires).`,
    ...context.rules.map((rule) => `- ${rule}`),
    `ARBORESCENCE EXISTANTE:\n${stableJson(context.paths)}`,
    critical,
  ].join('\n');
}

function i18nPromptRules(context: I18nApplicationContext): string {
  if (!context.enabled) {
    return 'INTERNATIONALISATION: désactivée dans le formulaire. Ne l’active pas implicitement.';
  }

  return [
    'INTERNATIONALISATION: OBLIGATOIRE.',
    `Langues exactes sélectionnées: ${stableJson(context.locales)}.`,
    `Langue par défaut applicative: ${context.defaultLocale ?? '(aucune)'}.`,
    ...context.requirements.map((rule) => `- ${rule}`),
  ].join('\n');
}

function assertI18nBuildPlan(plan: BuildPlan, context: I18nApplicationContext) {
  if (!context.enabled) return;
  if (!plan.i18n?.enabled) {
    throw new Error('Le BUILD_PLAN n’a pas déclaré la prise en charge i18n alors que l’internationalisation est activée.');
  }

  const declared = new Map((plan.i18n.locales ?? []).map((locale) => [locale.code.toLowerCase(), locale]));
  const declaredDefaultLocale = plan.i18n.defaultLocale?.toLowerCase() ?? null;
  const missing = context.locales.filter((locale) => !declared.has(locale));
  const unexpected = [...declared.keys()].filter((locale) => !context.locales.includes(locale));
  const withoutResources = context.locales.filter((locale) => !(declared.get(locale)?.resourceFiles?.length));

  const wrongDefaultLocale = declaredDefaultLocale !== context.defaultLocale;

  if (missing.length || unexpected.length || withoutResources.length || wrongDefaultLocale) {
    const details = [
      missing.length ? `langues absentes: ${missing.join(', ')}` : '',
      unexpected.length ? `langues non demandées: ${unexpected.join(', ')}` : '',
      withoutResources.length ? `catalogue non déclaré: ${withoutResources.join(', ')}` : '',
      wrongDefaultLocale ? `langue par défaut incorrecte: ${declaredDefaultLocale ?? '(absente)'} au lieu de ${context.defaultLocale}` : '',
    ].filter(Boolean).join(' ; ');
    throw new Error(`BUILD_PLAN i18n incomplet (${details}).`);
  }
}

function assertGeneratedI18nResources(plan: BuildPlan, context: I18nApplicationContext, files: Map<string, string>) {
  if (!context.enabled || !plan.i18n) return;
  const missingFiles = new Set<string>();

  for (const locale of plan.i18n.locales ?? []) {
    for (const resourcePath of locale.resourceFiles ?? []) {
      const path = sanitizeGeneratedPath(resourcePath);
      if (!path || !files.has(path)) missingFiles.add(resourcePath);
    }
  }

  if (missingFiles.size) {
    throw new Error(`Ressources i18n non générées: ${[...missingFiles].join(', ')}`);
  }
}

function assertI18nResourcesScheduled(plan: BuildPlan, context: I18nApplicationContext, batches: BuildBatch[]) {
  if (!context.enabled || !plan.i18n) return;
  const scheduled = new Set(
    batches.flatMap((batch) => batch.files.map((path) => sanitizeGeneratedPath(path)).filter((path): path is string => Boolean(path))),
  );
  const missing = new Set<string>();
  for (const locale of plan.i18n.locales ?? []) {
    for (const resourcePath of locale.resourceFiles ?? []) {
      const path = sanitizeGeneratedPath(resourcePath);
      if (!path || !scheduled.has(path)) missing.add(resourcePath);
    }
  }
  if (missing.size) {
    throw new Error(`Le BUILD_PLAN déclare des ressources i18n hors des lots réellement exécutés: ${[...missing].join(', ')}`);
  }
}

function buildJsonMessages(
  systemPaths: string[],
  userContent: string,
  images: Array<{ mimeType: string; dataUrl: string; name: string }> = [],
): ChatMessage[] {
  const system = [
    'Tu exécutes un rôle du réseau micro-shop. Respecte strictement les documents fournis.',
    "Réponds uniquement avec un objet JSON valide, sans bloc Markdown ni commentaire autour.",
    'Une valeur inconnue reste null/UNSPECIFIED. Ne prétends jamais avoir exécuté des commandes ou tests que tu ne peux pas exécuter.',
    'Règle documentaire globale : tout diagramme doit être exprimé en syntaxe Mermaid et, dans le dépôt généré, stocké exclusivement dans un fichier .md avec un bloc ```mermaid. Aucun fichier non-.md ne doit contenir de Markdown, de fence ``` ou de source Mermaid.',
    'DATA_MODEL est la source de vérité logique et agnostique du moteur de base de données : mêmes entités, champs, relations, contraintes et invariants quel que soit l’environnement. Ne mets dans DATA_MODEL aucun moteur, dialecte SQL, type SQL propriétaire, DDL ou migration spécifique.',
    networkContext([...new Set([CORE, ...systemPaths])]),
  ].join('\n');

  const content: Array<ChatTextPart | ChatImagePart> = [{ type: 'text', text: userContent }];
  for (const image of images) {
    content.push({ type: 'text', text: `Référence visuelle : ${image.name}` });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content },
  ];
}

function routingUserContent(
  projectInput: unknown,
  repositoryRules: string,
  i18nRules: string,
): string {
  return `Normalise l'entrée suivante en PROJECT_SPEC. Choisis aussi les agents spécialisés réellement nécessaires. La sélection i18n fournie par l’application est une contrainte explicite : PROJECT_SPEC doit la conserver exactement sans ajouter ni retirer de langue.\n\nENTRÉE FORMULAIRE:\n${stableJson(projectInput)}\n\n${repositoryRules}\n\n${i18nRules}\n\nFormat attendu: {"PROJECT_SPEC": {...}, "selectedAgents": [...], "assumptions": [...], "blockingQuestions": [...]}. Les questions ne doivent être utilisées que si l'absence d'information rend le projet impossible à générer.`;
}

export function buildInitialPromptPreview(form: GeneratorForm, settings: AiSettings): AiPromptPreview {
  const projectInput = buildProjectInput(form);
  const i18nContext = buildI18nApplicationContext(form);
  const repositoryContext = buildExistingRepositoryContext(form);
  let messages = buildJsonMessages(
    ['agents/00-micro-shop-router.agent.md', 'agents/01-micro-shop-project-discovery.agent.md'],
    routingUserContent(projectInput, existingRepositoryPrompt(repositoryContext), i18nPromptRules(i18nContext)),
  );
  const previewStrategy = reasoningCandidates(settings, true)[0];
  if (previewStrategy === 'prompt') {
    const instruction = reasoningPromptInstruction(true);
    const first = messages[0];
    messages = first?.role === 'system' && typeof first.content === 'string'
      ? [{ ...first, content: `${instruction}\n\n${first.content}` }, ...messages.slice(1)]
      : [{ role: 'system', content: instruction }, ...messages];
  }

  return {
    stage: 'discovery / routage',
    kind: 'json',
    model: settings.model,
    temperature: settings.temperature,
    thinking: true,
    json: true,
    prompt: messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string'
        ? message.content
        : message.content.map((part) => part.type === 'text' ? part.text : '[IMAGE — contenu binaire omis]').join('\n'),
    })),
  };
}

async function callJson<T>(
  settings: AiSettings,
  systemPaths: string[],
  userContent: string,
  callbacks: GenerateCallbacks,
  stage: string,
  images: Array<{ mimeType: string; dataUrl: string; name: string }> = [],
): Promise<T> {
  assertNotAborted(callbacks.signal);
  const messages = buildJsonMessages(systemPaths, `${userContent}${generationStateMessage(callbacks)}`, images);

  while (true) {
    emit(callbacks, stage, 'running', `Appel de ${stage}…`);
    callbacks.onStream?.({ stage, phase: 'start', receivedChars: 0 });
    const stepSignal = beginControlledStep(callbacks, stage);

    try {
      callbacks.contextLedger ??= new ContextLedgerStore();
      const fittedMessages = await fitMessagesToContext(settings, messages, stage, callbacks.contextLedger, {
        signal: stepSignal,
        onTrace: callbacks.onAiTrace,
        onInfo: (message) => emit(callbacks, stage, 'info', message),
      });
      const result = await chatCompletion(settings, fittedMessages, {
        json: true,
        thinking: true,
        signal: stepSignal,
        trace: { stage, kind: 'json' },
        onTrace: callbacks.onAiTrace,
        onDelta(delta, accumulated) {
          callbacks.onStream?.({ stage, phase: 'delta', delta, receivedChars: accumulated.length });
        },
        onReasoningDelta(delta, accumulated) {
          callbacks.onStream?.({
            stage,
            phase: 'reasoning',
            reasoningDelta: delta,
            receivedChars: 0,
            receivedReasoningChars: accumulated.length,
          });
        },
        onRetry(info) {
          const diagnostic = info.hadReasoning
            ? `${info.reasoningChars.toLocaleString('fr-FR')} caractères de reasoning sans content`
            : 'réponse vide sans content';
          emit(callbacks, stage, 'info', `${diagnostic} : nouvelle tentative ${info.attempt}/${info.maxAttempts}.`);
        },
      });

      if (result.finishReason === 'length') {
        throw new Error(`${stage} a atteint la limite de sortie du modèle (finish_reason=length) après ${result.content.length} caractères.`);
      }
      const parsed = parseJsonResponse<T>(result.content);
      callbacks.onStream?.({ stage, phase: 'done', receivedChars: result.content.length });
      emit(callbacks, stage, 'done', `${stage} terminé.`);
      return parsed;
    } catch (error) {
      const action = consumeStepAction(callbacks, stage);
      if (action === 'restart') {
        emit(callbacks, stage, 'info', `${stage} annulé puis relancé à la demande de l’utilisateur.`);
        continue;
      }
      if (action === 'abandon') {
        markStepAbandoned(callbacks, stage, 'analysis');
        callbacks.onStream?.({ stage, phase: 'done', receivedChars: 0 });
        emit(callbacks, stage, 'error', `${stage} abandonné par l’utilisateur. Le réseau poursuit avec l’état disponible.`);
        return abandonedArtifact(stage) as T;
      }
      throw error;
    } finally {
      finishControlledStep(callbacks, stage);
    }
  }
}

function unwrapFileContent(path: string, raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (/\.md$/i.test(path)) return normalized.trimEnd() + '\n';

  const trimmed = normalized.trim();
  const fenced = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  const content = fenced?.[1] ?? normalized;
  return content.trimEnd() + '\n';
}

const FILE_CONTINUATION_TAIL_CHARS = 16_000;
const FILE_CONTINUATION_MAX_PARTS = 24;
const FILE_CONTINUATION_MIN_OVERLAP = 24;
const FILE_CONTINUATION_MAX_OVERLAP = 8_000;

function appendContinuation(existing: string, continuation: string): { content: string; overlap: number } {
  if (!existing) return { content: continuation, overlap: 0 };
  if (!continuation) return { content: existing, overlap: 0 };

  const maxOverlap = Math.min(FILE_CONTINUATION_MAX_OVERLAP, existing.length, continuation.length);
  for (let size = maxOverlap; size >= FILE_CONTINUATION_MIN_OVERLAP; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return { content: existing + continuation.slice(size), overlap: size };
    }
  }

  return { content: existing + continuation, overlap: 0 };
}

function continuationMessages(path: string, accumulated: string, part: number, additionalSystemRules = ''): ChatMessage[] {
  const tail = accumulated.slice(-FILE_CONTINUATION_TAIL_CHARS);
  const formatRule = /\.md$/i.test(path)
    ? 'Ce fichier est un .md : Markdown est autorisé et les diagrammes éventuels doivent utiliser Mermaid.'
    : 'Ce fichier n’est pas un .md : continue exclusivement dans son format natif, sans Markdown, sans fence Markdown et sans source Mermaid.';
  const system = [
    `Tu poursuis exactement le même fichier déjà commencé: ${path}.`,
    formatRule,
    'Le fragment précédent a été interrompu uniquement parce que la limite maximale de sortie du modèle a été atteinte.',
    'Retourne uniquement la suite manquante du fichier, à partir du caractère suivant le dernier caractère déjà produit.',
    'Ne recommence jamais le fichier depuis le début. Ne résume rien. Ne répète pas volontairement la fin fournie.',
    'Ne produis aucune explication, aucun objet JSON et aucune fence Markdown ajoutée artificiellement.',
    'Termine normalement le fichier si cette continuation suffit. Sinon la génération pourra être poursuivie dans un nouveau fragment.',
    additionalSystemRules,
  ].filter(Boolean).join('\n');

  const user = [
    `Fichier: ${path}`,
    `Continuation: fragment ${part}`,
    `Longueur déjà générée: ${accumulated.length} caractères`,
    '',
    'Voici uniquement la fin du contenu déjà généré. Elle sert de point de raccord et ne doit pas être reproduite :',
    '----- DÉBUT DE LA FIN DÉJÀ GÉNÉRÉE -----',
    tail,
    '----- FIN DE LA FIN DÉJÀ GÉNÉRÉE -----',
    '',
    'Continue immédiatement après ce contenu et retourne uniquement la suite.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callFileContent(
  settings: AiSettings,
  systemPaths: string[],
  userContent: string,
  callbacks: GenerateCallbacks,
  stage: string,
  path: string,
  additionalSystemRules = '',
): Promise<string | null> {
  assertNotAborted(callbacks.signal);
  emit(callbacks, stage, 'running', `Génération de ${path}…`);

  const system = [
    'Tu exécutes un rôle du réseau micro-shop. Respecte strictement les documents fournis.',
    `Tu génères exactement un seul fichier: ${path}.`,
    'Retourne uniquement le contenu complet du fichier, sans objet JSON, sans commentaire explicatif et sans ellipse.',
    'N\'entoure pas le contenu dans une fence Markdown, sauf si la fence fait réellement partie du contenu du fichier lui-même.',
    'Le fichier doit être cohérent avec les artefacts et fichiers de contexte fournis. Ne prétends jamais avoir exécuté des tests.',
    'Tout diagramme documentaire doit être stocké exclusivement dans un fichier .md et utiliser Mermaid.',
    'Pour tout fichier dont l’extension n’est pas .md, retourne uniquement le format natif du fichier : aucun Markdown, aucune fence ```, aucun diagramme Mermaid et aucune prose décorative.',
    'Le DATA_MODEL fourni est logique et agnostique du moteur. Si plusieurs moteurs sont configurés selon les environnements, implémente dans ce fichier uniquement le moteur/dialecte correspondant à sa cible ; ne mélange jamais plusieurs dialectes dans un même fichier physique.',
    'Si la limite de sortie interrompt ta réponse, arrête-toi naturellement : l’application demandera automatiquement la suite dans un nouvel appel.',
    additionalSystemRules,
    networkContext([...new Set([CORE, ...systemPaths])]),
  ].join('\n');

  let messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: `${userContent}${generationStateMessage(callbacks)}` },
  ];

  let accumulatedFile = '';
  let part = 1;
  callbacks.onStream?.({ stage, phase: 'start', receivedChars: 0 });

  while (part <= FILE_CONTINUATION_MAX_PARTS) {
    assertNotAborted(callbacks.signal);
    const partStage = part === 1 ? stage : `${stage} · fragment ${part}`;
    if (part > 1) {
      emit(callbacks, stage, 'info', `${path} dépasse une réponse IA : génération du fragment ${part}…`);
    }

    const baseLength = accumulatedFile.length;
    const stepSignal = beginControlledStep(callbacks, stage);
    let result: Awaited<ReturnType<typeof chatCompletion>>;
    try {
      callbacks.contextLedger ??= new ContextLedgerStore();
      const fittedMessages = await fitMessagesToContext(settings, messages, partStage, callbacks.contextLedger, {
        signal: stepSignal,
        onTrace: callbacks.onAiTrace,
        onInfo: (message) => emit(callbacks, stage, 'info', message),
      });
      result = await chatCompletion(settings, fittedMessages, {
      thinking: false,
        signal: stepSignal,
      trace: { stage: partStage, kind: part === 1 ? 'file' : 'file-continuation' },
      onTrace: callbacks.onAiTrace,
      onDelta(delta, fragmentAccumulated) {
        callbacks.onStream?.({
          stage: partStage,
          phase: 'delta',
          delta,
          receivedChars: baseLength + fragmentAccumulated.length,
        });
      },
      onReasoningDelta(delta, accumulated) {
        callbacks.onStream?.({
          stage: partStage,
          phase: 'reasoning',
          reasoningDelta: delta,
          receivedChars: baseLength,
          receivedReasoningChars: accumulated.length,
        });
      },
      onRetry(info) {
        const diagnostic = info.hadReasoning
          ? `${info.reasoningChars.toLocaleString('fr-FR')} caractères de reasoning sans content`
          : 'réponse vide sans content';
        emit(
          callbacks,
          stage,
          'info',
          `${path} (fragment ${part}) : ${diagnostic}. Nouvelle tentative ${info.attempt}/${info.maxAttempts}.`,
        );
      },
      });
    } catch (error) {
      const action = consumeStepAction(callbacks, stage);
      if (action === 'restart') {
        emit(callbacks, stage, 'info', `${path}: requête annulée puis relancée à la demande de l’utilisateur.`);
        continue;
      }
      if (action === 'abandon') {
        markStepAbandoned(callbacks, stage, 'file', path);
        callbacks.onStream?.({ stage, phase: 'done', receivedChars: accumulatedFile.length });
        emit(callbacks, stage, 'error', `${path} abandonné par l’utilisateur. Passage au fichier suivant.`);
        return null;
      }
      throw error;
    } finally {
      finishControlledStep(callbacks, stage);
    }

    if (!result.content) {
      throw new Error(`Le modèle a renvoyé un fragment vide pour ${path} (fragment ${part}).`);
    }

    const merged = appendContinuation(accumulatedFile, result.content);
    accumulatedFile = merged.content;
    if (merged.overlap > 0) {
      emit(callbacks, stage, 'info', `${merged.overlap} caractères répétés au raccord du fragment ${part} ont été supprimés.`);
    }

    if (result.finishReason !== 'length') {
      const content = unwrapFileContent(path, accumulatedFile);
      if (!content.trim()) throw new Error(`Le modèle a renvoyé un contenu vide pour ${path}.`);
      if (!/\.md$/i.test(path) && content.includes('```')) {
        throw new Error(`Le modèle a inséré une fence Markdown dans ${path}. Le Markdown est interdit dans les fichiers non-.md.`);
      }

      callbacks.onStream?.({ stage, phase: 'done', receivedChars: accumulatedFile.length });
      emit(
        callbacks,
        stage,
        'done',
        `${path} généré en ${part} fragment(s) (${accumulatedFile.length.toLocaleString('fr-FR')} caractères).`,
      );
      return content;
    }

    emit(
      callbacks,
      stage,
      'info',
      `${path}: fragment ${part} interrompu par la limite de sortie (${result.content.length.toLocaleString('fr-FR')} caractères reçus). Continuation automatique.`,
    );

    part += 1;
    messages = continuationMessages(path, accumulatedFile, part, additionalSystemRules);
  }

  throw new Error(
    `Le fichier ${path} dépasse ${FILE_CONTINUATION_MAX_PARTS} fragments IA successifs. ` +
    `La génération a déjà produit ${accumulatedFile.length.toLocaleString('fr-FR')} caractères ; ` +
    'il est préférable de découper ce fichier en modules plus petits.',
  );
}

function normalizeMermaidSource(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i)?.[1];
  return (fenced ?? trimmed).trim();
}

function diagramMarkdown(title: string, mermaid: string, description?: string): string {
  const safeTitle = title.trim() || 'Diagramme';
  const details = description?.trim() ? `\n${description.trim()}\n` : '';
  return `# ${safeTitle}\n${details}\n\`\`\`mermaid\n${mermaid.trim()}\n\`\`\`\n`;
}

function diagramPath(id: string, fallback: string): string {
  const slug = (id || fallback)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || fallback;
  return `.ai/diagrams/${slug}.md`;
}

function persistDiagram(files: Map<string, string>, diagram: DiagramSpec, fallbackId: string) {
  const mermaid = normalizeMermaidSource(diagram.mermaid);
  if (!mermaid) return;
  files.set(diagramPath(diagram.id, fallbackId), diagramMarkdown(diagram.title || fallbackId, mermaid, diagram.description));
}

function relevantIntegrationPaths(form: GeneratorForm): string[] {
  const paths = ['agents/08-micro-shop-integrations-router.agent.md'];
  if (form.business.payment) paths.push('agents/08a-micro-shop-payment.agent.md', 'skills/payment-security/SKILL.md');
  if (form.business.transactionalEmails) paths.push('agents/08b-micro-shop-email.agent.md', 'skills/email-delivery/SKILL.md');
  if (form.business.mediaManagement || form.visuals.assets.length) paths.push('agents/08c-micro-shop-media.agent.md', 'skills/media-pipeline/SKILL.md');
  return paths;
}

function createAiReadme(): string {
  return `# Réseau multi-agents embarqué\n\nCe dépôt a été généré avec le réseau micro-shop. Les agents, skills et contrats sources sont copiés automatiquement dans \`.agents/\`.\n\n- Instructions canoniques : \`AGENTS.md\`\n- Manifest : \`.agents/manifest.yaml\`\n- Artefacts de génération : \`.ai/\`\n\nAprès assemblage, l'application hôte tente une validation réelle dans les runtimes navigateur compatibles (WebContainer, PHP.wasm ou WASI/WASIX). Les vérifications impossibles dans le navigateur doivent rester explicitement signalées comme non exécutées.\n`;
}

function fallbackAgentsMd(): string {
  return `# AGENTS.md\n\nCe dépôt est une micro-boutique e-commerce générée par Micro Shop Studio.\n\n## Source de vérité\n\n- Réseau embarqué : \`.agents/agents/\`, \`.agents/skills/\`, \`.agents/contracts/\`.\n- Artefacts de génération : \`.ai/\`.\n- Lire le routeur \`.agents/agents/00-micro-shop-router.agent.md\` avant une modification structurante.\n\n## Invariants\n\n- Projet local-only par défaut ; aucun déploiement public automatique.\n- Aucun secret réel dans le dépôt ou le code client.\n- Respecter les règles métier, sécurité, SEO et fidélité visuelle décrites dans \`.ai/\`.\n- Toute modification doit mettre à jour les tests concernés.\n- La validation finale exige une exécution locale réelle des tests et de la couverture ; ne jamais considérer les rapports générés dans le navigateur comme une preuve d'exécution.\n\n## Workflow\n\n1. Lire les artefacts \`.ai/\` pertinents.\n2. Router vers l'agent spécialisé approprié dans \`.agents/agents/\`.\n3. Mettre à jour code + tests.\n4. Exécuter localement les commandes de lint/test/build du projet.\n5. Corriger jusqu'à réussite avant de considérer la tâche terminée.\n`;
}

function sanitizeGeneratedPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.startsWith('.git/')) return null;
  if (/\.(?:puml|plantuml|dot|gv|mmd)$/i.test(normalized)) return null;
  return normalized;
}

function ensureAgentification(files: Map<string, string>) {
  for (const file of embeddedNetworkFiles()) {
    files.set(file.path, file.content);
  }
  files.set('.agents/manifest.yaml', buildNetworkManifest());
  files.set('.agents/README.md', createAiReadme());

  if (!files.has('AGENTS.md')) files.set('AGENTS.md', fallbackAgentsMd());
  if (!files.has('CLAUDE.md')) {
    files.set('CLAUDE.md', '# Claude Code\n\nLire `AGENTS.md` puis utiliser le réseau embarqué dans `.agents/` et les artefacts dans `.ai/`.\n');
  }
  if (!files.has('GEMINI.md')) {
    files.set('GEMINI.md', '# Gemini\n\nLire `AGENTS.md` puis utiliser le réseau embarqué dans `.agents/` et les artefacts dans `.ai/`.\n');
  }
  const adapters: Array<[string, string]> = [
    ['.github/copilot-instructions.md', 'Lire `AGENTS.md` avant toute modification. Le réseau spécialisé est dans `.agents/`.'],
    ['.junie/AGENTS.md', 'Hérite des règles de `../AGENTS.md`. Voir `.agents/` pour les agents et skills détaillés.'],
    ['.cursor/rules/00-project.mdc', '---\ndescription: Règles projet\nalwaysApply: true\n---\nLire `AGENTS.md` et respecter le réseau embarqué dans `.agents/`.'],
    ['.roo/rules/00-project.md', '# Règles projet\n\nLire `AGENTS.md`. Agents/skills : `.agents/`.'],
    ['.windsurf/rules/00-project.md', '# Règles projet\n\nLire `AGENTS.md`. Agents/skills : `.agents/`.'],
  ];
  for (const [path, content] of adapters) if (!files.has(path)) files.set(path, `${content}\n`);
}

function ownerAgent(owner: string): string {
  const normalized = owner.toLowerCase();
  if (normalized.includes('front')) return 'agents/10a-micro-shop-frontoffice-builder.agent.md';
  if (normalized.includes('backoffice') || normalized.includes('admin')) return 'agents/10b-micro-shop-backoffice-builder.agent.md';
  if (normalized.includes('backend') || normalized.includes('api') || normalized.includes('data')) return 'agents/10c-micro-shop-backend-builder.agent.md';
  return 'agents/09-micro-shop-implementation-orchestrator.agent.md';
}

function safeBatches(plan: BuildPlan, maxBatches: number): BuildBatch[] {
  const batches = Array.isArray(plan.batches) ? plan.batches : [];
  return batches
    .filter((b) => b && Array.isArray(b.files) && b.files.length)
    .slice(0, Math.max(1, Math.min(maxBatches, 12)))
    .map((b, index) => ({
      id: b.id || `B${index + 1}`,
      objective: b.objective || 'Implémenter le lot',
      owner: b.owner || 'implementation-orchestrator',
      files: b.files.slice(0, 14),
      contextPaths: Array.isArray(b.contextPaths) ? b.contextPaths.slice(0, 12) : [],
    }));
}

export async function generateShop(
  form: GeneratorForm,
  settings: AiSettings,
  callbacks: GenerateCallbacks = {},
): Promise<GenerationResult> {
  if (form.project.existingRepository && !form.repository.archive) {
    throw new Error('Un ZIP de projet existant est requis lorsque « Dépôt existant » est activé.');
  }
  const projectInput = buildProjectInput(form);
  const i18nContext = buildI18nApplicationContext(form);
  const i18nRules = i18nPromptRules(i18nContext);
  const repositoryContext = buildExistingRepositoryContext(form);
  const repositoryRules = existingRepositoryPrompt(repositoryContext);
  const repositoryImplementationRules = repositoryContext.enabled
    ? ['DÉPÔT EXISTANT: préserver la base importée.', ...repositoryContext.rules].map((rule) => `- ${rule}`).join('\n')
    : '';
  callbacks.generationState = { abandonedSteps: [] };
  callbacks.contextLedger = new ContextLedgerStore();
  const artifacts: Record<string, unknown> = { I18N_SPEC: i18nContext, EXISTING_REPOSITORY: repositoryContext.enabled ? {
    archiveName: repositoryContext.archiveName,
    fileCount: repositoryContext.fileCount,
    textFileCount: repositoryContext.textFileCount,
    binaryFileCount: repositoryContext.binaryFileCount,
    paths: repositoryContext.paths,
  } : null };
  const files = new Map<string, string>();
  const binaryFiles = new Map<string, string>();
  if (form.project.existingRepository && form.repository.archive) {
    for (const file of form.repository.archive.files) {
      if (file.encoding === 'utf8') files.set(file.path, file.content);
      else binaryFiles.set(file.path, file.content);
    }
  }
  const visualImages = form.visuals.assets.map((a) => ({ mimeType: a.mimeType, dataUrl: a.dataUrl, name: a.name }));

  emit(callbacks, 'initialisation', 'info', repositoryContext.enabled
    ? `Dépôt existant chargé : ${repositoryContext.fileCount} fichier(s) serviront de base à la génération.`
    : 'Le réseau multi-agents est embarqué localement et sera injecté par rôle.');

  const routing = await callJson<RoutingResult>(
    settings,
    ['agents/00-micro-shop-router.agent.md', 'agents/01-micro-shop-project-discovery.agent.md'],
    routingUserContent(projectInput, repositoryRules, i18nRules),
    callbacks,
    'discovery / routage',
  );
  const projectSpec = isAbandonedArtifact(routing) ? projectInput : (routing.PROJECT_SPEC ?? routing.projectSpec ?? projectInput);
  artifacts.PROJECT_SPEC = projectSpec;

  const techStack = await callJson<unknown>(
    settings,
    ['agents/02-micro-shop-technology-architect.agent.md', 'skills/technology-selection/SKILL.md', 'skills/database-ownership/SKILL.md'],
    `Produis TECH_STACK à partir de PROJECT_SPEC. Respecte les contraintes explicites et complète seulement ce qui est UNSPECIFIED. Si l’i18n est activée, choisis/configure une stratégie i18n compatible avec le framework retenu et couvrant exactement les locales demandées.\n${repositoryRules}\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}`,
    callbacks,
    'architecture technique',
  );
  artifacts.TECH_STACK = techStack;

  const implementationPlan = await callJson<unknown>(
    settings,
    ['agents/03-micro-shop-project-planner.agent.md', 'contracts/testing-contract.md', 'contracts/artifact-layout.md'],
    `Produis IMPLEMENTATION_PLAN. Il doit inclure conception, tests avant lots, SEO si activé, agentification, implémentation, validation et boucle de correction. Si l’i18n est activée, planifie explicitement la configuration, les catalogues de toutes les langues sélectionnées, l’utilisation systématique des clés dans le code et les tests de parité des clés.\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}`,
    callbacks,
    'planification',
  );
  artifacts.IMPLEMENTATION_PLAN = implementationPlan;

  if (form.visuals.assets.length || form.visuals.notes.trim()) {
    artifacts.DESIGN = await callJson<unknown>(
      settings,
      ['agents/04-micro-shop-visual-architect.agent.md', 'skills/visual-fidelity/SKILL.md'],
      `Analyse les références et produis un objet contenant DESIGN_SYSTEM et PAGE_LAYOUTS. Les images fournies sont la vérité visuelle.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}\nNotes visuelles: ${form.visuals.notes || '(aucune)'}\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}`,
      callbacks,
      'architecture visuelle',
      visualImages,
    );
  } else {
    artifacts.DESIGN = await callJson<unknown>(
      settings,
      ['agents/04-micro-shop-visual-architect.agent.md', 'skills/visual-fidelity/SKILL.md'],
      `Aucune capture n'est fournie. Conçois une direction visuelle cohérente et produis un objet contenant DESIGN_SYSTEM et PAGE_LAYOUTS.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}`,
      callbacks,
      'architecture visuelle',
    );
  }

  const rawDataModel = await callJson<DataModelArtifact>(
    settings,
    ['agents/05-micro-shop-data-architect.agent.md', 'skills/commerce-model/SKILL.md', 'skills/database-ownership/SKILL.md'],
    `Produis DATA_MODEL comme modèle logique canonique et totalement agnostique du moteur de base de données. Il doit rester strictement identique même si TECH_STACK configure des moteurs différents selon les environnements. Décris les entités/tables logiques, champs avec types conceptuels portables, identifiants, nullabilité, unicité, index logiques, contraintes métier, relations/cardinalités et hypothèses. N'inclus AUCUN champ diagram/mermaid, aucun Markdown, aucun moteur ou dialecte SQL, aucun type propriétaire (ex: SERIAL, AUTO_INCREMENT, JSONB), aucun DDL et aucune migration spécifique à SQLite/MariaDB/MySQL/PostgreSQL. Les adaptations physiques par moteur seront produites plus tard par les builders à partir de ce modèle logique.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}`,
    callbacks,
    'modèle de données',
  );
  artifacts.DATA_MODEL = stripDataModelPresentation(rawDataModel) as DataModelArtifact;

  const dataModelDiagramResult = await callJson<DataModelDiagramResult>(
    settings,
    ['agents/05-micro-shop-data-architect.agent.md', 'skills/commerce-model/SKILL.md'],
    `Convertis le DATA_MODEL logique ci-dessous en un diagramme Mermaid erDiagram fidèle. Retourne uniquement {"diagram":{"title":"Modèle de données","description":"...","mermaid":"erDiagram\n..."}}. Le diagramme doit représenter uniquement la structure logique commune à tous les moteurs et ne doit mentionner aucun environnement, moteur, dialecte SQL ou détail de migration. Le champ mermaid contient uniquement la source Mermaid, sans fence Markdown.\n${artifactMessage('DATA_MODEL', artifacts.DATA_MODEL)}`,
    callbacks,
    'diagramme de données',
  );
  if (!isAbandonedArtifact(dataModelDiagramResult)) {
    const dataModelDiagram = dataModelDiagramResult.diagram;
    const dataModelMermaid = normalizeMermaidSource(dataModelDiagram?.mermaid);
    if (!dataModelMermaid) throw new Error('Le modèle de données n\'a pas pu être converti en diagramme Mermaid.');
    persistDiagram(files, {
      id: 'data-model',
      title: dataModelDiagram?.title || 'Modèle de données',
      description: dataModelDiagram?.description || 'Structure logique et agnostique du moteur de base de données.',
      mermaid: dataModelMermaid,
    }, 'data-model');
  }

  artifacts.DOMAIN_MODEL = await callJson<unknown>(
    settings,
    ['agents/06-micro-shop-commerce-domain.agent.md', 'skills/commerce-model/SKILL.md', 'skills/promotion-engine/SKILL.md', 'skills/tax-engine/SKILL.md', 'skills/order-lifecycle/SKILL.md'],
    `Produis DOMAIN_MODEL en n'activant que les domaines présents dans PROJECT_SPEC.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('DATA_MODEL', artifacts.DATA_MODEL)}`,
    callbacks,
    'règles métier',
  );

  artifacts.SECURITY_MODEL = await callJson<unknown>(
    settings,
    ['agents/07-micro-shop-security-auth.agent.md', 'skills/payment-security/SKILL.md'],
    `Produis SECURITY_MODEL.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('DOMAIN_MODEL', artifacts.DOMAIN_MODEL)}`,
    callbacks,
    'sécurité / authentification',
  );

  artifacts.INTEGRATIONS = await callJson<unknown>(
    settings,
    relevantIntegrationPaths(form),
    `Produis INTEGRATION_PLAN et, uniquement si activés, PAYMENT_SPEC, EMAIL_SPEC et MEDIA_SPEC. Si l’i18n est activée, les contenus statiques des e-mails transactionnels et autres surfaces utilisateur des intégrations doivent être localisables dans toutes les langues sélectionnées via les mêmes clés/catalogues que l’application.\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('SECURITY_MODEL', artifacts.SECURITY_MODEL)}`,
    callbacks,
    'intégrations',
  );

  if (form.business.seo) {
    artifacts.SEO = await callJson<unknown>(
      settings,
      ['agents/08d-micro-shop-seo-engineer.agent.md'],
      `Produis SEO_SPEC et SEO_BACKOFFICE_REQUEST adaptés au projet. Si l’i18n est activée, couvre exactement les langues sélectionnées et prévois les métadonnées statiques localisées ainsi que la stratégie SEO multilingue appropriée au framework.\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('DESIGN', artifacts.DESIGN)}`,
      callbacks,
      'SEO',
    );
  }

  artifacts.AGENTIFICATION_SPEC = await callJson<unknown>(
    settings,
    ['agents/08e-micro-shop-agentification-engineer.agent.md', 'skills/project-agentification/SKILL.md', 'contracts/agentification-contract.md'],
    `Produis AGENTIFICATION_SPEC. Le générateur garantit ensuite lui-même la copie exhaustive de tous les agents/skills/contrats dans .agents/.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}`,
    callbacks,
    'agentification',
  );

  const diagramBundle = await callJson<DiagramBundle>(
    settings,
    [
      'agents/02-micro-shop-technology-architect.agent.md',
      'agents/05-micro-shop-data-architect.agent.md',
      'agents/06-micro-shop-commerce-domain.agent.md',
      'agents/07-micro-shop-security-auth.agent.md',
      'agents/08-micro-shop-integrations-router.agent.md',
    ],
    `Produis uniquement les diagrammes réellement utiles pour documenter le projet. Retourne {"diagrams":[{"id":"architecture","title":"Architecture applicative","description":"...","mermaid":"flowchart TD\n..."}]}. Utilise Mermaid uniquement. Ne duplique pas le diagramme de données déjà produit par DATA_MODEL. Les diagrammes possibles selon pertinence : architecture applicative, flux d'authentification, checkout/paiement, cycle de commande, intégrations, composants. Chaque champ mermaid contient uniquement la source Mermaid, sans bloc Markdown. Maximum 7 diagrammes.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('DATA_MODEL', artifacts.DATA_MODEL)}${artifactMessage('DOMAIN_MODEL', artifacts.DOMAIN_MODEL)}${artifactMessage('SECURITY_MODEL', artifacts.SECURITY_MODEL)}${artifactMessage('INTEGRATIONS', artifacts.INTEGRATIONS)}`,
    callbacks,
    'diagrammes Mermaid',
  );
  const generatedDiagrams = Array.isArray(diagramBundle.diagrams) ? diagramBundle.diagrams.slice(0, 7) : [];
  for (const [index, diagram] of generatedDiagrams.entries()) {
    if (!diagram || typeof diagram.mermaid !== 'string') continue;
    persistDiagram(files, diagram, `diagram-${index + 1}`);
  }
  artifacts.DIAGRAMS = generatedDiagrams;

  artifacts.TEST_PLAN = await callJson<unknown>(
    settings,
    ['agents/13b-micro-shop-testing-engineer.agent.md', 'skills/testing-engineer/SKILL.md', 'contracts/testing-contract.md'],
    `Produis TEST_PLAN avant implémentation. Tu ne peux pas exécuter les futurs tests dans ce navigateur : planifie les tests exécutables et marque toute preuve d'exécution comme pending. Si l’i18n est activée, ajoute obligatoirement des tests garantissant que chaque langue sélectionnée possède exactement le même ensemble de clés et que les principaux écrans n’embarquent pas de wording statique à la place de clés i18n.\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('IMPLEMENTATION_PLAN', implementationPlan)}${artifactMessage('DOMAIN_MODEL', artifacts.DOMAIN_MODEL)}${artifactMessage('SECURITY_MODEL', artifacts.SECURITY_MODEL)}`,
    callbacks,
    'plan de tests',
  );

  const buildPlan = await callJson<BuildPlan>(
    settings,
    ['agents/09-micro-shop-implementation-orchestrator.agent.md', 'contracts/artifact-layout.md'],
    `Prépare un plan de génération de fichiers concret, borné et ordonné. Réponds {"batches":[{"id":"B1","objective":"...","owner":"frontoffice-builder|backoffice-builder|backend-builder|implementation-orchestrator","files":["path"],"contextPaths":["path déjà généré utile"]}],"i18n":{"enabled":true,"defaultLocale":"fr","locales":[{"code":"fr","resourceFiles":["path"]}],"configFiles":["path"],"verificationFiles":["path"]},"notes":[]}. Si l’i18n est désactivée, utilise {"enabled":false,"locales":[]}. Si elle est activée, i18n.defaultLocale doit être EXACTEMENT la langue par défaut de I18N_SPEC et doit appartenir à i18n.locales ; i18n.locales doit contenir EXACTEMENT toutes les langues de I18N_SPEC, chacune avec au moins un resourceFiles réellement prévu dans batches ; un même fichier peut être partagé par plusieurs locales si le framework stocke plusieurs catalogues dans un module unique. Prévois également la configuration i18n et au moins un test de parité/complétude des clés. Maximum ${form.output.maxBatches} lots, maximum 14 fichiers par lot. Chaque fichier de code, config, documentation et test nécessaire doit apparaître exactement une fois dans files, sauf modification ultérieure explicitement nécessaire. DATA_MODEL est un modèle logique unique et agnostique du moteur : ne crée jamais un data-model différent par environnement. Si TECH_STACK utilise plusieurs moteurs selon les environnements, prévois seulement les fichiers physiques nécessaires (configuration, adaptateurs, migrations) séparément par moteur/environnement, tous conformes au même DATA_MODEL, sans mélanger plusieurs dialectes SQL dans un même fichier. Tout diagramme documentaire doit être un fichier .md contenant un bloc Mermaid ; n'inclus jamais de .puml, .plantuml, .dot, .gv, .mmd ni d'image de diagramme. Aucun Markdown ne doit apparaître dans un fichier non-.md. Les diagrammes canoniques déjà produits dans .ai/diagrams/ ne doivent pas être recréés.\n${repositoryRules}\n${i18nRules}${artifactMessage('I18N_SPEC', i18nContext)}${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('IMPLEMENTATION_PLAN', implementationPlan)}${artifactMessage('DESIGN', artifacts.DESIGN)}${artifactMessage('DATA_MODEL', artifacts.DATA_MODEL)}${artifactMessage('DOMAIN_MODEL', artifacts.DOMAIN_MODEL)}${artifactMessage('SECURITY_MODEL', artifacts.SECURITY_MODEL)}${artifactMessage('INTEGRATIONS', artifacts.INTEGRATIONS)}${artifactMessage('SEO', artifacts.SEO ?? null)}${artifactMessage('TEST_PLAN', artifacts.TEST_PLAN)}${artifactMessage('DIAGRAMS', artifacts.DIAGRAMS)}\nINSTRUCTIONS SUPPLÉMENTAIRES UTILISATEUR:\n${form.output.extraInstructions || '(aucune)'}`,
    callbacks,
    'plan de génération',
  );
  artifacts.BUILD_PLAN = buildPlan;
  const buildPlanAbandoned = isAbandonedArtifact(buildPlan);
  if (!buildPlanAbandoned) assertI18nBuildPlan(buildPlan, i18nContext);

  const batches = buildPlanAbandoned ? [] : safeBatches(buildPlan, form.output.maxBatches);
  if (!buildPlanAbandoned && !batches.length) throw new Error("Le modèle n'a produit aucun lot de génération exploitable.");
  if (!buildPlanAbandoned) assertI18nResourcesScheduled(buildPlan, i18nContext, batches);

  for (const [batchIndex, batch] of batches.entries()) {
    assertNotAborted(callbacks.signal);
    const agentPath = ownerAgent(batch.owner);
    const systemPaths = [
      'agents/09-micro-shop-implementation-orchestrator.agent.md',
      agentPath,
      'agents/13b-micro-shop-testing-engineer.agent.md',
    ];

    emit(
      callbacks,
      `lot ${batch.id}`,
      'info',
      `${batch.files.length} fichier(s) seront générés via ${batch.files.length} appel(s) IA séparé(s).`,
    );

    for (const [fileIndex, requestedPath] of batch.files.entries()) {
      assertNotAborted(callbacks.signal);
      const safePath = sanitizeGeneratedPath(requestedPath);
      if (!safePath) {
        emit(callbacks, `lot ${batch.id}`, 'info', `Fichier ignoré car chemin non autorisé: ${requestedPath}`);
        continue;
      }

      const contextFiles = (batch.contextPaths ?? [])
        .filter((path) => path !== safePath)
        .map((path) => files.has(path) ? `\n===== FICHIER EXISTANT ${path} =====\n${files.get(path)}` : '')
        .filter(Boolean)
        .join('\n');

      const generatedInBatch = batch.files
        .slice(0, fileIndex)
        .map((path) => sanitizeGeneratedPath(path))
        .filter((path): path is string => Boolean(path && files.has(path)));

      const existingTarget = repositoryContext.enabled && files.has(safePath) ? files.get(safePath) ?? '' : '';
      const existingTargetContext = existingTarget
        ? `\n===== CONTENU ACTUEL À PRÉSERVER/MODIFIER ${safePath} =====\n${existingTarget}\n===== FIN CONTENU ACTUEL =====\n`
        : '';

      const stage = `implémentation ${batch.id} · ${fileIndex + 1}/${batch.files.length}`;
      const content = await callFileContent(
        settings,
        systemPaths,
        `Implémente uniquement le fichier ${safePath}.\n\n` +
        `Lot: ${batch.id} (${batchIndex + 1}/${batches.length})\n` +
        `Objectif du lot: ${batch.objective}\n` +
        `Responsable logique: ${batch.owner}\n` +
        `Fichiers prévus dans ce lot: ${stableJson(batch.files)}\n` +
        `Fichiers de ce lot déjà générés: ${stableJson(generatedInBatch)}\n\n` +
        `Contraintes impératives:\n` +
        `- retourne uniquement le contenu complet de ${safePath};\n` +
        `- aucun JSON englobant, aucune fence Markdown ajoutée artificiellement, aucune explication avant/après;\n` +
        `- code/config/documentation complet, sans TODO de substitution, sans ellipse;\n` +
        (repositoryContext.enabled ? `- le ZIP importé est la base du projet : préserve les conventions et comportements existants non concernés ; si ${safePath} existe déjà, modifie-le à partir de son contenu actuel au lieu de le réinventer.\n` : '') +
        `- respecte le TEST_PLAN et les conventions du projet;\n` +
        `- ne prétends pas avoir exécuté les tests;\n` +
        `- si ce fichier est un .md et contient un diagramme documentaire, utilise Markdown + Mermaid uniquement;\n` +
        `- si ce fichier n'est PAS un .md, son contenu doit être exclusivement dans son format natif : aucun Markdown, aucune fence Markdown, aucune source Mermaid;\n` +
        `- DATA_MODEL est commun à tous les environnements. Si ce fichier est spécifique à une base de données, n'utilise que le dialecte du moteur ciblé par cet environnement et ne mélange jamais plusieurs moteurs dans le même fichier.\n` +        (i18nContext.enabled
          ? `- INTERNATIONALISATION OBLIGATOIRE: tous les wordings statiques visibles par l’utilisateur doivent utiliser des clés i18n dans le code ; aucune chaîne UI brute. Chaque clé doit être traduite dans toutes les langues sélectionnées: ${i18nContext.locales.join(', ')}. Les catalogues doivent partager exactement les mêmes clés.\n`
          : '') +
        `${repositoryImplementationRules}\n` +
        `${artifactMessage('I18N_SPEC', i18nContext)}` +
        `${artifactMessage('PROJECT_SPEC', projectSpec)}` +
        `${artifactMessage('TECH_STACK', techStack)}` +
        `${artifactMessage('DOMAIN_MODEL', artifacts.DOMAIN_MODEL)}` +
        `${artifactMessage('SECURITY_MODEL', artifacts.SECURITY_MODEL)}` +
        `${artifactMessage('DESIGN', artifacts.DESIGN)}` +
        `${artifactMessage('INTEGRATIONS', artifacts.INTEGRATIONS)}` +
        `${artifactMessage('SEO', artifacts.SEO ?? null)}` +
        `${artifactMessage('TEST_PLAN', artifacts.TEST_PLAN)}` +
        `${artifactMessage('DIAGRAMS', artifacts.DIAGRAMS)}` +
        existingTargetContext +
        contextFiles,
        callbacks,
        stage,
        safePath,
        i18nRules,
      );

      if (content === null) continue;

      // Sauvegarde immédiate : si un fichier suivant échoue, les fichiers déjà
      // terminés restent disponibles dans l'état courant de la génération.
      files.set(safePath, content);
      binaryFiles.delete(safePath);
    }
  }

  if (!buildPlanAbandoned) assertGeneratedI18nResources(buildPlan, i18nContext, files);

  artifacts.GENERATION_STATE = callbacks.generationState;
  files.set('.ai/generation-state.json', stableJson(callbacks.generationState));

  // JSON est valide en YAML 1.2 : on conserve ainsi des artefacts structurés
  // déterministes tout en respectant les chemins canoniques du réseau.
  files.set('.ai/project-spec.yaml', stableJson(projectSpec));
  files.set('.ai/i18n-spec.yaml', stableJson(i18nContext));
  files.set('.ai/technology-stack.yaml', stableJson(techStack));
  files.set('.ai/implementation-plan.yaml', stableJson(implementationPlan));
  files.set('.ai/design-system.yaml', stableJson(artifacts.DESIGN));
  files.set('.ai/page-layouts.yaml', stableJson(artifacts.DESIGN));
  files.set('.ai/data-model.yaml', stableJson(artifacts.DATA_MODEL));
  files.set('.ai/commerce-domain.yaml', stableJson(artifacts.DOMAIN_MODEL));
  files.set('.ai/security-model.yaml', stableJson(artifacts.SECURITY_MODEL));
  files.set('.ai/integrations.yaml', stableJson(artifacts.INTEGRATIONS));
  if (artifacts.SEO) {
    files.set('.ai/seo-spec.yaml', stableJson(artifacts.SEO));
    files.set('.ai/seo-backoffice-request.yaml', stableJson(artifacts.SEO));
  }
  files.set('.ai/agentification-spec.yaml', stableJson(artifacts.AGENTIFICATION_SPEC));
  files.set('.ai/test-plan.yaml', stableJson(artifacts.TEST_PLAN));
  files.set('.ai/build-plan.yaml', stableJson(buildPlan));
  const diagramFiles = [...files.keys()].filter((path) => path.startsWith('.ai/diagrams/') && path.endsWith('.md')).sort();
  files.set('.ai/diagrams/README.md', `# Diagrammes du projet\n\nTous les diagrammes de ce projet sont versionnés en **Markdown + Mermaid**. Les fichiers SVG/PNG, PlantUML, Graphviz/DOT et \`.mmd\` ne constituent pas des sources de diagramme autorisées.\n\n${diagramFiles.map((path) => `- [${path.split('/').pop()?.replace(/\.md$/, '')}](${path.split('/').pop()})`).join('\n')}\n`);

  if (!files.has('.ai/testing/rapport-validation.md')) {
    files.set('.ai/testing/rapport-validation.md', '# Rapport de validation\n\nStatut : **PENDING**.\n\nLe générateur navigateur a produit le code et les tests mais ne peut pas exécuter le dépôt final. Exécuter localement les commandes documentées dans `AGENTS.md` et mettre à jour ce rapport avec les preuves réelles.\n');
  }

  ensureAgentification(files);

  const embedded = embeddedNetworkFiles();
  const agentificationResult = {
    canonical_file: 'AGENTS.md',
    adapters_created: [
      'CLAUDE.md',
      'GEMINI.md',
      '.github/copilot-instructions.md',
      '.junie/AGENTS.md',
      '.cursor/rules/00-project.mdc',
      '.roo/rules/00-project.md',
      '.windsurf/rules/00-project.md',
    ],
    embedded: {
      agents: embedded.filter((f) => f.path.startsWith('.agents/agents/')).map((f) => f.path),
      skills: embedded.filter((f) => f.path.startsWith('.agents/skills/')).map((f) => f.path),
      contracts: embedded.filter((f) => f.path.startsWith('.agents/contracts/')).map((f) => f.path),
    },
    manifest: '.agents/manifest.yaml',
    checks: {
      required_files_present: true,
      all_source_agents_copied: true,
      all_source_skills_copied: true,
      all_source_contracts_copied: true,
      adapters_consistent: true,
      no_secrets_detected: null,
    },
    remaining_issues: ['Exécuter localement tests, couverture, QA et revues de sécurité/SEO avant validation finale.'],
  };
  artifacts.AGENTIFICATION_RESULT = agentificationResult;
  files.set('.ai/agentification-result.yaml', stableJson(agentificationResult));

  const fileManifest = [...new Set([...files.keys(), ...binaryFiles.keys()])].sort();
  const report = await callJson<unknown>(
    settings,
    ['agents/16-micro-shop-final-reporter.agent.md'],
    `Produis le compte rendu final de génération avant validation runtime. À ce stade, marque les tests/validations comme PENDING : l'application hôte exécutera ensuite les commandes réellement supportées dans ses runtimes navigateur. Indique les commandes à exécuter, les fichiers générés et les points à valider sans inventer de résultat.\n${artifactMessage('PROJECT_SPEC', projectSpec)}${artifactMessage('TECH_STACK', techStack)}${artifactMessage('I18N_SPEC', i18nContext)}\nFICHIERS GÉNÉRÉS:\n${stableJson(fileManifest)}`,
    callbacks,
    'rapport final',
  );
  artifacts.FINAL_REPORT = report;
  files.set('.ai/final-report.json', stableJson(report));

  for (const contextFile of callbacks.contextLedger?.toFiles() ?? []) {
    files.set(contextFile.path, contextFile.content);
  }
  if (callbacks.contextLedger?.entries.length) {
    artifacts.CONTEXT_LEDGER = {
      strategy: 'map-reduce-context-ledger',
      entries: callbacks.contextLedger.entries.map(({ ledger, ...entry }) => entry),
    };
  }

  emit(callbacks, 'terminé', 'done', `${files.size + [...binaryFiles.keys()].filter((path) => !files.has(path)).length} fichiers préparés.`);
  return {
    files: [
      ...[...files.entries()].map(([path, content]) => ({ path, content, encoding: 'utf8' as const })),
      ...[...binaryFiles.entries()]
        .filter(([path]) => !files.has(path))
        .map(([path, content]) => ({ path, content, encoding: 'base64' as const })),
    ],
    artifacts,
    report,
  };
}

export async function resultToZip(result: GenerationResult): Promise<Blob> {
  const zip = new JSZip();
  for (const file of result.files) {
    if (file.encoding === 'base64') zip.file(file.path, file.content, { base64: true });
    else zip.file(file.path, file.content);
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
