const rawModules = import.meta.glob('../ai-network/**/*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

export interface NetworkDocument {
  path: string;
  content: string;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\.\/ai-network\//, '');
}

export const networkDocuments: NetworkDocument[] = Object.entries(rawModules)
  .map(([path, content]) => ({ path: normalizePath(path), content }))
  .sort((a, b) => a.path.localeCompare(b.path));

export function getNetworkDocument(path: string): string {
  const found = networkDocuments.find((doc) => doc.path === path);
  if (!found) throw new Error(`Document du réseau introuvable : ${path}`);
  return found.content;
}

export function networkContext(paths: string[]): string {
  return paths
    .map((path) => `\n\n===== ${path} =====\n${getNetworkDocument(path)}`)
    .join('');
}

export function embeddedNetworkFiles(): Array<{ path: string; content: string }> {
  return networkDocuments
    .filter((doc) => doc.path.startsWith('agents/') || doc.path.startsWith('skills/') || doc.path.startsWith('contracts/'))
    .map((doc) => ({ path: `.agents/${doc.path}`, content: doc.content }));
}

export function buildNetworkManifest(): string {
  const agents = networkDocuments.filter((d) => d.path.startsWith('agents/')).map((d) => d.path.replace('agents/', ''));
  const skills = networkDocuments.filter((d) => d.path.startsWith('skills/')).map((d) => d.path.replace('skills/', ''));
  const contracts = networkDocuments.filter((d) => d.path.startsWith('contracts/')).map((d) => d.path.replace('contracts/', ''));
  const lines = [
    'schema_version: 1',
    'canonical_instructions: AGENTS.md',
    'network:',
    '  agents_dir: .agents/agents',
    '  skills_dir: .agents/skills',
    '  contracts_dir: .agents/contracts',
    'adapters:',
    '  - CLAUDE.md',
    '  - GEMINI.md',
    '  - .github/copilot-instructions.md',
    '  - .junie/AGENTS.md',
    '  - .cursor/rules/00-project.mdc',
    '  - .roo/rules/00-project.md',
    '  - .windsurf/rules/00-project.md',
    'embedded:',
    '  agents:',
    ...agents.map((p) => `    - ${p}`),
    '  skills:',
    ...skills.map((p) => `    - ${p}`),
    '  contracts:',
    ...contracts.map((p) => `    - ${p}`),
  ];
  return `${lines.join('\n')}\n`;
}
