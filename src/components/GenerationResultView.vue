<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GenerationResult } from '../types/generator';
import MermaidPreview from './MermaidPreview.vue';
import ProjectTree from './ProjectTree.vue';

interface DiagramDocument {
  path: string;
  title: string;
  markdown: string;
  mermaid: string;
}

const props = defineProps<{ result: GenerationResult }>();

const tab = ref<'tree' | 'data' | 'diagrams'>('tree');
const selectedDiagramPath = ref('');

function parseDiagram(path: string, markdown: string): DiagramDocument | null {
  const match = markdown.match(/```mermaid\s*([\s\S]*?)```/i);
  if (!match?.[1]?.trim()) return null;
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? path.split('/').pop()?.replace(/\.md$/i, '')
    ?? 'Diagramme';
  return { path, title, markdown, mermaid: match[1].trim() };
}

const diagrams = computed(() => props.result.files
  .filter((file) => file.path.startsWith('.ai/diagrams/') && file.path.endsWith('.md') && !file.path.endsWith('/README.md'))
  .map((file) => parseDiagram(file.path, file.content))
  .filter((diagram): diagram is DiagramDocument => Boolean(diagram))
  .sort((a, b) => a.path.localeCompare(b.path)));

const dataModel = computed(() => diagrams.value.find((diagram) => diagram.path === '.ai/diagrams/data-model.md') ?? null);
const otherDiagrams = computed(() => diagrams.value.filter((diagram) => diagram.path !== '.ai/diagrams/data-model.md'));
const selectedDiagram = computed(() => otherDiagrams.value.find((diagram) => diagram.path === selectedDiagramPath.value) ?? otherDiagrams.value[0] ?? null);

watch(otherDiagrams, (value) => {
  if (!value.some((diagram) => diagram.path === selectedDiagramPath.value)) selectedDiagramPath.value = value[0]?.path ?? '';
}, { immediate: true });
</script>

<template>
  <section class="result-view card">
    <div class="result-title">
      <div>
        <p class="eyebrow">Résultat de génération</p>
        <h2>Projet, données et diagrammes</h2>
        <span>Le code source et la documentation générés restent consultables avant le téléchargement du ZIP.</span>
      </div>
      <div class="result-stats">
        <span><strong>{{ result.files.length }}</strong> fichiers</span>
        <span><strong>{{ diagrams.length }}</strong> diagrammes Mermaid</span>
      </div>
    </div>

    <div class="result-tabs">
      <button type="button" :class="{ active: tab === 'tree' }" @click="tab = 'tree'">Arborescence</button>
      <button type="button" :class="{ active: tab === 'data' }" @click="tab = 'data'">Structure de données</button>
      <button type="button" :class="{ active: tab === 'diagrams' }" @click="tab = 'diagrams'">Diagrammes <span>{{ otherDiagrams.length }}</span></button>
    </div>

    <ProjectTree v-if="tab === 'tree'" :files="result.files" />

    <div v-else-if="tab === 'data'" class="diagram-workspace">
      <template v-if="dataModel">
        <div class="diagram-source">
          <div class="subhead"><strong>{{ dataModel.path }}</strong><span>Markdown / Mermaid</span></div>
          <pre><code>{{ dataModel.markdown }}</code></pre>
        </div>
        <div class="diagram-preview-pane">
          <div class="subhead"><strong>Preview</strong><span>Mermaid</span></div>
          <MermaidPreview :code="dataModel.mermaid" />
        </div>
      </template>
      <div v-else class="missing-diagram">
        <strong>Aucun modèle de données Mermaid exploitable n’a été produit.</strong>
        <span>Le générateur impose désormais `.ai/diagrams/data-model.md` lors des nouvelles générations.</span>
      </div>
    </div>

    <div v-else class="diagrams-layout">
      <aside class="diagram-list">
        <button
          v-for="diagram in otherDiagrams"
          :key="diagram.path"
          type="button"
          :class="{ active: selectedDiagram?.path === diagram.path }"
          @click="selectedDiagramPath = diagram.path"
        >
          <strong>{{ diagram.title }}</strong>
          <span>{{ diagram.path }}</span>
        </button>
        <div v-if="!otherDiagrams.length" class="empty-diagrams">Aucun autre diagramme n’a été jugé nécessaire pour ce projet.</div>
      </aside>
      <div v-if="selectedDiagram" class="diagram-workspace embedded">
        <div class="diagram-source">
          <div class="subhead"><strong>Source Markdown</strong><span>{{ selectedDiagram.path }}</span></div>
          <pre><code>{{ selectedDiagram.markdown }}</code></pre>
        </div>
        <div class="diagram-preview-pane">
          <div class="subhead"><strong>Preview</strong><span>Mermaid</span></div>
          <MermaidPreview :code="selectedDiagram.mermaid" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.result-view { margin:0; padding:10px; border-color:var(--line-soft); box-shadow:none; background:var(--surface); height:100%; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
.result-title { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-bottom: 18px; }
.eyebrow { margin: 0 0 6px; color: var(--primary); text-transform: uppercase; letter-spacing: .12em; font-size: 10px; font-weight: 800; }
h2 { margin: 0 0 5px; font-size: 22px; letter-spacing: -.025em; }
.result-title>div>span { color: var(--muted); font-size: 11px; }
.result-stats { display: flex; gap: 8px; flex: none; }
.result-stats span { display: grid; min-width: 105px; gap: 2px; padding: 9px 11px; border: 1px solid var(--line); border-radius: 0; color: var(--muted); font-size: 9px; background: var(--surface-2); }
.result-stats strong { color: var(--text); font-size: 15px; }
.result-tabs { display: flex; gap: 5px; margin-bottom: 12px; padding: 5px; border: 1px solid var(--line); border-radius: 0; background: var(--surface-2); }
.result-tabs button { border: 0; background: transparent; color: var(--muted); border-radius: 0; padding: 8px 11px; font-size: 10px; font-weight: 700; }
.result-tabs button.active { background: var(--accent-soft); color: var(--text); }
.result-tabs button span { margin-left: 4px; color: var(--primary); }
.result-view :deep(.project-browser) { flex:1; min-height:0; }
.diagram-workspace { display: grid; grid-template-columns: minmax(320px,.8fr) minmax(0,1.4fr); flex:1; min-height:0; border: 1px solid var(--line); border-radius: 0; overflow: hidden; background: var(--surface-2); }
.diagram-workspace.embedded { border: 0; border-radius: 0; min-height:0; height:100%; }
.diagram-source, .diagram-preview-pane { min-width: 0; min-height:0; display: flex; flex-direction: column; overflow:hidden; }
.diagram-source { border-right: 1px solid var(--line); }
.subhead { min-height: 47px; padding: 0 13px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--line); background: var(--surface); }
.subhead strong { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subhead span { color: var(--muted); font-size: 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.diagram-source pre { flex: 1; min-height:0; margin: 0; padding: 17px; overflow: auto; overscroll-behavior:contain; font: 10px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; color: var(--muted-strong); white-space: pre; }
.diagram-preview-pane :deep(.mermaid-preview) { margin: 14px; flex: 1; }
.diagrams-layout { display: grid; grid-template-columns: 230px minmax(0,1fr); flex:1; min-height:0; border: 1px solid var(--line); border-radius: 0; overflow: hidden; }
.diagram-list { padding: 7px; min-height:0; overflow:auto; overscroll-behavior:contain; border-right: 1px solid var(--line); background: var(--surface-2); }
.diagram-list button { width: 100%; display: grid; gap: 4px; padding: 9px 10px; border: 0; border-radius: 0; background: transparent; color: var(--muted); text-align: left; }
.diagram-list button:hover, .diagram-list button.active { background: var(--accent-soft); color: var(--text); }
.diagram-list strong { font-size: 10px; }
.diagram-list span { font-size: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty-diagrams, .missing-diagram { color: var(--muted); font-size: 10px; line-height: 1.5; padding: 16px; }
.missing-diagram { grid-column: 1 / -1; display: grid; place-content: center; gap: 5px; text-align: center; }
.missing-diagram strong { color: var(--text); font-size: 12px; }
@media (max-width: 950px) { .result-title { align-items: flex-start; flex-direction: column; } .diagram-workspace, .diagrams-layout { grid-template-columns: 1fr; } .diagram-source, .diagram-list { border-right: 0; border-bottom: 1px solid var(--line); } .diagram-list { max-height: 220px; overflow: auto; } }
</style>
