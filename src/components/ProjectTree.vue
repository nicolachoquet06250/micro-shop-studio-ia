<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { codeToHtml } from 'shiki';
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

type MarkdownView = 'source' | 'preview';

const props = defineProps<{ files: GeneratedFile[] }>();

const expanded = ref<Set<string>>(new Set());
const selectedPath = ref('');
const markdownView = ref<MarkdownView>('source');
const highlightedHtml = ref('');
const markdownHtml = ref('');
const highlighting = ref(false);
let highlightRevision = 0;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  'astro': 'astro', 'vue': 'vue', 'svelte': 'svelte',
  'js': 'javascript', 'mjs': 'javascript', 'cjs': 'javascript', 'jsx': 'jsx',
  'ts': 'typescript', 'mts': 'typescript', 'cts': 'typescript', 'tsx': 'tsx',
  'json': 'json', 'jsonc': 'jsonc', 'json5': 'json5',
  'html': 'html', 'htm': 'html', 'xml': 'xml', 'svg': 'xml',
  'css': 'css', 'scss': 'scss', 'sass': 'sass', 'less': 'less', 'styl': 'stylus',
  'md': 'markdown', 'markdown': 'markdown', 'mdx': 'mdx',
  'yaml': 'yaml', 'yml': 'yaml', 'toml': 'toml', 'ini': 'ini', 'properties': 'properties',
  'sh': 'bash', 'bash': 'bash', 'zsh': 'bash', 'fish': 'fish', 'ps1': 'powershell', 'bat': 'bat', 'cmd': 'bat',
  'py': 'python', 'pyw': 'python', 'rb': 'ruby', 'php': 'php', 'go': 'go', 'rs': 'rust',
  'java': 'java', 'kt': 'kotlin', 'kts': 'kotlin', 'swift': 'swift', 'dart': 'dart',
  'c': 'c', 'h': 'c', 'cc': 'cpp', 'cpp': 'cpp', 'cxx': 'cpp', 'hpp': 'cpp', 'hh': 'cpp',
  'cs': 'csharp', 'fs': 'fsharp', 'fsx': 'fsharp', 'vb': 'vb',
  'scala': 'scala', 'sc': 'scala', 'groovy': 'groovy', 'gradle': 'groovy',
  'lua': 'lua', 'pl': 'perl', 'pm': 'perl', 'r': 'r', 'R': 'r', 'jl': 'julia',
  'ex': 'elixir', 'exs': 'elixir', 'erl': 'erlang', 'hrl': 'erlang', 'hs': 'haskell',
  'clj': 'clojure', 'cljs': 'clojure', 'cljc': 'clojure', 'edn': 'clojure',
  'zig': 'zig', 'sol': 'solidity', 'nim': 'nim', 'v': 'v',
  'sql': 'sql', 'graphql': 'graphql', 'gql': 'graphql',
  'proto': 'proto', 'prisma': 'prisma',
  'dockerfile': 'dockerfile', 'nginx': 'nginx',
  'tf': 'hcl', 'tfvars': 'hcl', 'hcl': 'hcl',
  'diff': 'diff', 'patch': 'diff', 'log': 'text', 'txt': 'text',
  'csv': 'csv', 'tsv': 'tsv',
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  'dockerfile': 'dockerfile', 'makefile': 'make', 'gnumakefile': 'make',
  'nginx.conf': 'nginx', '.gitignore': 'gitignore', '.gitattributes': 'gitattributes',
  '.editorconfig': 'ini', '.env': 'dotenv', '.env.example': 'dotenv', '.npmrc': 'ini',
};

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
const selectedFileName = computed(() => selectedPath.value.split('/').pop() ?? '');
const selectedExtension = computed(() => {
  const name = selectedFileName.value;
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1) : '';
});
const selectedIsMarkdown = computed(() => ['md', 'markdown'].includes(selectedExtension.value.toLowerCase()));
const selectedLanguage = computed(() => {
  const lowerName = selectedFileName.value.toLowerCase();
  if (LANGUAGE_BY_FILENAME[lowerName]) return LANGUAGE_BY_FILENAME[lowerName];
  return LANGUAGE_BY_EXTENSION[selectedExtension.value] ?? LANGUAGE_BY_EXTENSION[selectedExtension.value.toLowerCase()] ?? 'text';
});

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

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character] ?? character));
}

async function refreshPreview() {
  const revision = ++highlightRevision;
  highlightedHtml.value = '';
  markdownHtml.value = '';
  if (!selectedPath.value || selectedIsBinary.value) return;

  const content = selectedContent.value;
  highlighting.value = true;
  try {
    try {
      const html = await codeToHtml(content, {
        lang: selectedLanguage.value,
        themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      });
      if (revision === highlightRevision) highlightedHtml.value = html;
    } catch {
      if (revision === highlightRevision) {
        highlightedHtml.value = `<pre class="shiki plain-source"><code>${escapeHtml(content)}</code></pre>`;
      }
    }

    if (selectedIsMarkdown.value) {
      const rendered = await marked.parse(content, { gfm: true, breaks: false });
      if (revision === highlightRevision) {
        markdownHtml.value = DOMPurify.sanitize(rendered, {
          USE_PROFILES: { html: true },
          ADD_ATTR: ['target', 'rel'],
        });
      }
    }
  } finally {
    if (revision === highlightRevision) highlighting.value = false;
  }
}

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
watch([selectedPath, selectedContent], () => {
  markdownView.value = 'source';
  void refreshPreview();
}, { immediate: true });
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
      <div class="pane-head file-head">
        <strong>{{ selectedPath || 'Sélectionne un fichier' }}</strong>
        <div class="file-meta">
          <div v-if="selectedIsMarkdown && selectedPath && !selectedIsBinary" class="markdown-tabs" role="tablist" aria-label="Affichage Markdown">
            <button type="button" role="tab" :aria-selected="markdownView === 'source'" :class="{ active: markdownView === 'source' }" @click="markdownView = 'source'">Source</button>
            <button type="button" role="tab" :aria-selected="markdownView === 'preview'" :class="{ active: markdownView === 'preview' }" @click="markdownView = 'preview'">Preview</button>
          </div>
          <span v-if="selectedPath">{{ selectedIsBinary ? 'fichier binaire' : `${selectedContent.length.toLocaleString('fr-FR')} caractères · ${selectedLanguage}` }}</span>
        </div>
      </div>
      <div v-if="selectedPath && selectedIsBinary" class="no-file">Fichier binaire conservé dans le ZIP final. Son contenu n’est pas injecté dans les prompts IA.</div>
      <div v-else-if="selectedPath && selectedIsMarkdown && markdownView === 'preview'" class="markdown-preview" v-html="markdownHtml"></div>
      <div v-else-if="selectedPath" class="source-preview">
        <div v-if="highlighting && !highlightedHtml" class="highlight-loading">Coloration syntaxique…</div>
        <div v-else class="highlight-host" v-html="highlightedHtml"></div>
      </div>
      <div v-else class="no-file">Sélectionne un fichier dans l’arborescence.</div>
    </div>
  </div>
</template>

<style scoped>
.project-browser { display: grid; grid-template-columns: minmax(260px, .8fr) minmax(0, 1.7fr); height:100%; min-height:0; border: 1px solid var(--line); border-radius: 0; overflow: hidden; background: var(--surface-2); }
.tree-pane, .file-pane { min-width: 0; min-height:0; display: flex; flex-direction: column; overflow:hidden; }
.tree-pane { border-right: 1px solid var(--line); }
.pane-head { min-height: 48px; padding: 0 13px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--line); background: var(--surface); }
.pane-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.pane-head>span,.file-meta>span { flex: none; color: var(--muted); font-size: 9px; }
.file-head{padding-top:5px;padding-bottom:5px}.file-meta{display:flex;align-items:center;justify-content:flex-end;gap:12px;min-width:0}.markdown-tabs{display:flex;align-items:stretch;border:1px solid var(--line);background:var(--surface-2)}.markdown-tabs button{height:30px;padding:0 12px;border:0;border-right:1px solid var(--line);background:transparent;color:var(--muted-strong);font-size:9px;font-weight:800;cursor:pointer}.markdown-tabs button:last-child{border-right:0}.markdown-tabs button:hover{background:var(--accent-soft)}.markdown-tabs button.active{background:var(--accent);color:var(--accent-contrast)}
.tree-list { flex:1; min-height:0; overflow: auto; padding: 7px 0; max-height:none; overscroll-behavior:contain; }
.tree-row { width: 100%; min-height: 29px; display: grid; grid-template-columns: 12px 15px minmax(0,1fr); align-items: center; gap: 4px; border: 0; background: transparent; color: var(--muted-strong); text-align: left; font-size: 10px; }
.tree-row:hover, .tree-row.selected { background: rgba(124,140,255,.09); color: var(--text); }
.twisty { color: var(--muted); }
.node-icon { color: var(--primary); font-size: 9px; }
.node-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.source-preview,.markdown-preview{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.highlight-host{min-height:100%}.highlight-host :deep(.shiki){box-sizing:border-box;min-width:100%;width:max-content;min-height:100%;margin:0;padding:18px;background:transparent!important;font:10.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;tab-size:2}.highlight-host :deep(.shiki code){font:inherit}.highlight-host :deep(.shiki span){color:var(--shiki-light)!important;background-color:var(--shiki-light-bg)!important}:global(html[data-theme='dark']) .highlight-host :deep(.shiki span){color:var(--shiki-dark)!important;background-color:var(--shiki-dark-bg)!important}.highlight-host :deep(.plain-source){white-space:pre;color:var(--muted-strong)}.highlight-loading{display:grid;min-height:180px;place-items:center;color:var(--muted);font-size:10px}
.markdown-preview{padding:24px 28px;background:var(--surface);color:var(--text);font-size:12px;line-height:1.7}.markdown-preview :deep(h1),.markdown-preview :deep(h2),.markdown-preview :deep(h3),.markdown-preview :deep(h4){font-family:Georgia,'Times New Roman',serif;line-height:1.2;color:var(--text);margin:1.3em 0 .55em}.markdown-preview :deep(h1){font-size:28px;margin-top:0}.markdown-preview :deep(h2){font-size:21px;border-bottom:1px solid var(--line);padding-bottom:8px}.markdown-preview :deep(h3){font-size:17px}.markdown-preview :deep(p){margin:.75em 0}.markdown-preview :deep(a){color:var(--accent)}.markdown-preview :deep(blockquote){margin:1em 0;padding:4px 16px;border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--muted-strong)}.markdown-preview :deep(pre){overflow:auto;margin:1em 0;padding:14px;border:1px solid var(--line);background:var(--surface-2);font:10.5px/1.6 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.markdown-preview :deep(code){padding:.12em .35em;background:var(--surface-2);font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.markdown-preview :deep(pre code){padding:0;background:transparent}.markdown-preview :deep(table){width:100%;border-collapse:collapse;margin:1em 0}.markdown-preview :deep(th),.markdown-preview :deep(td){padding:8px 10px;border:1px solid var(--line);text-align:left}.markdown-preview :deep(th){background:var(--surface-2)}.markdown-preview :deep(img){max-width:100%;height:auto}.markdown-preview :deep(hr){border:0;border-top:1px solid var(--line);margin:1.5em 0}.markdown-preview :deep(ul),.markdown-preview :deep(ol){padding-left:24px}
.no-file { display: grid; flex: 1; place-items: center; color: var(--muted); font-size: 11px; }
@media (max-width: 850px) { .project-browser { grid-template-columns: 1fr; } .tree-pane { border-right: 0; border-bottom: 1px solid var(--line); } .tree-list { max-height: 300px; } .file-head{align-items:flex-start;flex-direction:column}.file-meta{width:100%;justify-content:space-between}.markdown-preview{padding:18px} }
</style>
