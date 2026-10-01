<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GeneratedFile } from '../types/generator';

interface TreeNode {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children: TreeNode[];
}

interface VisibleRow extends TreeNode {
  depth: number;
}

const props = defineProps<{ files: GeneratedFile[] }>();

const expanded = ref<Set<string>>(new Set());
const selectedPath = ref('');

function buildTree(files: GeneratedFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] };

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = file.path.split('/').filter(Boolean);
    let cursor = root;
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const path = parts.slice(0, index + 1).join('/');
      let node = cursor.children.find((child) => child.name === part);
      if (!node) {
        node = { name: part, path, kind: isFile ? 'file' : 'folder', children: [] };
        cursor.children.push(node);
      }
      cursor = node;
    });
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(root.children);
  return root.children;
}

const tree = computed(() => buildTree(props.files));
const fileMap = computed(() => new Map(props.files.map((file) => [file.path, file])));
const selectedFile = computed(() => selectedPath.value ? fileMap.value.get(selectedPath.value) ?? null : null);
const selectedContent = computed(() => selectedFile.value?.encoding === 'base64' ? '' : selectedFile.value?.content ?? '');
const selectedIsBinary = computed(() => selectedFile.value?.encoding === 'base64');

const visibleRows = computed<VisibleRow[]>(() => {
  const rows: VisibleRow[] = [];
  const visit = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ ...node, depth });
      if (node.kind === 'folder' && expanded.value.has(node.path)) visit(node.children, depth + 1);
    }
  };
  visit(tree.value, 0);
  return rows;
});

function resetTree() {
  const next = new Set<string>();
  const open = (nodes: TreeNode[], depth: number) => {
    for (const node of nodes) {
      if (node.kind === 'folder' && depth < 2) {
        next.add(node.path);
        open(node.children, depth + 1);
      }
    }
  };
  open(tree.value, 0);
  expanded.value = next;
  selectedPath.value = props.files.find((file) => !file.path.startsWith('.agents/'))?.path ?? props.files[0]?.path ?? '';
}

function toggle(node: VisibleRow) {
  if (node.kind === 'file') {
    selectedPath.value = node.path;
    return;
  }
  const next = new Set(expanded.value);
  if (next.has(node.path)) next.delete(node.path);
  else next.add(node.path);
  expanded.value = next;
}

watch(() => props.files, resetTree, { immediate: true, deep: false });
</script>

<template>
  <div class="project-browser">
    <div class="tree-pane">
      <div class="pane-head">
        <strong>Projet généré</strong>
        <span>{{ files.length }} fichiers</span>
      </div>
      <div class="tree-list">
        <button
          v-for="row in visibleRows"
          :key="row.path"
          type="button"
          class="tree-row"
          :class="{ selected: row.kind === 'file' && selectedPath === row.path }"
          :style="{ paddingLeft: `${10 + row.depth * 16}px` }"
          @click="toggle(row)"
        >
          <span class="twisty">{{ row.kind === 'folder' ? (expanded.has(row.path) ? '▾' : '▸') : '' }}</span>
          <span class="node-icon">{{ row.kind === 'folder' ? '▰' : '·' }}</span>
          <span class="node-name">{{ row.name }}</span>
        </button>
      </div>
    </div>

    <div class="file-pane">
      <div class="pane-head">
        <strong>{{ selectedPath || 'Sélectionne un fichier' }}</strong>
        <span v-if="selectedPath">{{ selectedIsBinary ? 'fichier binaire' : `${selectedContent.length.toLocaleString('fr-FR')} caractères` }}</span>
      </div>
      <div v-if="selectedPath && selectedIsBinary" class="no-file">Fichier binaire conservé dans le ZIP final. Son contenu n’est pas injecté dans les prompts IA.</div>
      <pre v-else-if="selectedPath"><code>{{ selectedContent }}</code></pre>
      <div v-else class="no-file">Sélectionne un fichier dans l’arborescence.</div>
    </div>
  </div>
</template>

<style scoped>
.project-browser { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(0, 1.7fr); height:100%; min-height:0; border: 1px solid var(--line); border-radius: 0; overflow: hidden; background: var(--surface-2); }
.tree-pane, .file-pane { min-width: 0; min-height:0; display: flex; flex-direction: column; overflow:hidden; }
.tree-pane { border-right: 1px solid var(--line); }
.pane-head { height: 48px; padding: 0 13px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
.pane-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.pane-head span { flex: none; color: var(--muted); font-size: 9px; }
.tree-list { flex:1; min-height:0; overflow: auto; padding: 7px 0; max-height:none; overscroll-behavior:contain; }
.tree-row { width: 100%; min-height: 29px; display: grid; grid-template-columns: 12px 15px minmax(0,1fr); align-items: center; gap: 4px; border: 0; background: transparent; color: var(--muted-strong); text-align: left; font-size: 10px; }
.tree-row:hover, .tree-row.selected { background: rgba(124,140,255,.09); color: var(--text); }
.twisty { color: var(--muted); }
.node-icon { color: var(--primary); font-size: 9px; }
.node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-pane pre { flex: 1; min-height:0; margin: 0; padding: 18px; overflow: auto; overscroll-behavior:contain; color: var(--muted-strong); font: 10.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; tab-size: 2; white-space: pre; }
.no-file { display: grid; flex: 1; place-items: center; color: var(--muted); font-size: 11px; }
@media (max-width: 850px) { .project-browser { grid-template-columns: 1fr; } .tree-pane { border-right: 0; border-bottom: 1px solid var(--line); } .tree-list { max-height: 300px; } }
</style>
