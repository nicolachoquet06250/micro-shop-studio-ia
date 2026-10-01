<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  code: string;
}>();

const target = ref<HTMLElement | null>(null);
const error = ref('');
let renderVersion = 0;
let mermaidApi: (typeof import('mermaid'))['default'] | null = null;

async function getMermaid() {
  if (!mermaidApi) mermaidApi = (await import('mermaid')).default;
  mermaidApi.initialize({
    startOnLoad: false,
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
    securityLevel: 'strict',
    flowchart: { htmlLabels: false, useMaxWidth: true },
    er: { useMaxWidth: true },
  });
  return mermaidApi;
}

async function renderDiagram() {
  const version = ++renderVersion;
  error.value = '';
  await nextTick();
  if (!target.value) return;

  const code = props.code.trim();
  if (!code) {
    target.value.innerHTML = '';
    return;
  }

  try {
    const mermaid = await getMermaid();
    const id = `mermaid-${crypto.randomUUID().replace(/-/g, '')}`;
    const { svg } = await mermaid.render(id, code);
    if (version !== renderVersion || !target.value) return;
    target.value.innerHTML = svg;
  } catch (err) {
    if (version !== renderVersion) return;
    if (target.value) target.value.innerHTML = '';
    error.value = err instanceof Error ? err.message : String(err);
  }
}

watch(() => props.code, renderDiagram);
onMounted(renderDiagram);
</script>

<template>
  <div class="mermaid-preview">
    <div ref="target" class="mermaid-canvas"></div>
    <div v-if="error" class="mermaid-error">
      <strong>Impossible de rendre ce diagramme.</strong>
      <span>{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.mermaid-preview { min-height: 320px; display: grid; place-items: center; padding: 20px; overflow: auto; background: var(--surface-2); border: 1px solid var(--line); border-radius: 0; }
.mermaid-canvas { width: 100%; min-width: 0; display: grid; place-items: center; }
.mermaid-canvas :deep(svg) { display: block; width: 100%; max-width: 100%; height: auto; min-height: 260px; }
.mermaid-error { width: 100%; display: grid; gap: 6px; align-self: start; padding: 12px; border: 1px solid rgba(255,107,129,.25); background: rgba(255,107,129,.08); border-radius: 0; color: var(--danger); }
.mermaid-error strong { font-size: 12px; }
.mermaid-error span { font-size: 10px; line-height: 1.5; white-space: pre-wrap; }
</style>
