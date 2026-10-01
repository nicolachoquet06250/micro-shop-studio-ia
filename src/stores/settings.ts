import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { fetchModels } from '../lib/openai';
import { clearReasoningCapabilityCache } from '../lib/reasoning';
import type { ReasoningPreference } from '../types/generator';

const STORAGE_KEY = 'micro-shop-generator:ai-settings:v1';

interface StoredSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  reasoningStrategy: ReasoningPreference;
}

export const useSettingsStore = defineStore('settings', () => {
  const baseUrl = ref('');
  const apiKey = ref('');
  const model = ref('');
  const temperature = ref(0.1);
  const reasoningStrategy = ref<ReasoningPreference>('auto');
  const models = ref<string[]>([]);
  const modelsLoading = ref(false);
  const modelsError = ref('');
  const hydrated = ref(false);
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;

  const ready = computed(() => Boolean(baseUrl.value.trim() && apiKey.value.trim() && model.value.trim()));

  function hydrate() {
    if (hydrated.value || typeof window === 'undefined') return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<StoredSettings>;
        baseUrl.value = parsed.baseUrl ?? '';
        apiKey.value = parsed.apiKey ?? '';
        model.value = parsed.model ?? '';
        temperature.value = typeof parsed.temperature === 'number' && Number.isFinite(parsed.temperature)
          ? Math.min(2, Math.max(0, parsed.temperature))
          : 0.1;
        reasoningStrategy.value = parsed.reasoningStrategy ?? 'auto';
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }
    hydrated.value = true;
  }

  function persist() {
    if (!hydrated.value || typeof window === 'undefined') return;
    const data: StoredSettings = {
      baseUrl: baseUrl.value,
      apiKey: apiKey.value,
      model: model.value,
      temperature: temperature.value,
      reasoningStrategy: reasoningStrategy.value,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  }

  async function refreshModels() {
    const url = baseUrl.value.trim();
    const key = apiKey.value.trim();
    modelsError.value = '';
    if (!url || !key) {
      models.value = [];
      return;
    }

    modelsLoading.value = true;
    try {
      models.value = await fetchModels({ baseUrl: url, apiKey: key, model: model.value, temperature: temperature.value });
      if (!models.value.includes(model.value)) {
        model.value = models.value[0] ?? '';
      }
    } catch (error) {
      models.value = [];
      modelsError.value = error instanceof Error ? error.message : String(error);
    } finally {
      modelsLoading.value = false;
    }
  }

  function scheduleModelRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshModels(), 500);
  }

  hydrate();

  watch([baseUrl, apiKey, model, temperature, reasoningStrategy], persist);
  watch([baseUrl, apiKey], scheduleModelRefresh);

  if (baseUrl.value && apiKey.value) {
    scheduleModelRefresh();
  }

  return {
    baseUrl,
    apiKey,
    model,
    temperature,
    reasoningStrategy,
    models,
    modelsLoading,
    modelsError,
    ready,
    refreshModels,
    clearReasoningCache() {
      clearReasoningCapabilityCache({
        baseUrl: baseUrl.value,
        apiKey: apiKey.value,
        model: model.value,
        temperature: temperature.value,
        reasoningStrategy: reasoningStrategy.value,
      });
    },
  };
});
