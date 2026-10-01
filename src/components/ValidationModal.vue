<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ValidationEvent, ValidationLoopOutcome } from '../lib/validation';

const props = defineProps<{
  running: boolean;
  outcome: ValidationLoopOutcome | null;
  events: ValidationEvent[];
  terminal: string;
}>();

const selectedAttempt = ref(-1);
const activeAttempt = computed(() => {
  const attempts = props.outcome?.attempts ?? [];
  if (!attempts.length) return null;
  const index = selectedAttempt.value < 0 ? attempts.length - 1 : Math.min(selectedAttempt.value, attempts.length - 1);
  return attempts[index] ?? null;
});

const statusLabel = computed(() => props.running ? 'Validation en cours' : props.outcome?.status ?? 'En attente');
</script>

<template>
  <div class="validation-view">
    <div class="summary">
      <div><span>Statut</span><strong>{{ statusLabel }}</strong></div>
      <div><span>Passes</span><strong>{{ outcome?.attempts.length ?? 0 }}</strong></div>
      <div><span>Preview</span><strong>{{ outcome?.previewAvailable ? 'Disponible' : '—' }}</strong></div>
    </div>

    <div v-if="outcome?.attempts.length" class="attempt-tabs">
      <button
        v-for="(attempt,index) in outcome.attempts"
        :key="attempt.index"
        type="button"
        :class="{active:(selectedAttempt<0?outcome.attempts.length-1:selectedAttempt)===index}"
        @click="selectedAttempt=index"
      >
        Passe {{ attempt.index }} · {{ attempt.passed ? 'PASS' : 'FAIL' }}
      </button>
    </div>

    <div class="grid">
      <section class="results-pane">
        <template v-if="activeAttempt">
          <article v-for="runtime in activeAttempt.runtimes" :key="runtime.runtime" class="runtime-card">
            <header><strong>{{ runtime.label }}</strong><span :class="runtime.passed ? 'ok' : 'ko'">{{ runtime.passed ? 'PASS' : 'FAIL' }}{{ runtime.partial ? ' · partiel' : '' }}</span></header>
            <p v-for="note in runtime.notes" :key="note">{{ note }}</p>
            <div v-for="command in runtime.commands" :key="command.command+command.label" class="command" :class="command.status">
              <div><strong>{{ command.label }}</strong><span>{{ command.status }} · {{ command.durationMs }} ms</span></div>
              <code>$ {{ command.command }}</code>
              <pre v-if="command.output">{{ command.output }}</pre>
            </div>
          </article>
          <div v-if="activeAttempt.changedFiles.length" class="repair-box">
            <strong>Correction IA appliquée</strong>
            <span>{{ activeAttempt.aiSummary }}</span>
            <code v-for="file in activeAttempt.changedFiles" :key="file">{{ file }}</code>
          </div>
        </template>
        <div v-else class="empty">Les résultats détaillés apparaîtront après la première passe.</div>
      </section>
      <aside class="terminal-pane">
        <header><strong>Terminal navigateur</strong><span>{{ events.length }} événements</span></header>
        <pre>{{ terminal || 'Aucune sortie pour le moment.' }}</pre>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.validation-view{padding:10px;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:10px}.summary>div{display:grid;gap:3px;padding:10px;border:1px solid var(--line);border-radius:0;background:var(--surface-2)}.summary span{font-size:9px;color:var(--muted)}.summary strong{font-size:12px}
.attempt-tabs{display:flex;gap:5px;overflow:auto;margin-bottom:10px}.attempt-tabs button{border:1px solid var(--line);background:var(--surface-2);color:var(--muted);border-radius:0;padding:7px 9px;font-size:9px;white-space:nowrap}.attempt-tabs button.active{color:var(--text);border-color:rgba(124,140,255,.4);background:var(--accent-soft)}
.grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(340px,.85fr);flex:1;min-height:0;border:1px solid var(--line);border-radius:0;overflow:hidden}.results-pane{padding:10px;min-height:0;overflow:auto;overscroll-behavior:contain;display:grid;align-content:start;gap:9px}.runtime-card{border:1px solid var(--line);border-radius:0;overflow:hidden;background:var(--surface)}.runtime-card>header{display:flex;justify-content:space-between;gap:10px;padding:10px;border-bottom:1px solid var(--line)}.runtime-card>header strong{font-size:10px}.runtime-card>header span{font-size:9px}.ok{color:var(--success)}.ko{color:var(--danger)}.runtime-card>p{margin:8px 10px;color:var(--muted);font-size:9px;line-height:1.5}
.command{margin:8px;border:1px solid var(--line);border-radius:0;overflow:hidden}.command>div{display:flex;justify-content:space-between;gap:8px;padding:7px 8px;background:var(--surface-2)}.command strong,.command span{font-size:9px}.command span{color:var(--muted)}.command code{display:block;padding:7px 8px;font-size:9px;color:var(--muted-strong)}.command pre{max-height:180px;overflow:auto;margin:0;padding:8px;border-top:1px solid var(--line);white-space:pre-wrap;word-break:break-word;font:9px/1.45 ui-monospace,monospace;color:var(--muted-strong);background:var(--surface-2)}.command.passed{border-color:rgba(86,214,160,.18)}.command.failed{border-color:rgba(255,107,129,.25)}
.repair-box{display:grid;gap:5px;padding:10px;border:1px solid rgba(124,140,255,.2);border-radius:0;background:var(--accent-soft)}.repair-box strong{font-size:10px}.repair-box span,.repair-box code{font-size:9px;color:var(--muted)}
.terminal-pane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border-left:1px solid var(--line);background:var(--surface)}.terminal-pane header{display:flex;justify-content:space-between;padding:9px 10px;border-bottom:1px solid var(--line)}.terminal-pane strong{font-size:10px}.terminal-pane span{font-size:9px;color:var(--muted)}.terminal-pane pre{flex:1;min-height:0;max-height:none;overflow:auto;overscroll-behavior:contain;margin:0;padding:12px;white-space:pre-wrap;word-break:break-word;font:9px/1.5 ui-monospace,monospace;color:var(--muted-strong)}.empty{padding:30px;text-align:center;color:var(--muted);font-size:10px}
@media(max-width:900px){.grid{grid-template-columns:1fr}.terminal-pane{border-left:0;border-top:1px solid var(--line)}}
</style>
