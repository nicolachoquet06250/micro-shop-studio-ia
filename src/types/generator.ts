export type SourceKind = 'EXPLICIT' | 'INFERRED' | 'UNSPECIFIED';

export interface VisualAsset {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  target: 'frontoffice' | 'backoffice' | 'other';
  viewport: 'desktop' | 'tablet' | 'mobile' | 'unknown';
  theme: 'light' | 'dark' | 'unknown';
  page: string;
}

export interface ExistingRepositoryFile {
  path: string;
  sizeBytes: number;
  encoding: 'utf8' | 'base64';
  content: string;
}

export interface ExistingRepositoryArchive {
  name: string;
  sizeBytes: number;
  strippedRoot: string | null;
  files: ExistingRepositoryFile[];
  textFileCount: number;
  binaryFileCount: number;
  detected: {
    packageManager: string;
    lockfile: string;
    scripts: string;
    existingStack: string;
  };
}

export interface GeneratorForm {
  project: {
    name: string;
    description: string;
    existingRepository: boolean;
  };
  business: {
    products: boolean;
    variants: boolean;
    stock: boolean;
    customers: boolean;
    cart: boolean;
    checkout: boolean;
    accountRequiredForCheckout: boolean;
    orders: boolean;
    delivery: boolean;
    discounts: boolean;
    promoCodes: boolean;
    taxes: boolean;
    payment: boolean;
    paymentProvider: string;
    transactionalEmails: boolean;
    emailStrategy: string;
    admin: boolean;
    mediaManagement: boolean;
    seo: boolean;
    internationalization: boolean;
    locales: string[];
    defaultLocale: string;
    currency: string;
    businessRules: string;
  };
  technical: {
    architecture: string;
    languages: string;
    frameworks: string;
    database: string;
    orm: string;
    styling: string;
    testing: string;
    runtime: string;
    containerization: string;
    versioning: string;
    rendering: string;
  };
  security: {
    authentication: string;
    authorization: string;
    adminBootstrapEmailVariable: string;
    sessionStrategy: string;
    corsNotes: string;
  };
  integrations: {
    deliveryProvider: string;
    analytics: string;
    crm: string;
    erp: string;
    marketplace: string;
    search: string;
    objectStorage: string;
    notes: string;
  };
  visuals: {
    notes: string;
    assets: VisualAsset[];
  };
  repository: {
    packageManager: string;
    lockfile: string;
    scripts: string;
    existingStack: string;
    conventions: string;
    schemaNotes: string;
    archive: ExistingRepositoryArchive | null;
  };
  output: {
    projectSlug: string;
    extraInstructions: string;
    maxBatches: number;
  };
}

export type ReasoningPreference = 'auto' | 'reasoning_effort' | 'vllm' | 'prompt' | 'none';

export interface AiSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningStrategy?: ReasoningPreference;
}

export type AiCallKind = 'json' | 'file' | 'file-continuation' | 'validation-plan' | 'validation-file' | 'other';
export type AiCallTraceStatus = 'preview' | 'prepared' | 'streaming' | 'done' | 'error';

export interface AiCallTraceMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiCallTrace {
  id: string;
  stage: string;
  kind: AiCallKind;
  status: AiCallTraceStatus;
  createdAt: string;
  completedAt?: string;
  model: string;
  temperature: number;
  thinking?: boolean;
  json: boolean;
  reasoningStrategy?: string;
  attempt: number;
  prompt: AiCallTraceMessage[];
  output: string;
  reasoning: string;
  finishReason: string | null;
  hadReasoning: boolean;
  reasoningChars: number;
  error?: string;
}

export interface AiPromptPreview {
  stage: string;
  kind: AiCallKind;
  model: string;
  temperature: number;
  thinking?: boolean;
  json: boolean;
  prompt: AiCallTraceMessage[];
}

export type AiCallTraceEvent =
  | { type: 'prepared' | 'streaming' | 'done' | 'error'; trace: AiCallTrace };

export interface GenerationLog {
  id: string;
  at: string;
  stage: string;
  status: 'running' | 'done' | 'error' | 'info';
  message: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface GenerationResult {
  files: GeneratedFile[];
  artifacts: Record<string, unknown>;
  report: unknown;
}
