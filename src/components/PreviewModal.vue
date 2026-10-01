<script setup lang="ts">
import type { PreviewSessionInfo } from '../lib/validation';

defineProps<{
  loading: boolean;
  preview: PreviewSessionInfo | null;
  output: string;
  error?: string;
}>();
</script>

<template>
  <div class="preview-view">
    <div class="preview-bar">
      <div><strong>{{ preview?.label ?? 'Preview de développement' }}</strong><span v-if="preview?.port">Port {{ preview.port }}</span></div>
      <code>{{ preview?.url || (loading ? 'Démarrage du serveur…' : 'Aucune URL disponible') }}</code>
    </div>
    <div v-if="error" class="preview-error">{{ error }}</div>
    <div v-if="loading && !preview" class="loading">Installation/démarrage du serveur de développement…</div>
    <iframe v-else-if="preview" :src="preview.url" title="Preview du projet généré" sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts allow-downloads"></iframe>
    <pre class="preview-output">{{ output || 'Les logs du serveur de développement apparaîtront ici.' }}</pre>
  </div>
</template>

<style scoped>
.preview-view{display:grid;gap:10px;padding:10px;grid-template-rows:auto minmax(0,1fr) 170px;height:100%;min-height:0;overflow:hidden;background:var(--surface)}.preview-bar{display:flex;border:1px solid var(--line);align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-bottom:1px solid var(--line);background:var(--surface-2)}.preview-bar>div{display:flex;gap:8px;align-items:center}.preview-bar strong{font-size:10px}.preview-bar span,.preview-bar code{font-size:9px;color:var(--muted)}.preview-bar code{max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview-error{padding:10px;color:var(--danger);font-size:10px;background:color-mix(in srgb,var(--danger) 7%,var(--surface))}.loading{display:grid;place-items:center;color:var(--muted);font-size:11px}iframe{width:100%;height:100%;border:1px solid var(--line);background:white}.preview-output{margin:0;border:1px solid var(--line);overflow:auto;padding:10px;border-top:1px solid var(--line);white-space:pre-wrap;word-break:break-word;font:9px/1.45 ui-monospace,monospace;color:var(--muted-strong)}
</style>
