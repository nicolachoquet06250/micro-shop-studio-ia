<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import AppShell from './AppShell.vue';
import GenerationResultView from './GenerationResultView.vue';
import ModalShell from './ModalShell.vue';
import PreviewModal from './PreviewModal.vue';
import ValidationModal from './ValidationModal.vue';
import AiInspectorView from './AiInspectorView.vue';
import StudioIcon from './StudioIcon.vue';
import { createDefaultForm } from '../lib/defaultForm';
import { ISO_639_1_LANGUAGE_CODES } from '../lib/languages';
import { buildInitialPromptPreview, generateShop, GenerationStepController, resultToZip, type GenerationStepState, type GenerationStreamEvent } from '../lib/generation';
import { parseExistingRepositoryZip } from '../lib/repositoryArchive';
import { useSettingsStore } from '../stores/settings';
import {
  disposeValidationRuntime,
  runValidationLoop,
  startValidationPreview,
  type PreviewSessionInfo,
  type ValidationEvent,
  type ValidationLoopOutcome,
} from '../lib/validation';
import type { AiCallTrace, AiCallTraceEvent, AiPromptPreview, GenerationLog, GenerationResult, VisualAsset } from '../types/generator';

const settings = useSettingsStore();
const form = reactive(createDefaultForm());
const activeSection = ref('project');
const generating = ref(false);
const logs = ref<GenerationLog[]>([]);
const result = ref<GenerationResult | null>(null);
const error = ref('');
const abortController = ref<AbortController | null>(null);
const stepController = new GenerationStepController();
const activeGenerationStep = ref<string | null>(null);
const stepActionPending = ref<null | 'restart' | 'abandon'>(null);
const liveStreamStage = ref('');
const liveStreamPreview = ref('');
const liveReasoningPreview = ref('');
const liveReasoningChars = ref(0);
const liveStreamChars = ref(0);
const liveStreamActive = ref(false);
const languageSearch = ref('');
const repositoryAnalyzing = ref(false);
const repositoryError = ref('');
const validating = ref(false);
const workspaceElement = ref<HTMLElement | null>(null);
const topbarSticky = ref(true);
let stickyPhaseFrame: number | null = null;
const validationOutcome = ref<ValidationLoopOutcome | null>(null);
const validationEvents = ref<ValidationEvent[]>([]);
const validationTerminal = ref('');
const validationAbortController = ref<AbortController | null>(null);
const resultModalOpen = ref(false);
const validationModalOpen = ref(false);
const previewModalOpen = ref(false);
const previewLoading = ref(false);
const previewInfo = ref<PreviewSessionInfo | null>(null);
const previewOutput = ref('');
const previewError = ref('');
const aiInspectorOpen = ref(false);
const aiTraces = ref<AiCallTrace[]>([]);
const selectedAiTraceId = ref<string | null>(null);
const aiInspectorStageFilter = ref<string | null>(null);
const isLocalEnvironment = ref(false);
const formPersistenceMessage = ref('');
let formPersistenceMessageTimer: number | null = null;

const FORM_STORAGE_PREFIX = 'micro-shop-generator:form:';
const FORM_STORAGE_KEYS = {
  project: `${FORM_STORAGE_PREFIX}project`,
  business: `${FORM_STORAGE_PREFIX}business`,
  technical: `${FORM_STORAGE_PREFIX}technical`,
  security: `${FORM_STORAGE_PREFIX}security`,
  integrations: `${FORM_STORAGE_PREFIX}integrations`,
  visuals: `${FORM_STORAGE_PREFIX}visuals`,
  repository: `${FORM_STORAGE_PREFIX}repository`,
  output: `${FORM_STORAGE_PREFIX}output`,
} as const;

type PersistedFormSection = keyof typeof FORM_STORAGE_KEYS;

function currentAiSettings() {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    temperature: settings.temperature,
    reasoningStrategy: settings.reasoningStrategy,
  };
}

const initialPromptPreview = computed<AiPromptPreview | null>(() => {
  try {
    return buildInitialPromptPreview(form, currentAiSettings());
  } catch {
    return null;
  }
});

const VALIDATION_STAGE = 'Tests / validation';

function canonicalStage(stage: string) {
  return stage.replace(/\s+·\s+fragment\s+\d+$/i, '').trim();
}

function isValidationStage(stage: string) {
  return canonicalStage(stage) === VALIDATION_STAGE;
}

function validationHasBlockingFailure() {
  return validationOutcome.value?.status === 'failed' || validationOutcome.value?.status === 'unsupported';
}

function openResultModal() {
  if (!result.value) return;
  validationModalOpen.value = false;
  previewModalOpen.value = false;
  aiInspectorOpen.value = false;
  resultModalOpen.value = true;
}

function openValidationModal() {
  if (!result.value) return;
  resultModalOpen.value = false;
  previewModalOpen.value = false;
  aiInspectorOpen.value = false;
  validationModalOpen.value = true;
}

function upsertGenerationLog(entry: GenerationLog) {
  const stage = canonicalStage(entry.stage);
  const index = logs.value.findIndex((candidate) => canonicalStage(candidate.stage) === stage);

  if (index < 0) {
    logs.value.push({ ...entry, stage });
    return;
  }

  const current = logs.value[index];
  const status = entry.status === 'info'
    ? current.status
    : entry.status;

  logs.value[index] = {
    ...current,
    ...entry,
    id: current.id,
    stage,
    status,
  };
}

function tracesForStage(stage: string) {
  const canonical = canonicalStage(stage);
  return aiTraces.value.filter((trace) => {
    const traceStage = canonicalStage(trace.stage);
    return traceStage === canonical || trace.stage.startsWith(`${canonical} ·`);
  });
}

function canInspectLog(log: GenerationLog) {
  if (isValidationStage(log.stage)) return log.status !== 'running' && Boolean(result.value);
  return (log.status === 'done' || log.status === 'error') && tracesForStage(log.stage).length > 0;
}

function openLogDetails(log: GenerationLog) {
  if (!canInspectLog(log)) return;
  if (isValidationStage(log.stage)) {
    openValidationModal();
    return;
  }
  openAiInspector(log.stage);
}

function handleAiTrace(event: AiCallTraceEvent) {
  const trace = event.trace;
  const index = aiTraces.value.findIndex((candidate) => candidate.id === trace.id);
  if (index >= 0) aiTraces.value[index] = trace;
  else aiTraces.value.push(trace);
  if (aiTraces.value.length > 600) aiTraces.value.splice(0, aiTraces.value.length - 600);

  if (event.type === 'prepared') {
    liveStreamStage.value = trace.stage;
    liveReasoningPreview.value = '';
    liveReasoningChars.value = 0;
    liveStreamActive.value = true;
    if (aiInspectorOpen.value && !selectedAiTraceId.value) selectedAiTraceId.value = trace.id;
  }

  if (event.type === 'streaming' || event.type === 'done') {
    liveStreamStage.value = trace.stage;
    liveReasoningChars.value = trace.reasoningChars;
    if (trace.reasoning) liveReasoningPreview.value = trace.reasoning.slice(-7000);
  }

  if (event.type === 'error') {
    const stage = canonicalStage(trace.stage);
    const existing = logs.value.find((candidate) => canonicalStage(candidate.stage) === stage);
    upsertGenerationLog({
      id: existing?.id ?? crypto.randomUUID(),
      at: new Date().toISOString(),
      stage,
      status: 'error',
      message: trace.error || 'L’appel IA a échoué.',
    });
  }

  if (event.type === 'done' || event.type === 'error') liveStreamActive.value = false;
}

function openAiInspector(stage?: string) {
  aiInspectorStageFilter.value = stage || null;
  const matching = stage
    ? tracesForStage(stage)
    : aiTraces.value;
  selectedAiTraceId.value = matching.at(-1)?.id ?? null;
  aiInspectorOpen.value = true;
}

function showPersistenceMessage(message: string) {
  formPersistenceMessage.value = message;
  if (formPersistenceMessageTimer !== null) window.clearTimeout(formPersistenceMessageTimer);
  formPersistenceMessageTimer = window.setTimeout(() => {
    formPersistenceMessage.value = '';
    formPersistenceMessageTimer = null;
  }, 3200);
}

function isLocalHostname(hostname: string) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost');
}

function sectionValue(section: PersistedFormSection): unknown {
  return form[section];
}

function saveSection(section: PersistedFormSection, value: unknown) {
  localStorage.setItem(FORM_STORAGE_KEYS[section], JSON.stringify(value));
}

function saveFormData() {
  if (!isLocalEnvironment.value) return;

  let uploadsExcluded = false;
  const regularSections: PersistedFormSection[] = [
    'project',
    'business',
    'technical',
    'security',
    'integrations',
    'output',
  ];

  try {
    for (const section of regularSections) saveSection(section, sectionValue(section));

    try {
      saveSection('visuals', form.visuals);
    } catch {
      uploadsExcluded = uploadsExcluded || form.visuals.assets.length > 0;
      saveSection('visuals', { ...form.visuals, assets: [] });
    }

    try {
      saveSection('repository', form.repository);
    } catch {
      uploadsExcluded = uploadsExcluded || Boolean(form.repository.archive);
      saveSection('repository', { ...form.repository, archive: null });
    }

    showPersistenceMessage(
      uploadsExcluded
        ? 'Données enregistrées. Les uploads trop volumineux devront être rechargés.'
        : 'Données du formulaire enregistrées localement.',
    );
  } catch (err) {
    showPersistenceMessage(`Impossible d’enregistrer les données : ${err instanceof Error ? err.message : String(err)}`);
  }
}

function restoreSavedFormData() {
  if (!isLocalEnvironment.value) return;
  let restored = false;

  for (const section of Object.keys(FORM_STORAGE_KEYS) as PersistedFormSection[]) {
    const raw = localStorage.getItem(FORM_STORAGE_KEYS[section]);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        Object.assign(form[section], parsed);
        restored = true;
      }
    } catch {
      // Une clé corrompue ne doit pas empêcher la restauration des autres sections.
    }
  }

  if (restored) showPersistenceMessage('Données enregistrées restaurées.');
}

function clearSavedFormData() {
  if (!isLocalEnvironment.value) return;
  for (const key of Object.values(FORM_STORAGE_KEYS)) localStorage.removeItem(key);
  showPersistenceMessage('Données enregistrées supprimées. Le formulaire courant est conservé.');
}

const languageDisplayNames = new Intl.DisplayNames(['fr'], { type: 'language' });
const languages = ISO_639_1_LANGUAGE_CODES
  .map((code) => ({
    code,
    label: languageDisplayNames.of(code) || code.toUpperCase(),
  }))
  .sort((a, b) => a.label.localeCompare(b.label, 'fr', { sensitivity: 'base' }));

const filteredLanguages = computed(() => {
  const query = languageSearch.value.trim().toLocaleLowerCase('fr');
  if (!query) return languages;
  return languages.filter((language) =>
    language.code.includes(query) || language.label.toLocaleLowerCase('fr').includes(query),
  );
});

const selectedLanguages = computed(() =>
  form.business.locales
    .map((code) => languages.find((language) => language.code === code) ?? { code, label: code.toUpperCase() })
);

function setLanguage(code: string, checked: boolean) {
  if (checked) {
    if (!form.business.locales.includes(code)) form.business.locales.push(code);
    if (!form.business.locales.includes(form.business.defaultLocale)) form.business.defaultLocale = code;
    return;
  }
  const index = form.business.locales.indexOf(code);
  if (index >= 0) form.business.locales.splice(index, 1);
  if (form.business.defaultLocale === code) {
    form.business.defaultLocale = form.business.locales.includes('fr')
      ? 'fr'
      : (form.business.locales[0] ?? '');
  }
}

function onLanguageChange(code: string, event: Event) {
  setLanguage(code, (event.target as HTMLInputElement).checked);
}

watch(() => form.business.internationalization, (enabled) => {
  if (enabled && form.business.locales.length === 0) {
    form.business.locales = ['fr', 'en'];
    form.business.defaultLocale = 'fr';
  }
  if (enabled && !form.business.locales.includes(form.business.defaultLocale)) {
    form.business.defaultLocale = form.business.locales.includes('fr') ? 'fr' : (form.business.locales[0] ?? '');
  }
});

watch(() => [...form.business.locales], (locales) => {
  if (!locales.includes(form.business.defaultLocale)) {
    form.business.defaultLocale = locales.includes('fr') ? 'fr' : (locales[0] ?? '');
  }
});

const businessToggles = [
  { key: 'products', label: 'Produits' },
  { key: 'variants', label: 'Variantes' },
  { key: 'stock', label: 'Stock' },
  { key: 'customers', label: 'Clients' },
  { key: 'cart', label: 'Panier' },
  { key: 'checkout', label: 'Checkout' },
  { key: 'orders', label: 'Commandes' },
  { key: 'delivery', label: 'Livraison' },
  { key: 'discounts', label: 'Promotions' },
  { key: 'promoCodes', label: 'Codes promo' },
  { key: 'taxes', label: 'Taxes' },
  { key: 'admin', label: 'Back-office' },
  { key: 'mediaManagement', label: 'Médiathèque' },
  { key: 'seo', label: 'SEO' },
] as const;

function setBusinessToggle(key: (typeof businessToggles)[number]['key'], event: Event) {
  form.business[key] = (event.target as HTMLInputElement).checked;
}

const sections = [
  ['project', 'Projet'],
  ['business', 'Fonctionnel'],
  ['technical', 'Technique'],
  ['security', 'Sécurité'],
  ['integrations', 'Intégrations'],
  ['visuals', 'Visuels'],
  ['repository', 'Dépôt existant'],
  ['output', 'Génération'],
] as const;

const currentSectionIndex = computed(() => Math.max(0, sections.findIndex(([key]) => key === activeSection.value)));
const hasPreviousSection = computed(() => currentSectionIndex.value > 0);
const hasNextSection = computed(() => currentSectionIndex.value < sections.length - 1);

function goToPreviousSection() {
  if (!hasPreviousSection.value) return;
  activeSection.value = sections[currentSectionIndex.value - 1][0];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function goToNextSection() {
  if (!hasNextSection.value) return;
  activeSection.value = sections[currentSectionIndex.value + 1][0];
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function clearCurrentSection() {
  const defaults = createDefaultForm();
  const key = activeSection.value as keyof typeof defaults;
  if (key in defaults && typeof defaults[key] === 'object' && defaults[key] !== null) {
    Object.assign(form[key] as object, defaults[key] as object);
  }
}

const settingsReady = computed(() => settings.ready);
const projectReady = computed(() => Boolean(form.project.name.trim() && form.project.description.trim()));
const i18nReady = computed(() => !form.business.internationalization || (
  form.business.locales.length > 0 && form.business.locales.includes(form.business.defaultLocale)
));
const repositoryReady = computed(() => !form.project.existingRepository || Boolean(form.repository.archive));
const canGenerate = computed(() => settingsReady.value && projectReady.value && i18nReady.value && repositoryReady.value && !generating.value && !validating.value);
const doneLogs = computed(() => logs.value.filter((l) => l.status === 'done').length);
const validationStatusLabel = computed(() => {
  if (validating.value) return 'Validation en cours';
  if (!validationOutcome.value) return result.value ? 'À lancer' : '—';
  if (validationOutcome.value.status === 'passed') return 'PASS';
  if (validationOutcome.value.status === 'partial') return 'PASS partiel';
  if (validationOutcome.value.status === 'failed') return 'FAIL';
  return 'Non supportée';
});
const previewAvailable = computed(() => Boolean(validationOutcome.value?.previewAvailable));

function slugify(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function onNameBlur() {
  if (!form.output.projectSlug) form.output.projectSlug = slugify(form.project.name);
}

async function addVisualFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const asset: VisualAsset = {
      id: crypto.randomUUID(),
      name: file.name,
      mimeType: file.type,
      dataUrl,
      target: 'frontoffice',
      viewport: 'unknown',
      theme: 'unknown',
      page: '',
    };
    form.visuals.assets.push(asset);
  }
  input.value = '';
}

function removeVisual(id: string) {
  const index = form.visuals.assets.findIndex((a) => a.id === id);
  if (index >= 0) form.visuals.assets.splice(index, 1);
}

async function addRepositoryZip(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  repositoryAnalyzing.value = true;
  repositoryError.value = '';
  try {
    const archive = await parseExistingRepositoryZip(file);
    form.repository.archive = archive;
    if (!form.repository.packageManager && archive.detected.packageManager) form.repository.packageManager = archive.detected.packageManager;
    if (!form.repository.lockfile && archive.detected.lockfile) form.repository.lockfile = archive.detected.lockfile;
    if (!form.repository.scripts && archive.detected.scripts) form.repository.scripts = archive.detected.scripts;
    if (!form.repository.existingStack && archive.detected.existingStack) form.repository.existingStack = archive.detected.existingStack;
  } catch (err) {
    form.repository.archive = null;
    repositoryError.value = err instanceof Error ? err.message : String(err);
  } finally {
    repositoryAnalyzing.value = false;
    input.value = '';
  }
}

function removeRepositoryZip() {
  form.repository.archive = null;
  repositoryError.value = '';
}

function onStream(event: GenerationStreamEvent) {
  if (event.phase === 'start') {
    liveStreamStage.value = event.stage;
    liveStreamPreview.value = '';
    liveReasoningPreview.value = '';
    liveReasoningChars.value = 0;
    liveStreamChars.value = 0;
    liveStreamActive.value = true;
    return;
  }

  liveStreamStage.value = event.stage;
  liveStreamChars.value = event.receivedChars;

  if (event.reasoningDelta) {
    liveReasoningPreview.value = (liveReasoningPreview.value + event.reasoningDelta).slice(-7000);
    liveReasoningChars.value = event.receivedReasoningChars ?? liveReasoningPreview.value.length;
  }

  if (event.delta) {
    // Le contenu final reste reconstitué pour l'inspecteur, mais le panneau live
    // privilégie volontairement le reasoning demandé par l'utilisateur.
    liveStreamPreview.value = (liveStreamPreview.value + event.delta).slice(-5000);
  }

  if (event.phase === 'done') liveStreamActive.value = false;
}

function appendValidationEvent(event: ValidationEvent) {
  validationEvents.value.push(event);
  if (validationEvents.value.length > 800) validationEvents.value.splice(0, validationEvents.value.length - 800);
  const prefix = event.runtime ? `[${event.runtime}] ` : '';
  if (event.type === 'output') validationTerminal.value = (validationTerminal.value + event.message).slice(-250_000);
  else validationTerminal.value = (validationTerminal.value + `\n${prefix}${event.message}\n`).slice(-250_000);
}

async function validateCurrentResult() {
  if (!result.value || validating.value) return;

  const validationLogId = logs.value.find((entry) => isValidationStage(entry.stage))?.id ?? crypto.randomUUID();
  upsertGenerationLog({
    id: validationLogId,
    at: new Date().toISOString(),
    stage: VALIDATION_STAGE,
    status: 'running',
    message: 'Exécution des tests et validations disponibles…',
  });

  validating.value = true;
  validationOutcome.value = null;
  validationEvents.value = [];
  validationTerminal.value = '';
  previewInfo.value = null;
  previewError.value = '';
  validationAbortController.value = new AbortController();

  try {
    const outcome = await runValidationLoop(
      result.value,
      currentAiSettings(),
      {
        signal: validationAbortController.value.signal,
        onEvent: appendValidationEvent,
        onProjectUpdate(updated) { result.value = updated; },
        onAiTrace: handleAiTrace,
      },
      5,
    );

    validationOutcome.value = outcome;
    result.value = outcome.result;

    const failed = outcome.status === 'failed' || outcome.status === 'unsupported';
    upsertGenerationLog({
      id: validationLogId,
      at: new Date().toISOString(),
      stage: VALIDATION_STAGE,
      status: 'done',
      message: failed
        ? `Validation terminée avec échec non bloquant : ${outcome.message}`
        : outcome.message,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendValidationEvent({ at: new Date().toISOString(), type: 'error', message });

    // Une panne du runner ou du fix-coordinator ne doit jamais invalider le projet généré.
    validationOutcome.value = {
      status: 'failed',
      result: result.value,
      attempts: validationOutcome.value?.attempts ?? [],
      unsupported: validationOutcome.value?.unsupported ?? [],
      previewAvailable: false,
      previewRuntime: null,
      message,
    };

    upsertGenerationLog({
      id: validationLogId,
      at: new Date().toISOString(),
      stage: VALIDATION_STAGE,
      status: 'done',
      message: `Validation interrompue sans bloquer le projet : ${message}`,
    });
  } finally {
    validating.value = false;
    validationAbortController.value = null;
  }
}

async function startGeneration() {
  if (!canGenerate.value) return;
  // Le résultat précédent reste accessible jusqu'au clic effectif sur "Lancer une nouvelle génération".
  await disposeValidationRuntime();
  generating.value = true;
  logs.value = [];
  aiTraces.value = [];
  selectedAiTraceId.value = null;
  aiInspectorStageFilter.value = null;
  result.value = null;
  validationOutcome.value = null;
  validationEvents.value = [];
  validationTerminal.value = '';
  previewInfo.value = null;
  previewOutput.value = '';
  previewError.value = '';
  resultModalOpen.value = false;
  validationModalOpen.value = false;
  previewModalOpen.value = false;
  error.value = '';
  liveStreamStage.value = '';
  liveStreamPreview.value = '';
  liveReasoningPreview.value = '';
  liveReasoningChars.value = 0;
  liveStreamChars.value = 0;
  liveStreamActive.value = false;
  activeGenerationStep.value = null;
  stepActionPending.value = null;
  abortController.value = new AbortController();
  let generated = false;
  try {
    result.value = await generateShop(
      form,
      { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model, temperature: settings.temperature, reasoningStrategy: settings.reasoningStrategy },
      {
        signal: abortController.value.signal,
        onLog(entry) { upsertGenerationLog(entry); },
        onStream,
        onAiTrace: handleAiTrace,
        stepController,
        onStepState: onGenerationStepState,
      },
    );
    generated = true;
    openResultModal();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    generating.value = false;
    activeGenerationStep.value = null;
    stepActionPending.value = null;
    abortController.value = null;
  }
  if (generated) {
    // La génération est terminée ici : la validation démarre ensuite sans bloquer le résultat.
    await nextTick();
    void validateCurrentResult();
  }
}

async function openPreview() {
  resultModalOpen.value = false;
  validationModalOpen.value = false;
  aiInspectorOpen.value = false;
  previewModalOpen.value = true;
  if (previewInfo.value || previewLoading.value) return;
  previewLoading.value = true;
  previewOutput.value = '';
  previewError.value = '';
  try {
    previewInfo.value = await startValidationPreview({
      onEvent(event) {
        appendValidationEvent(event);
        if (event.type === 'output' || event.type === 'command' || event.type === 'error') {
          previewOutput.value = (previewOutput.value + (event.type === 'output' ? event.message : `\n${event.message}\n`)).slice(-150_000);
        }
      },
    });
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : String(err);
  } finally {
    previewLoading.value = false;
  }
}

function onGenerationStepState(state: GenerationStepState) {
  activeGenerationStep.value = state.active ? state.stage : null;
  if (!state.active) stepActionPending.value = null;
}

function restartCurrentStep() {
  if (!activeGenerationStep.value || stepActionPending.value) return;
  if (stepController.restartCurrent()) stepActionPending.value = 'restart';
}

function abandonCurrentStep() {
  if (!activeGenerationStep.value || stepActionPending.value) return;
  if (stepController.abandonCurrent()) stepActionPending.value = 'abandon';
}

function cancelGeneration() {
  abortController.value?.abort();
  validationAbortController.value?.abort();
}

function syncDesktopStickyPhase() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const desktop = window.matchMedia('(min-width: 981px)').matches;
  const workspaceTop = workspaceElement.value?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
  const rightColumnIsSticky = desktop && workspaceTop <= 10;
  topbarSticky.value = !rightColumnIsSticky;
}

function scheduleDesktopStickyPhaseSync() {
  if (stickyPhaseFrame !== null) return;
  stickyPhaseFrame = window.requestAnimationFrame(() => {
    stickyPhaseFrame = null;
    syncDesktopStickyPhase();
  });
}

onMounted(() => {
  isLocalEnvironment.value = isLocalHostname(window.location.hostname);
  if (isLocalEnvironment.value) restoreSavedFormData();

  window.addEventListener('scroll', scheduleDesktopStickyPhaseSync, { passive: true });
  window.addEventListener('resize', scheduleDesktopStickyPhaseSync, { passive: true });
  void nextTick(syncDesktopStickyPhase);
});

onBeforeUnmount(() => {
  if (formPersistenceMessageTimer !== null) window.clearTimeout(formPersistenceMessageTimer);
  if (stickyPhaseFrame !== null) window.cancelAnimationFrame(stickyPhaseFrame);
  window.removeEventListener('scroll', scheduleDesktopStickyPhaseSync);
  window.removeEventListener('resize', scheduleDesktopStickyPhaseSync);
  topbarSticky.value = true;
  void disposeValidationRuntime();
});

async function downloadProject() {
  if (!result.value) return;
  const blob = await resultToZip(result.value);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${form.output.projectSlug || slugify(form.project.name) || 'micro-shop'}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <AppShell active="generator" :topbar-sticky="topbarSticky">
    <template #sidebar>
      <nav class="studio-section-nav" aria-label="Sections du générateur">
        <button v-for="section in sections" :key="section[0]" type="button" :class="{ active: activeSection === section[0] }" @click="activeSection = section[0]">
          <StudioIcon :name="section[0] === 'project' ? 'folder' : section[0] === 'business' ? 'grid' : section[0] === 'technical' ? 'code' : section[0] === 'security' ? 'shield' : section[0] === 'integrations' ? 'plug' : section[0] === 'visuals' ? 'image' : section[0] === 'repository' ? 'archive' : 'sparkles'" :size="19" />
          <span>{{ section[1] }}</span>
        </button>
      </nav>
      <div class="studio-section-status">
        <StudioIcon name="check" :size="17" />
        <span><small>Entrées principales</small><strong>{{ !projectReady ? 'À compléter' : !repositoryReady ? 'ZIP requis' : 'Complètes' }}</strong></span>
      </div>
    </template>

    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">Réseau multi-agents embarqué</p>
        <h1>Génère une micro-boutique<br><em>pilotée par tes contraintes.</em></h1>
        <p class="intro">Le formulaire produit une entrée structurée pour le routeur, puis l’application injecte uniquement les agents et outils utiles à chaque étape.</p>
      </div>
    </section>

    <div v-if="!settingsReady" class="configuration-warning">
      <div><strong>Configure d’abord ton endpoint OpenAI-compatible.</strong><span>L’URL, la clé et le modèle sont nécessaires pour démarrer.</span></div>
      <a href="/settings">Ouvrir les paramètres →</a>
    </div>

    <div ref="workspaceElement" class="workspace">
      <section class="form-card card">
        <div v-show="activeSection === 'project'" class="section">
          <header><p>01</p><div><h2>Projet</h2><span>Entrées fondamentales du <code>PROJECT_SPEC</code>.</span></div></header>
          <div class="grid two">
            <label><span>Nom du projet *</span><input v-model="form.project.name" @blur="onNameBlur" placeholder="Ma micro-boutique" /></label>
            <label><span>Dépôt existant</span><select v-model="form.project.existingRepository"><option :value="false">Non — nouveau projet</option><option :value="true">Oui — contraintes à préserver</option></select></label>
          </div>
          <label v-if="form.project.existingRepository && !form.repository.archive" class="dropzone repository-dropzone compact">
            <input type="file" accept=".zip,application/zip" @change="addRepositoryZip" />
            <strong>{{ repositoryAnalyzing ? 'Analyse du projet…' : 'Choisir le ZIP du projet existant *' }}</strong>
            <span>Le ZIP est obligatoire pour préserver réellement le dépôt existant.</span>
          </label>
          <div v-else-if="form.project.existingRepository && form.repository.archive" class="repository-inline-status">
            <strong>✓ {{ form.repository.archive.name }}</strong><span>{{ form.repository.archive.files.length }} fichiers chargés comme base du projet</span>
          </div>
          <div v-if="repositoryError && activeSection === 'project'" class="error-box">{{ repositoryError }}</div>
          <label><span>Description / brief *</span><textarea v-model="form.project.description" rows="7" placeholder="Décris le positionnement de la boutique, les produits, l’identité de marque, les parcours importants…"></textarea></label>
        </div>

        <div v-show="activeSection === 'business'" class="section">
          <header><p>02</p><div><h2>Périmètre fonctionnel</h2><span>Correspond aux catégories extraites par l’agent de discovery et au domaine e-commerce.</span></div></header>
          <div class="toggle-grid">
            <label v-for="item in businessToggles" :key="item.key" class="toggle">
              <input :checked="form.business[item.key]" type="checkbox" @change="setBusinessToggle(item.key, $event)" /><span>{{ item.label }}</span>
            </label>
          </div>
          <div class="grid two">
            <label class="toggle inline"><input v-model="form.business.accountRequiredForCheckout" type="checkbox" /><span>Compte obligatoire pour acheter</span></label>
            <label class="toggle inline"><input v-model="form.business.transactionalEmails" type="checkbox" /><span>E-mails transactionnels</span></label>
            <label class="toggle inline"><input v-model="form.business.payment" type="checkbox" /><span>Paiement</span></label>
            <label class="toggle inline"><input v-model="form.business.internationalization" type="checkbox" /><span>Internationalisation</span></label>
          </div>
          <div class="grid two">
            <label v-if="form.business.payment"><span>Fournisseur de paiement</span><input v-model="form.business.paymentProvider" placeholder="Ex. PayPal, Stripe, Mollie — vide = choix IA" /></label>
            <label v-if="form.business.transactionalEmails"><span>Stratégie e-mail</span><input v-model="form.business.emailStrategy" placeholder="Ex. SMTP, Resend — vide = choix IA" /></label>
            <label><span>Devise</span><input v-model="form.business.currency" placeholder="EUR" /></label>
          </div>
          <div v-if="form.business.internationalization" class="languages-panel">
            <div class="languages-head">
              <div>
                <strong>Langues de la boutique</strong>
                <span>{{ form.business.locales.length }} langue(s) sélectionnée(s) · français et anglais sont précochés</span>
              </div>
              <input v-model="languageSearch" type="search" placeholder="Rechercher une langue…" />
            </div>
            <div class="selected-languages">
              <span v-for="language in selectedLanguages" :key="language.code">{{ language.label }} <code>{{ language.code }}</code></span>
            </div>
            <label class="default-language-field">
              <span>Langue par défaut</span>
              <select v-model="form.business.defaultLocale">
                <option
                  v-for="language in selectedLanguages"
                  :key="language.code"
                  :value="language.code"
                >
                  {{ language.label }} ({{ language.code }})
                </option>
              </select>
              <small>Seules les langues cochées sont disponibles comme langue par défaut.</small>
            </label>
            <div class="language-grid">
              <label v-for="language in filteredLanguages" :key="language.code" class="language-option">
                <input
                  type="checkbox"
                  :checked="form.business.locales.includes(language.code)"
                  @change="onLanguageChange(language.code, $event)"
                />
                <span>{{ language.label }}</span>
                <code>{{ language.code }}</code>
              </label>
            </div>
            <small v-if="!i18nReady" class="field-error">Sélectionne au moins une langue pour activer l’internationalisation.</small>
          </div>
          <label><span>Règles métier spécifiques</span><textarea v-model="form.business.businessRules" rows="5" placeholder="Cumul des promotions, règles d’annulation, audiences, taxes, disponibilité, livraison…"></textarea></label>
        </div>

        <div v-show="activeSection === 'technical'" class="section">
          <header><p>03</p><div><h2>Contraintes techniques</h2><span>Tous ces champs sont facultatifs. Une valeur vide reste <code>UNSPECIFIED</code> et sera décidée par le technology architect.</span></div></header>
          <div class="grid two">
            <label><span>Architecture</span><input v-model="form.technical.architecture" placeholder="Monolithe, multi-apps, API séparée…" /></label>
            <label><span>Rendering</span><input v-model="form.technical.rendering" placeholder="SSR, SSG, CSR…" /></label>
            <label><span>Langages</span><input v-model="form.technical.languages" placeholder="TypeScript, Go, PHP…" /></label>
            <label><span>Frameworks</span><input v-model="form.technical.frameworks" placeholder="Nuxt, Astro, Laravel…" /></label>
            <label><span>Base de données</span><input v-model="form.technical.database" placeholder="SQLite dev + MariaDB prod…" /></label>
            <label><span>ORM</span><input v-model="form.technical.orm" placeholder="Drizzle, Prisma, Doctrine…" /></label>
            <label><span>Styling</span><input v-model="form.technical.styling" placeholder="CSS, Tailwind…" /></label>
            <label><span>Testing</span><input v-model="form.technical.testing" placeholder="Vitest, Playwright…" /></label>
            <label><span>Runtime</span><input v-model="form.technical.runtime" placeholder="Node, Bun, Go…" /></label>
            <label><span>Conteneurisation</span><input v-model="form.technical.containerization" placeholder="Docker, aucune…" /></label>
            <label><span>Versioning / contraintes versions</span><input v-model="form.technical.versioning" placeholder="Node >= 22, Go 1.26…" /></label>
          </div>
        </div>

        <div v-show="activeSection === 'security'" class="section">
          <header><p>04</p><div><h2>Sécurité & identité</h2><span>Entrées utiles au security/auth agent.</span></div></header>
          <div class="grid two">
            <label><span>Authentification</span><input v-model="form.security.authentication" /></label>
            <label><span>Autorisation</span><input v-model="form.security.authorization" /></label>
            <label><span>Variable e-mail admin initial</span><input v-model="form.security.adminBootstrapEmailVariable" placeholder="ADMIN_EMAIL" /></label>
            <label><span>Sessions / JWT</span><input v-model="form.security.sessionStrategy" placeholder="Vide = choix selon stack" /></label>
          </div>
          <label><span>CORS / contraintes de sécurité spécifiques</span><textarea v-model="form.security.corsNotes" rows="4"></textarea></label>
        </div>

        <div v-show="activeSection === 'integrations'" class="section">
          <header><p>05</p><div><h2>Intégrations externes</h2><span>Seuls les agents des intégrations réellement renseignées sont chargés.</span></div></header>
          <div class="grid two">
            <label><span>Transporteur / livraison</span><input v-model="form.integrations.deliveryProvider" placeholder="Colissimo, Mondial Relay…" /></label>
            <label><span>Analytics</span><input v-model="form.integrations.analytics" /></label>
            <label><span>CRM</span><input v-model="form.integrations.crm" /></label>
            <label><span>ERP</span><input v-model="form.integrations.erp" /></label>
            <label><span>Marketplace</span><input v-model="form.integrations.marketplace" /></label>
            <label><span>Moteur de recherche</span><input v-model="form.integrations.search" /></label>
            <label><span>Stockage objet</span><input v-model="form.integrations.objectStorage" /></label>
          </div>
          <label><span>Notes d’intégration</span><textarea v-model="form.integrations.notes" rows="4"></textarea></label>
        </div>

        <div v-show="activeSection === 'visuals'" class="section">
          <header><p>06</p><div><h2>Références visuelles</h2><span>Les captures sont transmises au visual architect en entrée multimodale.</span></div></header>
          <label class="dropzone"><input type="file" accept="image/*" multiple @change="addVisualFiles" /><strong>Ajouter des captures</strong><span>Desktop, mobile, back-office, light ou dark mode.</span></label>
          <div v-if="form.visuals.assets.length" class="assets">
            <article v-for="asset in form.visuals.assets" :key="asset.id">
              <img :src="asset.dataUrl" :alt="asset.name" />
              <div><strong>{{ asset.name }}</strong><input v-model="asset.page" placeholder="Page / zone" /></div>
              <select v-model="asset.target"><option value="frontoffice">Front-office</option><option value="backoffice">Back-office</option><option value="other">Autre</option></select>
              <select v-model="asset.viewport"><option value="unknown">Viewport ?</option><option value="desktop">Desktop</option><option value="tablet">Tablette</option><option value="mobile">Mobile</option></select>
              <select v-model="asset.theme"><option value="unknown">Thème ?</option><option value="light">Light</option><option value="dark">Dark</option></select>
              <button type="button" class="icon" @click="removeVisual(asset.id)">×</button>
            </article>
          </div>
          <label><span>Notes visuelles</span><textarea v-model="form.visuals.notes" rows="4" placeholder="Police, branding, zones non visibles à extrapoler…"></textarea></label>
        </div>

        <div v-show="activeSection === 'repository'" class="section">
          <header><p>07</p><div><h2>État d’un dépôt existant</h2><span>Le ZIP devient la base du projet lorsque « Dépôt existant » est activé : l’IA doit préserver sa stack, ses conventions et ses fichiers non concernés.</span></div></header>

          <template v-if="form.project.existingRepository">
            <label v-if="!form.repository.archive" class="dropzone repository-dropzone">
              <input type="file" accept=".zip,application/zip" @change="addRepositoryZip" />
              <strong>{{ repositoryAnalyzing ? 'Analyse du projet…' : 'Importer le projet existant (.zip) *' }}</strong>
              <span>Les dépendances, builds et caches sont ignorés. Les fichiers source et binaires utiles seront conservés dans le projet final.</span>
            </label>
            <div v-else class="repository-archive">
              <div>
                <strong>{{ form.repository.archive.name }}</strong>
                <span>{{ form.repository.archive.files.length }} fichiers · {{ form.repository.archive.textFileCount }} texte · {{ form.repository.archive.binaryFileCount }} binaires</span>
                <small v-if="form.repository.archive.strippedRoot">Dossier racine ZIP retiré : {{ form.repository.archive.strippedRoot }}/</small>
              </div>
              <button type="button" class="secondary" @click="removeRepositoryZip">Retirer le ZIP</button>
            </div>
            <div v-if="repositoryError" class="error-box">{{ repositoryError }}</div>
          </template>
          <div v-else class="notice"><strong>Nouveau projet</strong><p>Active « Dépôt existant = Oui — contraintes à préserver » dans la section Projet pour importer une base de code existante.</p></div>

          <div class="grid two">
            <label><span>Gestionnaire de paquets</span><input v-model="form.repository.packageManager" placeholder="npm, pnpm, composer…" /></label>
            <label><span>Lockfile</span><input v-model="form.repository.lockfile" placeholder="package-lock.json…" /></label>
            <label><span>Scripts existants</span><input v-model="form.repository.scripts" placeholder="dev, build, test…" /></label>
            <label><span>Stack existante</span><input v-model="form.repository.existingStack" /></label>
          </div>
          <label><span>Conventions</span><textarea v-model="form.repository.conventions" rows="4"></textarea></label>
          <label><span>Schéma / données existantes</span><textarea v-model="form.repository.schemaNotes" rows="4"></textarea></label>
        </div>

        <div v-show="activeSection === 'output'" class="section">
          <header><p>08</p><div><h2>Génération</h2><span>Le projet final est assemblé côté navigateur puis exportable en ZIP.</span></div></header>
          <div class="grid two">
            <label><span>Slug du projet</span><input v-model="form.output.projectSlug" placeholder="ma-micro-boutique" /></label>
            <label><span>Nombre maximum de lots IA</span><input v-model.number="form.output.maxBatches" min="1" max="12" type="number" /></label>
          </div>
          <label><span>Instructions finales supplémentaires</span><textarea v-model="form.output.extraInstructions" rows="5" placeholder="Contraintes de code ou de livrable non couvertes plus haut…"></textarea></label>
          <div class="notice"><strong>Validation réelle</strong><p>Après génération, l’application détecte les runtimes compatibles. Pour les projets Node.js, le WebContainer installe les dépendances, exécute les tests disponibles puis vérifie réellement le démarrage avec `npm run dev` ; aucun build de production n’est lancé dans le navigateur. Le fix-coordinator peut ensuite corriger les échecs et relancer les validations. Les runtimes non garantis restent explicitement signalés comme non exécutés.</p></div>
        </div>

        <footer class="section-footer">
          <div class="autosave"><span>✓</span><small>Enregistré automatiquement</small></div>
          <div class="section-footer-actions">
            <button v-if="hasPreviousSection" type="button" class="ghost" @click="goToPreviousSection">← Précédent</button>
            <button type="button" class="ghost" @click="clearCurrentSection"><StudioIcon name="trash" :size="16" /> Effacer</button>
            <button v-if="hasNextSection" type="button" class="continue" @click="goToNextSection">Enregistrer et continuer <StudioIcon name="arrow-right" :size="17" /></button>
            <button v-else type="button" class="continue" :disabled="!canGenerate" @click="startGeneration">Générer la boutique <StudioIcon name="sparkles" :size="17" /></button>
          </div>
        </footer>
      </section>

      <aside class="side-column">
        <div class="hero-status card">
          <div><StudioIcon name="code" :size="18" /><strong>API IA</strong><small>{{ settingsReady ? settings.model : 'À configurer' }}</small></div>
          <div><StudioIcon name="image" :size="18" /><strong>Visuels</strong><small>{{ form.visuals.assets.length ? `${form.visuals.assets.length} référence(s)` : 'Facultatif' }}</small></div>
          <div><StudioIcon name="database" :size="18" /><strong>Agentification</strong><small><span class="status-dot"></span> Réseau copié dans le ZIP final</small></div>
        </div>
        <aside class="run-panel card">
        <div class="run-head"><span>Orchestration</span><strong>{{ generating ? 'Génération' : validating ? 'Validation' : result ? 'Terminée' : 'Prête' }}</strong></div>
        <div v-if="logs.length" class="logs">
          <button
            v-for="log in logs"
            :key="log.id"
            type="button"
            class="log log-button"
            :class="[log.status, { inspectable: canInspectLog(log) }]"
            :disabled="!canInspectLog(log)"
            @click="openLogDetails(log)"
          >
            <i></i>
            <div><strong>{{ log.stage }}</strong><span>{{ log.message }}</span></div>
            <b v-if="isValidationStage(log.stage) && validationHasBlockingFailure()" class="validation-stop">🚫</b>
            <b v-else-if="canInspectLog(log)">↗</b>
          </button>
        </div>
        <div v-else class="empty-run"><span>⌁</span><p>Le routeur et les agents spécialisés apparaîtront ici pendant la génération.</p></div>
        <div v-if="(generating || validating) && liveStreamStage" class="stream-box reasoning-box" :class="{ active: liveStreamActive }">
          <div class="stream-head">
            <span><i></i> Raisonnement IA</span>
            <strong>{{ liveReasoningChars.toLocaleString('fr-FR') }} caractères</strong>
          </div>
          <small>{{ liveStreamStage }}</small>
          <pre class="reasoning-live">{{ liveReasoningPreview || (liveStreamPreview ? 'Raisonnement non exposé par cette requête — réponse finale en cours…' : 'En attente du raisonnement…') }}</pre>
        </div>
        <div v-if="error" class="error-box">{{ error }}</div>
        <div v-if="result" class="result-box"><strong>{{ result.files.length }} fichiers générés</strong><span>Validation : {{ validationStatusLabel }} · le projet reste disponible indépendamment des tests.</span></div>
        <div v-if="generating && activeGenerationStep" class="step-actions">
          <button type="button" class="step-restart" :disabled="Boolean(stepActionPending)" @click="restartCurrentStep">
            {{ stepActionPending === 'restart' ? 'Relance…' : 'Recommencer l’étape' }}
          </button>
          <button type="button" class="step-abandon" :disabled="Boolean(stepActionPending)" @click="abandonCurrentStep">
            {{ stepActionPending === 'abandon' ? 'Abandon…' : 'Abandonner l’étape' }}
          </button>
        </div>
        <small v-if="generating && activeGenerationStep" class="active-step-label">Étape active : {{ activeGenerationStep }}</small>
        <div class="actions">
          <button type="button" class="secondary" @click="openAiInspector()">Voir les prompts / appels IA</button>
          <button v-if="!generating && !validating" class="primary" :disabled="!canGenerate" @click="startGeneration">{{ result ? 'Lancer une nouvelle génération' : 'Générer la boutique' }}</button>
          <button v-if="generating || validating" class="danger" @click="cancelGeneration">Annuler {{ validating ? 'la validation' : 'la génération' }}</button>
          <button v-if="result" class="secondary" @click="openResultModal">Voir le résultat</button>
          <button v-if="result" class="secondary" @click="openValidationModal">Tests / validation</button>
          <button v-if="result && previewAvailable" class="secondary" @click="openPreview">Preview dev</button>
          <button v-if="result" class="primary" @click="downloadProject">Télécharger le ZIP</button>
        </div>
        <small v-if="generating">{{ doneLogs }} étape(s) terminée(s). Les appels sont séquentiels pour limiter les erreurs de rate-limit.</small>
        </aside>
      </aside>
    </div>

    <ModalShell :open="aiInspectorOpen" title="Inspecteur des appels IA" :subtitle="aiInspectorStageFilter ? `Étape : ${aiInspectorStageFilter}` : 'Prompts et réponses reconstituées'" wide @close="aiInspectorOpen = false">
      <AiInspectorView
        v-model:selected-id="selectedAiTraceId"
        :traces="aiTraces"
        :initial-preview="initialPromptPreview"
        :stage-filter="aiInspectorStageFilter"
      />
    </ModalShell>

    <ModalShell :open="Boolean(result) && resultModalOpen" title="Résultat de génération" subtitle="Le résultat reste accessible jusqu’au lancement d’une nouvelle génération." wide @close="resultModalOpen = false">
      <GenerationResultView v-if="result" :result="result" />
      <template #footer>
        <button v-if="result" class="secondary" @click="openValidationModal">Tests / validation</button>
        <button v-if="result && previewAvailable" class="secondary" @click="openPreview">Preview dev</button>
        <button v-if="result" class="primary" @click="downloadProject">Télécharger le ZIP</button>
      </template>
    </ModalShell>

    <ModalShell :open="Boolean(result) && validationModalOpen" title="Tests et boucle de validation" :subtitle="validationStatusLabel" wide @close="validationModalOpen = false">
      <ValidationModal :running="validating" :outcome="validationOutcome" :events="validationEvents" :terminal="validationTerminal" />
      <template #footer>
        <button v-if="result && !validating" class="secondary" @click="validateCurrentResult">Relancer les validations</button>
        <button v-if="previewAvailable" class="primary" @click="openPreview">Ouvrir la preview</button>
      </template>
    </ModalShell>

    <ModalShell :open="Boolean(result) && previewModalOpen" title="Preview de développement" subtitle="Serveur de développement exécuté dans le navigateur" wide @close="previewModalOpen = false">
      <PreviewModal :loading="previewLoading" :preview="previewInfo" :output="previewOutput" :error="previewError" />
    </ModalShell>

    <div v-if="isLocalEnvironment" class="local-form-persistence" aria-label="Persistance locale du formulaire">
      <div v-if="formPersistenceMessage" class="local-form-persistence__message">{{ formPersistenceMessage }}</div>
      <div class="local-form-persistence__actions">
        <button type="button" class="local-save" @click="saveFormData">Enregistrer les données</button>
        <button type="button" class="local-clear" @click="clearSavedFormData">Vider les données enregistrées</button>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.studio-section-nav{display:grid;gap:5px}.studio-section-nav button{width:100%;height:48px;display:flex;align-items:center;gap:14px;border:0;border-left:2px solid transparent;background:transparent;color:var(--muted-strong);padding:0 14px;text-align:left;font-size:13px}.studio-section-nav button:hover{background:var(--surface-soft);color:var(--text)}.studio-section-nav button.active{background:var(--accent-soft);color:var(--text);border-left-color:var(--accent);font-weight:800}.studio-section-status{display:flex;align-items:center;gap:12px;margin:24px 8px 0;padding:20px 4px 0;border-top:1px solid var(--line-soft);color:var(--success)}.studio-section-status>span{display:grid;gap:3px}.studio-section-status small{font-size:10px;color:var(--muted)}.studio-section-status strong{font-size:12px;color:var(--text)}
.hero{min-height:284px;position:relative;display:flex;align-items:center;padding:42px 44px;overflow:hidden;background:linear-gradient(90deg,var(--app-bg) 0%,var(--app-bg) 44%,color-mix(in srgb,var(--app-bg) 78%,transparent) 62%,transparent 100%),var(--hero-image) right center/auto 100% no-repeat;border-bottom:1px solid var(--line-soft)}.hero:after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 75%,var(--app-bg));pointer-events:none}.hero-copy{position:relative;z-index:1}.eyebrow{margin:0 0 15px;color:var(--accent);text-transform:uppercase;letter-spacing:.19em;font-size:10px;font-weight:900}.hero h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(42px,5.2vw,76px);line-height:.9;letter-spacing:-.055em;font-weight:500;color:var(--text)}.hero h1 em{font-weight:500;color:var(--accent);font-style:italic}.intro{max-width:760px;margin:18px 0 0;color:var(--muted-strong);font-size:14px;line-height:1.5}
.configuration-warning{margin:18px 44px 0;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 16px;border:1px solid color-mix(in srgb,var(--warning) 30%,var(--line-soft));background:color-mix(in srgb,var(--warning) 7%,var(--surface));}.configuration-warning div{display:grid;gap:3px}.configuration-warning strong{font-size:13px}.configuration-warning span{font-size:12px;color:var(--muted)}.configuration-warning a{color:var(--warning);text-decoration:none;font-size:12px;font-weight:800}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:24px;align-items:start;padding:0 28px 56px 44px}.card{background:var(--surface);border:1px solid var(--line-soft);box-shadow:var(--shadow-sm)}.form-card{min-height:620px;padding:32px 38px}.section{display:grid;gap:22px}.section>header{display:flex;align-items:flex-start;gap:12px;padding-bottom:10px}.section>header>p{display:none}.section>header>div{display:grid;gap:4px}.section h2{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:29px;line-height:1.05;font-weight:600;letter-spacing:-.03em;color:var(--text)}.section>header span{font-size:12px;color:var(--muted)}.section>header:after{content:"";width:32px;height:3px;background:var(--accent);order:-1;margin-top:9px;display:none}.grid{display:grid;gap:18px}.grid.two{grid-template-columns:repeat(2,minmax(0,1fr))}label{display:grid;gap:8px}label>span{font-size:12px;font-weight:700;color:var(--text)}input,select,textarea{width:100%;min-height:46px;border:1px solid var(--line);background:var(--input-bg);color:var(--text);padding:11px 13px;outline:none;border-radius:0;font-size:12px;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}textarea{resize:vertical;line-height:1.55;min-height:110px}input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 15%,transparent)}input::placeholder,textarea::placeholder{color:var(--muted)}
.toggle-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.toggle{display:flex;align-items:center;gap:9px;min-height:46px;border:1px solid var(--line);background:var(--surface-2);padding:10px 12px}.toggle input,.language-option input{width:15px;height:15px;min-height:0;padding:0;accent-color:var(--accent);box-shadow:none}.toggle span{font-size:11px;color:var(--text)}.toggle.inline{min-height:46px}.languages-panel{display:grid;gap:14px;border:1px solid var(--line);background:var(--surface-2);padding:18px}.languages-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px}.languages-head>div{display:grid;gap:3px}.languages-head strong{font-size:12px}.languages-head span{font-size:10px;color:var(--muted)}.languages-head input{max-width:260px}.selected-languages{display:flex;flex-wrap:wrap;gap:7px;min-height:25px}.selected-languages>span{display:inline-flex;align-items:center;gap:5px;border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line));background:var(--accent-soft);padding:5px 8px;font-size:10px}.selected-languages code,.language-option code{font-size:9px;color:var(--muted)}.default-language-field{max-width:420px}.language-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;max-height:285px;overflow:auto}.language-option{display:grid;grid-template-columns:15px minmax(0,1fr) auto;align-items:center;gap:8px;border:1px solid var(--line);background:var(--surface);padding:9px;cursor:pointer}.language-option:hover{border-color:var(--accent)}.language-option span{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.field-error{color:var(--danger);font-size:10px}
.repository-dropzone{margin-bottom:2px}.repository-dropzone.compact{padding:18px}.repository-inline-status,.repository-archive{display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid var(--line-soft);background:var(--surface-2);padding:14px 16px}.repository-inline-status{justify-content:flex-start}.repository-inline-status strong,.repository-archive strong{font-size:11px}.repository-inline-status span,.repository-archive span,.repository-archive small{font-size:10px;color:var(--muted)}.repository-archive>div{display:grid;gap:3px;min-width:0}.dropzone{border:1px dashed color-mix(in srgb,var(--accent) 35%,var(--line));padding:25px;text-align:center;background:var(--accent-soft);cursor:pointer}.dropzone input{display:none}.dropzone strong,.dropzone span{display:block}.dropzone strong{font-size:12px}.dropzone span{margin-top:4px;color:var(--muted);font-size:10px}.assets{display:grid;gap:8px}.assets article{display:grid;grid-template-columns:52px minmax(120px,1fr) 120px 110px 95px 32px;gap:9px;align-items:center;padding:9px;border:1px solid var(--line);background:var(--surface-2)}.assets img{width:52px;height:52px;object-fit:cover}.assets article>div{display:grid;gap:5px;min-width:0}.assets article strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.assets article input,.assets article select{padding:7px 8px;font-size:10px;min-height:36px}.icon{width:30px;height:30px;border:1px solid var(--line);background:transparent;color:var(--muted)}
.notice{border-left:3px solid var(--accent);background:var(--accent-soft);padding:14px 16px}.notice strong{font-size:12px}.notice p{font-size:11px;line-height:1.5;color:var(--muted);margin:5px 0 0}.side-column{position:sticky;top:10px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;height:calc(100vh - 20px);max-height:calc(100vh - 20px);min-height:0;overflow:hidden}.hero-status{display:grid}.hero-status>div{display:flex;align-items:center;gap:10px;min-height:44px;padding:0 13px;border-bottom:1px solid var(--line-soft)}.hero-status>div>strong{flex:1;min-width:0}.hero-status>div>small{flex:0 0 auto;min-width:0}.hero-status>div:last-child{border-bottom:0}.hero-status svg{color:var(--accent)}.hero-status strong{font-size:11px}.hero-status small{font-size:10px;color:var(--muted);text-align:right;max-width:155px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--success);margin-right:4px}
.run-panel{min-height:0;height:100%;max-height:100%;padding:10px;display:flex;flex-direction:column;gap:10px;overflow:auto;overscroll-behavior:contain}.run-head{display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid var(--line-soft)}.run-head span{font-family:Georgia,"Times New Roman",serif;font-size:21px;font-weight:600}.run-head strong{font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--accent)}.logs{--orchestration-step-height:46px;display:grid;grid-auto-rows:var(--orchestration-step-height);align-content:start;gap:1px;overflow:auto;min-height:72px;max-height:clamp(100px,28vh,250px);padding-left:12px;position:relative;flex:1 1 auto}.logs:before{content:"";position:absolute;left:15px;top:7px;bottom:7px;width:1px;background:var(--line)}.log{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:8px;position:relative;height:var(--orchestration-step-height);min-height:var(--orchestration-step-height);max-height:var(--orchestration-step-height);padding:0;overflow:hidden}.log-button{width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:default}.log-button.running,.log-button.running:disabled{cursor:progress}.log-button.inspectable{cursor:pointer}.log-button.inspectable:hover div strong{color:var(--accent)}.log-button:disabled{opacity:1}.log i{width:10px;height:10px;border-radius:50%;border:1.5px solid var(--muted);background:var(--surface);margin-top:0;position:relative;z-index:1}.log.running i{border-color:var(--accent);background:var(--accent);box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 10%,transparent)}.log.done i{border-color:var(--success);background:var(--success)}.log.error i{border-color:var(--danger);background:var(--danger)}.log div{display:grid;align-content:center;gap:1px;min-width:0;overflow:hidden}.log strong{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;color:var(--text)}.log span{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:var(--muted);line-height:1.35}.log>b{font-size:9px;color:var(--muted);white-space:nowrap}.empty-run{min-height:100px;flex:1 1 auto;display:grid;place-items:center;text-align:center;color:var(--muted);align-content:center}.empty-run>span{font-size:26px}.empty-run p{font-size:10px;line-height:1.5;max-width:220px}.stream-box{display:grid;gap:7px;min-height:86px;max-height:clamp(90px,17vh,130px);padding:10px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));background:var(--accent-soft);overflow:hidden}.stream-head{display:flex;align-items:center;justify-content:space-between}.stream-head span{display:flex;align-items:center;gap:6px;font-size:10px;font-weight:800}.stream-head i{width:7px;height:7px;border-radius:50%;background:var(--accent)}.stream-head strong{font-size:9px;color:var(--muted)}.stream-box>small{font-size:9px;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stream-box pre{margin:0;overflow:auto;white-space:pre-wrap;word-break:break-word;font:9px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted);font-style:italic}.step-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.step-actions button{min-height:38px;border-radius:0;padding:9px 10px;font-size:9px;font-weight:800}.step-restart{border:1px solid color-mix(in srgb,var(--accent) 42%,var(--line));background:var(--accent-soft);color:var(--accent)}.step-abandon{border:1px solid color-mix(in srgb,var(--danger) 35%,var(--line));background:color-mix(in srgb,var(--danger) 7%,var(--surface));color:var(--danger)}.active-step-label{display:block;font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:grid;gap:8px;margin-top:auto}.actions button,.repository-archive .secondary{min-height:42px;border-radius:0;padding:10px 12px;font-size:10px;font-weight:800}.primary{border:1px solid var(--accent);color:var(--accent-contrast);background:var(--accent)}.secondary{border:1px solid var(--line);background:transparent;color:var(--text)}.danger{border:1px solid color-mix(in srgb,var(--danger) 30%,var(--line));background:color-mix(in srgb,var(--danger) 10%,var(--surface));color:var(--danger)}button:disabled{opacity:.45;cursor:not-allowed}.run-panel>small{font-size:9px;color:var(--muted);line-height:1.45}.error-box{padding:10px;border:1px solid color-mix(in srgb,var(--danger) 28%,var(--line));background:color-mix(in srgb,var(--danger) 7%,var(--surface));color:var(--danger);font-size:10px}.result-box{display:grid;gap:3px;padding:10px;border:1px solid color-mix(in srgb,var(--success) 25%,var(--line));background:color-mix(in srgb,var(--success) 6%,var(--surface))}.result-box strong{font-size:11px;color:var(--success)}.result-box span{font-size:10px;color:var(--muted)}
.section-footer{margin-top:14px;padding-top:20px;border-top:1px solid var(--line-soft);display:flex;align-items:center;justify-content:space-between;gap:16px}.autosave{display:flex;align-items:center;gap:8px;color:var(--success)}.autosave span{width:18px;height:18px;border:1px solid currentColor;border-radius:50%;display:grid;place-items:center;font-size:10px}.autosave small{font-size:10px;color:var(--muted)}.section-footer-actions{display:flex;align-items:center;gap:8px}.section-footer-actions button{min-height:44px;border-radius:0;padding:0 16px;font-size:10px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;gap:8px}.ghost{border:1px solid var(--line);background:transparent;color:var(--text)}.continue{border:1px solid var(--accent);background:var(--accent);color:var(--accent-contrast)}
.local-form-persistence{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:80;display:grid;justify-items:center;gap:8px;max-width:calc(100vw - 24px)}.local-form-persistence__actions{display:flex;align-items:center;gap:8px;padding:6px;border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow)}.local-form-persistence__actions button{border-radius:0;padding:9px 12px;font-size:10px;font-weight:800;white-space:nowrap}.local-save{border:1px solid color-mix(in srgb,var(--success) 35%,var(--line));background:color-mix(in srgb,var(--success) 8%,var(--surface));color:var(--success)}.local-clear{border:1px solid color-mix(in srgb,var(--danger) 30%,var(--line));background:color-mix(in srgb,var(--danger) 7%,var(--surface));color:var(--danger)}.local-form-persistence__message{max-width:min(520px,calc(100vw - 32px));padding:7px 10px;border:1px solid var(--line);background:var(--surface);box-shadow:var(--shadow-sm);color:var(--text);font-size:10px;text-align:center}code{color:var(--accent)}
@media(max-width:1260px){.workspace{grid-template-columns:minmax(0,1fr) 310px;padding-left:24px;padding-right:24px}.hero{padding-left:24px}.form-card{padding:28px}.toggle-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:980px){.workspace{grid-template-columns:1fr}.side-column{position:static;height:auto;max-height:none;grid-template-columns:1fr;grid-template-rows:auto}.run-panel{min-height:auto;max-height:none}.hero{min-height:250px;background:linear-gradient(90deg,var(--app-bg) 0%,color-mix(in srgb,var(--app-bg) 86%,transparent) 64%,transparent),var(--hero-image) right center/auto 100% no-repeat}.hero h1{font-size:clamp(38px,8vw,64px)}}
@media(max-width:760px){.local-form-persistence{position:static;left:auto;bottom:auto;transform:none;z-index:auto;width:auto;max-width:none;margin:0 12px 20px;justify-items:stretch}.local-form-persistence__actions{width:100%}.studio-section-nav{display:grid;overflow:visible}.studio-section-nav button{min-width:0;height:46px}.studio-section-status{display:flex}.hero{padding:32px 18px;min-height:250px;background:linear-gradient(90deg,var(--app-bg) 0%,color-mix(in srgb,var(--app-bg) 92%,transparent) 75%,transparent),var(--hero-image) 70% center/cover no-repeat}.hero h1{font-size:42px}.intro{font-size:12px;max-width:90%}.workspace{padding:0 12px 40px}.form-card{padding:22px 16px}.grid.two,.toggle-grid,.language-grid{grid-template-columns:1fr}.languages-head{align-items:stretch;flex-direction:column}.languages-head input{max-width:none}.assets article{grid-template-columns:52px 1fr 32px}.assets article>select{grid-column:2}.configuration-warning{margin:12px}.hero-status>div{display:flex}.hero-status small{text-align:right;white-space:nowrap}}
@media(max-width:560px){.section-footer{align-items:stretch;flex-direction:column}.section-footer-actions{display:grid;grid-template-columns:1fr}.section-footer-actions button{width:100%}.hero{min-height:230px}.hero h1{font-size:36px}.local-form-persistence{margin:0 10px 18px}.local-form-persistence__actions{width:100%;display:grid;grid-template-columns:1fr}.local-form-persistence__actions button{width:100%}}
.validation-stop{font-size:12px!important;color:var(--danger)!important;line-height:1}
</style>