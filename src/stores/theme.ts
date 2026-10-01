import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

export type ThemeMode = 'light' | 'system' | 'dark';

const STORAGE_KEY = 'micro-shop-generator:theme:v1';

export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>('system');
  const systemDark = ref(false);
  const hydrated = ref(false);
  let media: MediaQueryList | null = null;

  const resolved = computed<'light' | 'dark'>(() => mode.value === 'system' ? (systemDark.value ? 'dark' : 'light') : mode.value);

  function apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = resolved.value;
    document.documentElement.dataset.themeMode = mode.value;
    document.documentElement.style.colorScheme = resolved.value;
  }

  function onSystemChange(event: MediaQueryListEvent | MediaQueryList) {
    systemDark.value = event.matches;
    if (mode.value === 'system') apply();
  }

  function hydrate() {
    if (hydrated.value || typeof window === 'undefined') return;
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') mode.value = saved;
    media = window.matchMedia('(prefers-color-scheme: dark)');
    systemDark.value = media.matches;
    media.addEventListener?.('change', onSystemChange);
    hydrated.value = true;
    apply();
  }

  function setMode(next: ThemeMode) {
    mode.value = next;
    if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, next);
    apply();
  }

  hydrate();

  return { mode, resolved, setMode, hydrate };
});
