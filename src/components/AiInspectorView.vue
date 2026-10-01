<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AiCallTrace, AiPromptPreview } from '../types/generator';

const props = defineProps<{
  traces: AiCallTrace[];
  initialPreview: AiPromptPreview | null;
  selectedId?: string | null;
  stageFilter?: string | null;
}>();

const PREVIEW_ID = '__initial-preview__';
const localSelectedId = ref(props.selectedId || PREVIEW_ID);

const visibleTraces = computed(() => {
  if (!props.stageFilter) return props.traces;
  return props.traces.filter((trace) => trace.stage === props.stageFilter || trace.stage.startsWith(`${props.stageFilter} ·`));
});

watch(
  () => [props.selectedId, props.stageFilter, props.traces.length] as const,
  () => {
    if (props.selectedId && visibleTraces.value.some((trace) => trace.id === props.selectedId)) {
      localSelectedId.value = props.selectedId;
      return;
    }
    if (props.stageFilter) {
      localSelectedId.value = visibleTraces.value.at(-1)?.id ?? PREVIEW_ID;
      return;
    }
    if (localSelectedId.value !== PREVIEW_ID && !visibleTraces.value.some((trace) => trace.id === localSelectedId.value)) {
      localSelectedId.value = visibleTraces.value.at(-1)?.id ?? PREVIEW_ID;
    }
  },
  { immediate: true },
);

const selectedTrace = computed(() => visibleTraces.value.find((trace) => trace.id === localSelectedId.value) ?? null);
const showingPreview = computed(() => localSelectedId.value === PREVIEW_ID && Boolean(props.initialPreview));

function formatDate(value: string) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatOutput(value: string, json: boolean) {
  const source = value?.trim() ?? '';
  if (!source) return '(aucune sortie finale)';
  if (!json) return value;
  const unfenced = source.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? source;
  try {
    return JSON.stringify(JSON.parse(unfenced), null, 2);
  } catch {
    return value;
  }
}

function statusLabel(status: AiCallTrace['status']) {
  switch (status) {
    case 'prepared': return 'Préparé';
    case 'streaming': return 'En cours';
    case 'done': return 'Terminé';
    case 'error': return 'Erreur';
    default: return status;
  }
}
</script>

<template>
  <div class="inspector">
    <aside class="calls-list">
      <button
        v-if="initialPreview && !stageFilter"
        type="button"
        class="call-card preview-card"
        :class="{ selected: showingPreview }"
        @click="localSelectedId = PREVIEW_ID"
      >
        <span class="dot preview"></span>
        <div>
          <strong>Prompt initial — avant envoi</strong>
          <small>{{ initialPreview.stage }}</small>
        </div>
        <b>PREVIEW</b>
      </button>

      <button
        v-for="trace in visibleTraces"
        :key="trace.id"
        type="button"
        class="call-card"
        :class="[{ selected: selectedTrace?.id === trace.id }, trace.status]"
        @click="localSelectedId = trace.id"
      >
        <span class="dot"></span>
        <div>
          <strong>{{ trace.stage }}</strong>
          <small>{{ formatDate(trace.createdAt) }} · tentative {{ trace.attempt }} · {{ trace.kind }}</small>
        </div>
        <b>{{ statusLabel(trace.status) }}</b>
      </button>

      <div v-if="!visibleTraces.length && (!initialPreview || stageFilter)" class="empty-list">
        Aucun appel IA enregistré pour cette étape.
      </div>
    </aside>

    <section v-if="showingPreview && initialPreview" class="trace-detail">
      <header class="detail-head">
        <div>
          <p>AVANT ENVOI</p>
          <h3>{{ initialPreview.stage }}</h3>
          <span>Prévisualisation calculée depuis le formulaire courant. Les appels suivants peuvent dépendre des réponses IA précédentes.</span>
        </div>
        <div class="chips">
          <span>{{ initialPreview.model || 'modèle non sélectionné' }}</span>
          <span>temperature {{ initialPreview.temperature }}</span>
          <span>{{ initialPreview.thinking === false ? 'reasoning OFF' : 'reasoning ON' }}</span>
        </div>
      </header>

      <div class="block">
        <div class="block-title"><strong>Prompt généré</strong><span>{{ initialPreview.prompt.length }} message(s)</span></div>
        <article v-for="(message, index) in initialPreview.prompt" :key="index" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
      </div>
    </section>

    <section v-else-if="selectedTrace" class="trace-detail">
      <header class="detail-head">
        <div>
          <p>APPEL IA</p>
          <h3>{{ selectedTrace.stage }}</h3>
          <span>{{ formatDate(selectedTrace.createdAt) }} · tentative {{ selectedTrace.attempt }}</span>
        </div>
        <div class="chips">
          <span>{{ selectedTrace.model }}</span>
          <span>temperature {{ selectedTrace.temperature }}</span>
          <span>{{ selectedTrace.thinking === false ? 'reasoning OFF' : 'reasoning ON' }}</span>
          <span v-if="selectedTrace.reasoningStrategy">{{ selectedTrace.reasoningStrategy }}</span>
          <span v-if="selectedTrace.finishReason">finish: {{ selectedTrace.finishReason }}</span>
        </div>
      </header>

      <div class="block">
        <div class="block-title"><strong>Prompt réellement envoyé</strong><span>{{ selectedTrace.prompt.length }} message(s)</span></div>
        <article v-for="(message, index) in selectedTrace.prompt" :key="index" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
      </div>

      <details class="reasoning-details">
        <summary>
          <span>Raisonnement du modèle</span>
          <b>{{ selectedTrace.reasoningChars.toLocaleString('fr-FR') }} caractères</b>
        </summary>
        <pre>{{ selectedTrace.reasoning || 'Aucun reasoning exposé par cette requête.' }}</pre>
      </details>

      <div class="block output-block">
        <div class="block-title">
          <strong>Sortie finale reconstituée</strong>
          <span>{{ selectedTrace.output.length.toLocaleString('fr-FR') }} caractères</span>
        </div>
        <pre>{{ formatOutput(selectedTrace.output, selectedTrace.json) }}</pre>
      </div>

      <div v-if="selectedTrace.error" class="trace-error">
        <strong>Erreur</strong>
        <pre>{{ selectedTrace.error }}</pre>
      </div>
    </section>

    <section v-else class="empty-detail">
      Sélectionne un appel pour consulter son prompt, son raisonnement et sa sortie finale reconstituée.
    </section>
  </div>
</template>

<style scoped>
.inspector{display:grid;padding:10px;grid-template-columns:minmax(250px,330px) minmax(0,1fr);gap:14px;height:100%;min-height:0;max-height:none;overflow:hidden}.calls-list{display:flex;flex-direction:column;gap:7px;overflow:auto;padding-right:4px;border-right:1px solid var(--line);padding-right:12px}.call-card{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:start;gap:9px;width:100%;padding:10px;border:1px solid transparent;border-radius:0;background:var(--surface-2);color:var(--text);text-align:left;cursor:pointer}.call-card:hover,.call-card.selected{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 28%,var(--line))}.call-card .dot{width:7px;height:7px;border-radius:50%;margin-top:4px;background:var(--muted)}.call-card.streaming .dot{background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 50%,transparent)}.call-card.done .dot{background:var(--success)}.call-card.error .dot{background:var(--danger)}.call-card .dot.preview{background:#e2b56f}.call-card>div{display:grid;gap:3px;min-width:0}.call-card strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.call-card small{font-size:9px;color:var(--muted);line-height:1.4}.call-card>b{font-size:8px;color:var(--muted);font-weight:800}.preview-card>b{color:#e2b56f}.trace-detail{display:grid;align-content:start;gap:14px;overflow:auto;padding-right:4px}.detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}.detail-head>div:first-child{display:grid;gap:4px}.detail-head p{margin:0;color:var(--primary);font-size:8px;font-weight:900;letter-spacing:.14em}.detail-head h3{margin:0;font-size:18px}.detail-head span{font-size:9px;color:var(--muted);line-height:1.45}.chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.chips span{padding:5px 7px;border:1px solid var(--line);border-radius:0;background:var(--surface-2);font-size:8px;color:var(--muted-strong);white-space:nowrap}.block{display:grid;gap:8px}.block-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.block-title strong{font-size:10px}.block-title span{font-size:8px;color:var(--muted)}.message-card{display:grid;gap:6px;border:1px solid var(--line);border-radius:0;padding:10px;background:var(--surface-2)}.message-card>b{width:max-content;padding:3px 6px;border-radius:0;background:var(--accent-soft);color:var(--accent);font-size:8px;text-transform:uppercase;letter-spacing:.08em}.message-card pre,.output-block>pre,.reasoning-details pre,.trace-error pre{margin:0;white-space:pre-wrap;word-break:break-word;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted-strong)}.message-card pre{max-height:340px;overflow:auto}.reasoning-details{border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:0;background:var(--accent-soft)}.reasoning-details summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;cursor:pointer;list-style:none}.reasoning-details summary::-webkit-details-marker{display:none}.reasoning-details summary span{font-size:10px;font-weight:800}.reasoning-details summary b{font-size:8px;color:var(--muted)}.reasoning-details pre{padding:0 12px 12px;color:var(--muted-strong);font-style:italic;max-height:330px;overflow:auto}.output-block>pre{padding:12px;border:1px solid var(--line);border-radius:0;background:var(--surface-2);max-height:480px;overflow:auto;color:var(--text)}.trace-error{display:grid;gap:6px;padding:10px;border:1px solid rgba(255,107,129,.22);border-radius:0;background:rgba(255,107,129,.055)}.trace-error strong{font-size:10px;color:var(--danger)}.trace-error pre{color:var(--danger)}.empty-list,.empty-detail{color:var(--muted);font-size:10px;line-height:1.55;padding:14px}.empty-detail{display:grid;place-items:center;text-align:center}@media(max-width:860px){.inspector{grid-template-columns:1fr;height:auto;max-height:none;overflow:visible}.calls-list{max-height:220px;border-right:0;border-bottom:1px solid var(--line);padding-right:0;padding-bottom:10px}.trace-detail{max-height:58vh}.detail-head{flex-direction:column}.chips{justify-content:flex-start}}
</style>
