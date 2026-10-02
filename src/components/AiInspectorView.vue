<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AiCallTrace, AiPromptPreview } from '../types/generator';

const props = defineProps<{
  traces: AiCallTrace[];
  initialPreview: AiPromptPreview | null;
  selectedId?: string | null;
  stageFilter?: string | null;
}>();

const emit = defineEmits<{
  (event: 'update:selectedId', value: string | null): void;
}>();

const PREVIEW_ID = '__initial-preview__';
const localSelectedId = ref(props.selectedId || PREVIEW_ID);
const followLatest = ref(false);
const openBatches = ref<Record<string, boolean>>({});

type DetailTab = 'system' | 'user' | 'reasoning' | 'output';
const activeDetailTab = ref<DetailTab>('system');

const detailTabs: Array<{ id: DetailTab; label: string }> = [
  { id: 'system', label: 'Prompt système' },
  { id: 'user', label: 'Prompt User' },
  { id: 'reasoning', label: 'Raisonnement IA' },
  { id: 'output', label: 'Sortie finale reconstituée' },
];

const visibleTraces = computed(() => {
  if (!props.stageFilter) return props.traces;
  return props.traces.filter((trace) => trace.stage === props.stageFilter || trace.stage.startsWith(`${props.stageFilter} ·`));
});

function batchIdFromTrace(trace: AiCallTrace) {
  return trace.stage.match(/^impl[ée]mentation\s+(B\d+)\b/i)?.[1]?.toUpperCase() ?? null;
}

type SidebarEntry =
  | { type: 'trace'; trace: AiCallTrace }
  | { type: 'batch'; id: string; traces: AiCallTrace[] };

const sidebarEntries = computed<SidebarEntry[]>(() => {
  const entries: SidebarEntry[] = [];
  const batches = new Map<string, Extract<SidebarEntry, { type: 'batch' }>>();

  for (const trace of visibleTraces.value) {
    const batchId = batchIdFromTrace(trace);
    if (!batchId) {
      entries.push({ type: 'trace', trace });
      continue;
    }

    let group = batches.get(batchId);
    if (!group) {
      group = { type: 'batch', id: batchId, traces: [] };
      batches.set(batchId, group);
      entries.push(group);
    }
    group.traces.push(trace);
  }

  return entries;
});

function setBatchOpen(batchId: string, open: boolean) {
  openBatches.value = { ...openBatches.value, [batchId]: open };
}

function toggleBatch(batchId: string) {
  setBatchOpen(batchId, !openBatches.value[batchId]);
}

function ensureSelectedBatchOpen(id: string | null) {
  if (!id || id === PREVIEW_ID) return;
  const trace = visibleTraces.value.find((item) => item.id === id);
  if (!trace) return;
  const batchId = batchIdFromTrace(trace);
  if (batchId && !openBatches.value[batchId]) setBatchOpen(batchId, true);
}

function batchStatus(traces: AiCallTrace[]): AiCallTrace['status'] {
  if (traces.some((trace) => trace.status === 'error')) return 'error';
  if (traces.some((trace) => trace.status === 'streaming')) return 'streaming';
  if (traces.some((trace) => trace.status === 'prepared')) return 'prepared';
  return 'done';
}

function setSelectedId(id: string) {
  localSelectedId.value = id;
  const lastId = visibleTraces.value.at(-1)?.id ?? null;
  followLatest.value = id !== PREVIEW_ID && id === lastId;
  ensureSelectedBatchOpen(id);
  emit('update:selectedId', id);
}

watch(
  () => [props.selectedId, props.stageFilter] as const,
  () => {
    if (props.selectedId === PREVIEW_ID && props.initialPreview && !props.stageFilter) {
      localSelectedId.value = PREVIEW_ID;
      followLatest.value = false;
      return;
    }

    if (props.selectedId && visibleTraces.value.some((trace) => trace.id === props.selectedId)) {
      localSelectedId.value = props.selectedId;
      followLatest.value = props.selectedId === visibleTraces.value.at(-1)?.id;
      ensureSelectedBatchOpen(props.selectedId);
      return;
    }

    const fallbackId = visibleTraces.value.at(-1)?.id ?? PREVIEW_ID;
    localSelectedId.value = fallbackId;
    followLatest.value = fallbackId !== PREVIEW_ID;
    ensureSelectedBatchOpen(fallbackId);
    emit('update:selectedId', fallbackId);
  },
  { immediate: true },
);

watch(
  () => props.traces.length,
  () => {
    if (followLatest.value) {
      const lastId = visibleTraces.value.at(-1)?.id;
      if (lastId && lastId !== localSelectedId.value) {
        localSelectedId.value = lastId;
        ensureSelectedBatchOpen(lastId);
        emit('update:selectedId', lastId);
      }
      return;
    }

    if (localSelectedId.value !== PREVIEW_ID && !visibleTraces.value.some((trace) => trace.id === localSelectedId.value)) {
      const fallbackId = visibleTraces.value.at(-1)?.id ?? PREVIEW_ID;
      localSelectedId.value = fallbackId;
      followLatest.value = fallbackId !== PREVIEW_ID;
      ensureSelectedBatchOpen(fallbackId);
      emit('update:selectedId', fallbackId);
    }
  },
);

const selectedTrace = computed(() => visibleTraces.value.find((trace) => trace.id === localSelectedId.value) ?? null);
const showingPreview = computed(() => localSelectedId.value === PREVIEW_ID && Boolean(props.initialPreview));

function messagesForRole(prompt: Array<{ role: string; content: string }>, role: 'system' | 'user') {
  return prompt.filter((message) => message.role === role);
}

function tabCountLabel(tab: DetailTab) {
  const prompt = showingPreview.value ? props.initialPreview?.prompt ?? [] : selectedTrace.value?.prompt ?? [];
  if (tab === 'system') return `${messagesForRole(prompt, 'system').length} message(s)`;
  if (tab === 'user') return `${messagesForRole(prompt, 'user').length} message(s)`;
  if (tab === 'reasoning') return showingPreview.value ? 'indisponible' : `${(selectedTrace.value?.reasoningChars ?? 0).toLocaleString('fr-FR')} caractères`;
  return showingPreview.value ? 'indisponible' : `${(selectedTrace.value?.output.length ?? 0).toLocaleString('fr-FR')} caractères`;
}

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
        @click="setSelectedId(PREVIEW_ID)"
      >
        <span class="dot preview"></span>
        <div>
          <strong>Prompt initial — avant envoi</strong>
          <small>{{ initialPreview.stage }}</small>
        </div>
        <b>PREVIEW</b>
      </button>

      <template v-for="entry in sidebarEntries" :key="entry.type === 'batch' ? `batch:${entry.id}` : entry.trace.id">
        <div v-if="entry.type === 'batch'" class="batch-accordion" :class="batchStatus(entry.traces)">
          <button
            type="button"
            class="batch-head"
            :aria-expanded="Boolean(openBatches[entry.id])"
            @click="toggleBatch(entry.id)"
          >
            <span class="batch-chevron">{{ openBatches[entry.id] ? '▾' : '▸' }}</span>
            <span class="dot"></span>
            <span class="batch-copy">
              <strong>{{ entry.id }}</strong>
              <small>{{ entry.traces.length }} implémentation{{ entry.traces.length > 1 ? 's' : '' }}</small>
            </span>
            <b>{{ statusLabel(batchStatus(entry.traces)) }}</b>
          </button>

          <div v-show="openBatches[entry.id]" class="batch-items">
            <button
              v-for="trace in entry.traces"
              :key="trace.id"
              type="button"
              class="call-card batch-call-card"
              :class="[{ selected: selectedTrace?.id === trace.id }, trace.status]"
              @click="setSelectedId(trace.id)"
            >
              <span class="dot"></span>
              <div>
                <strong>{{ trace.stage }}</strong>
                <small>{{ formatDate(trace.createdAt) }} · tentative {{ trace.attempt }} · {{ trace.kind }}</small>
              </div>
              <b>{{ statusLabel(trace.status) }}</b>
            </button>
          </div>
        </div>

        <button
          v-else
          type="button"
          class="call-card"
          :class="[{ selected: selectedTrace?.id === entry.trace.id }, entry.trace.status]"
          @click="setSelectedId(entry.trace.id)"
        >
          <span class="dot"></span>
          <div>
            <strong>{{ entry.trace.stage }}</strong>
            <small>{{ formatDate(entry.trace.createdAt) }} · tentative {{ entry.trace.attempt }} · {{ entry.trace.kind }}</small>
          </div>
          <b>{{ statusLabel(entry.trace.status) }}</b>
        </button>
      </template>

      <div v-if="!visibleTraces.length && (!initialPreview || stageFilter)" class="empty-list">
        Aucun appel IA enregistré pour cette étape.
      </div>
    </aside>

    <section v-if="showingPreview && initialPreview" class="trace-detail">
      <nav class="detail-tabs" aria-label="Contenu de l’appel IA">
        <button
          v-for="tab in detailTabs"
          :key="tab.id"
          type="button"
          class="detail-tab"
          :class="{ active: activeDetailTab === tab.id }"
          @click="activeDetailTab = tab.id"
        >
          <span>{{ tab.label }}</span>
          <small>{{ tabCountLabel(tab.id) }}</small>
        </button>
      </nav>

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

      <div v-if="activeDetailTab === 'system'" class="tab-panel block">
        <div class="block-title"><strong>Prompt système</strong><span>{{ messagesForRole(initialPreview.prompt, 'system').length }} message(s)</span></div>
        <article v-for="(message, index) in messagesForRole(initialPreview.prompt, 'system')" :key="`preview-system-${index}`" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
        <div v-if="!messagesForRole(initialPreview.prompt, 'system').length" class="empty-tab">Aucun message système dans ce prompt.</div>
      </div>

      <div v-else-if="activeDetailTab === 'user'" class="tab-panel block">
        <div class="block-title"><strong>Prompt User</strong><span>{{ messagesForRole(initialPreview.prompt, 'user').length }} message(s)</span></div>
        <article v-for="(message, index) in messagesForRole(initialPreview.prompt, 'user')" :key="`preview-user-${index}`" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
        <div v-if="!messagesForRole(initialPreview.prompt, 'user').length" class="empty-tab">Aucun message utilisateur dans ce prompt.</div>
      </div>

      <div v-else-if="activeDetailTab === 'reasoning'" class="tab-panel empty-tab">
        Le raisonnement IA n’est pas disponible pour la prévisualisation avant envoi.
      </div>

      <div v-else class="tab-panel empty-tab">
        La sortie finale n’est pas disponible pour la prévisualisation avant envoi.
      </div>
    </section>

    <section v-else-if="selectedTrace" class="trace-detail">
      <nav class="detail-tabs" aria-label="Contenu de l’appel IA">
        <button
          v-for="tab in detailTabs"
          :key="tab.id"
          type="button"
          class="detail-tab"
          :class="{ active: activeDetailTab === tab.id }"
          @click="activeDetailTab = tab.id"
        >
          <span>{{ tab.label }}</span>
          <small>{{ tabCountLabel(tab.id) }}</small>
        </button>
      </nav>

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

      <div v-if="activeDetailTab === 'system'" class="tab-panel block">
        <div class="block-title"><strong>Prompt système</strong><span>{{ messagesForRole(selectedTrace.prompt, 'system').length }} message(s)</span></div>
        <article v-for="(message, index) in messagesForRole(selectedTrace.prompt, 'system')" :key="`trace-system-${index}`" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
        <div v-if="!messagesForRole(selectedTrace.prompt, 'system').length" class="empty-tab">Aucun message système dans cet appel.</div>
      </div>

      <div v-else-if="activeDetailTab === 'user'" class="tab-panel block">
        <div class="block-title"><strong>Prompt User</strong><span>{{ messagesForRole(selectedTrace.prompt, 'user').length }} message(s)</span></div>
        <article v-for="(message, index) in messagesForRole(selectedTrace.prompt, 'user')" :key="`trace-user-${index}`" class="message-card">
          <b>{{ message.role }}</b>
          <pre>{{ message.content }}</pre>
        </article>
        <div v-if="!messagesForRole(selectedTrace.prompt, 'user').length" class="empty-tab">Aucun message utilisateur dans cet appel.</div>
      </div>

      <div v-else-if="activeDetailTab === 'reasoning'" class="tab-panel reasoning-panel">
        <div class="block-title">
          <strong>Raisonnement IA</strong>
          <span>{{ selectedTrace.reasoningChars.toLocaleString('fr-FR') }} caractères</span>
        </div>
        <pre>{{ selectedTrace.reasoning || 'Aucun reasoning exposé par cette requête.' }}</pre>
      </div>

      <div v-else class="tab-panel block output-block">
        <div class="block-title">
          <strong>Sortie finale reconstituée</strong>
          <span>{{ selectedTrace.output.length.toLocaleString('fr-FR') }} caractères</span>
        </div>
        <pre>{{ formatOutput(selectedTrace.output, selectedTrace.json) }}</pre>

        <div v-if="selectedTrace.error" class="trace-error">
          <strong>Erreur</strong>
          <pre>{{ selectedTrace.error }}</pre>
        </div>
      </div>
    </section>

    <section v-else class="empty-detail">
      Sélectionne un appel pour consulter son prompt, son raisonnement et sa sortie finale reconstituée.
    </section>
  </div>
</template>

<style scoped>
.inspector{display:grid;padding:10px;grid-template-columns:minmax(250px,330px) minmax(0,1fr);gap:14px;height:100%;min-height:0;max-height:none;overflow:hidden}.calls-list{display:flex;flex-direction:column;gap:7px;overflow:auto;padding-right:4px;border-right:1px solid var(--line);padding-right:12px}.batch-accordion{display:grid;gap:0;border:1px solid var(--line);background:var(--surface-2)}.batch-head{display:grid;grid-template-columns:12px 8px minmax(0,1fr) auto;align-items:center;gap:8px;width:100%;padding:10px;border:0;background:transparent;color:var(--text);text-align:left;cursor:pointer}.batch-head:hover{background:var(--accent-soft)}.batch-chevron{font-size:10px;color:var(--muted);line-height:1}.batch-head>.dot{width:7px;height:7px;border-radius:50%;background:var(--muted)}.batch-accordion.streaming .batch-head>.dot{background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 50%,transparent)}.batch-accordion.done .batch-head>.dot{background:var(--success)}.batch-accordion.error .batch-head>.dot{background:var(--danger)}.batch-copy{display:grid;gap:2px;min-width:0}.batch-copy strong{font-size:10px}.batch-copy small{font-size:9px;color:var(--muted)}.batch-head>b{font-size:8px;color:var(--muted);font-weight:800}.batch-items{display:grid;gap:5px;padding:0 6px 6px 20px;border-top:1px solid var(--line)}.batch-call-card{margin-top:6px;background:var(--surface);padding:8px}.batch-call-card strong{font-size:9px}.call-card{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:start;gap:9px;width:100%;padding:10px;border:1px solid transparent;border-radius:0;background:var(--surface-2);color:var(--text);text-align:left;cursor:pointer}.call-card:hover,.call-card.selected{background:var(--accent-soft);border-color:color-mix(in srgb,var(--accent) 28%,var(--line))}.call-card .dot{width:7px;height:7px;border-radius:50%;margin-top:4px;background:var(--muted)}.call-card.streaming .dot{background:var(--accent);box-shadow:0 0 8px color-mix(in srgb,var(--accent) 50%,transparent)}.call-card.done .dot{background:var(--success)}.call-card.error .dot{background:var(--danger)}.call-card .dot.preview{background:#e2b56f}.call-card>div{display:grid;gap:3px;min-width:0}.call-card strong{font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.call-card small{font-size:9px;color:var(--muted);line-height:1.4}.call-card>b{font-size:8px;color:var(--muted);font-weight:800}.preview-card>b{color:#e2b56f}.trace-detail{display:grid;align-content:start;gap:14px;overflow:auto;padding-right:4px;position:relative}.detail-tabs{position:sticky;top:0;z-index:8;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border:1px solid var(--line);background:var(--surface);box-shadow:0 6px 16px color-mix(in srgb,var(--bg) 78%,transparent)}.detail-tab{display:grid;gap:3px;min-width:0;padding:9px 10px;border:0;border-right:1px solid var(--line);border-bottom:2px solid transparent;background:var(--surface);color:var(--muted-strong);text-align:left;cursor:pointer}.detail-tab:last-child{border-right:0}.detail-tab:hover{background:var(--surface-2)}.detail-tab.active{background:var(--accent-soft);border-bottom-color:var(--accent);color:var(--text)}.detail-tab span{font-size:9px;font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.detail-tab small{font-size:7px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tab-panel{min-height:0}.empty-tab{padding:14px;border:1px solid var(--line);background:var(--surface-2);color:var(--muted);font-size:10px;line-height:1.55}.reasoning-panel{display:grid;gap:8px}.reasoning-panel>pre{margin:0;padding:12px;border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));background:var(--accent-soft);white-space:pre-wrap;word-break:break-word;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted-strong);font-style:italic}.detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding-bottom:12px;border-bottom:1px solid var(--line)}.detail-head>div:first-child{display:grid;gap:4px}.detail-head p{margin:0;color:var(--primary);font-size:8px;font-weight:900;letter-spacing:.14em}.detail-head h3{margin:0;font-size:18px}.detail-head span{font-size:9px;color:var(--muted);line-height:1.45}.chips{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:5px}.chips span{padding:5px 7px;border:1px solid var(--line);border-radius:0;background:var(--surface-2);font-size:8px;color:var(--muted-strong);white-space:nowrap}.block{display:grid;gap:8px}.block-title{display:flex;align-items:center;justify-content:space-between;gap:10px}.block-title strong{font-size:10px}.block-title span{font-size:8px;color:var(--muted)}.message-card{display:grid;gap:6px;border:1px solid var(--line);border-radius:0;padding:10px;background:var(--surface-2)}.message-card>b{width:max-content;padding:3px 6px;border-radius:0;background:var(--accent-soft);color:var(--accent);font-size:8px;text-transform:uppercase;letter-spacing:.08em}.message-card pre,.output-block>pre,.reasoning-details pre,.trace-error pre{margin:0;white-space:pre-wrap;word-break:break-word;font:10px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:var(--muted-strong)}.message-card pre{overflow:visible}.reasoning-details{border:1px solid color-mix(in srgb,var(--accent) 22%,var(--line));border-radius:0;background:var(--accent-soft)}.reasoning-details summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;cursor:pointer;list-style:none}.reasoning-details summary::-webkit-details-marker{display:none}.reasoning-details summary span{font-size:10px;font-weight:800}.reasoning-details summary b{font-size:8px;color:var(--muted)}.reasoning-details pre{padding:0 12px 12px;color:var(--muted-strong);font-style:italic;max-height:330px;overflow:auto}.output-block>pre{padding:12px;border:1px solid var(--line);border-radius:0;background:var(--surface-2);overflow:visible;color:var(--text)}.trace-error{display:grid;gap:6px;padding:10px;border:1px solid rgba(255,107,129,.22);border-radius:0;background:rgba(255,107,129,.055)}.trace-error strong{font-size:10px;color:var(--danger)}.trace-error pre{color:var(--danger)}.empty-list,.empty-detail{color:var(--muted);font-size:10px;line-height:1.55;padding:14px}.empty-detail{display:grid;place-items:center;text-align:center}@media(max-width:860px){.inspector{grid-template-columns:1fr;height:auto;max-height:none;overflow:visible}.detail-tabs{display:flex;overflow-x:auto}.detail-tab{flex:0 0 155px}.calls-list{max-height:220px;border-right:0;border-bottom:1px solid var(--line);padding-right:0;padding-bottom:10px}.trace-detail{max-height:58vh}.detail-head{flex-direction:column}.chips{justify-content:flex-start}}
</style>
