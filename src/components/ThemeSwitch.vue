<script setup lang="ts">
import { useThemeStore, type ThemeMode } from '../stores/theme';
import StudioIcon from './StudioIcon.vue';

const theme = useThemeStore();
const items: Array<{ value: ThemeMode; label: string; icon: 'sun' | 'monitor' | 'moon' }> = [
  { value: 'light', label: 'Clair', icon: 'sun' },
  { value: 'system', label: 'Système', icon: 'monitor' },
  { value: 'dark', label: 'Sombre', icon: 'moon' },
];
</script>

<template>
  <div class="theme-switch" role="group" aria-label="Choix du thème">
    <button
      v-for="item in items"
      :key="item.value"
      type="button"
      :class="{ active: theme.mode === item.value }"
      :aria-pressed="theme.mode === item.value"
      @click="theme.setMode(item.value)"
    >
      <StudioIcon :name="item.icon" :size="15" />
      <span>{{ item.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.theme-switch{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;padding:3px;border:1px solid var(--line-soft);background:var(--surface-soft);min-width:290px}.theme-switch button{display:flex;align-items:center;justify-content:center;gap:7px;border:0;background:transparent;color:var(--muted);padding:9px 11px;font-size:12px;font-weight:700;cursor:pointer}.theme-switch button.active{background:var(--accent);color:var(--accent-contrast);box-shadow:var(--shadow-sm)}
@media(max-width:560px){.theme-switch{min-width:0;width:100%}.theme-switch span{display:none}}
</style>
