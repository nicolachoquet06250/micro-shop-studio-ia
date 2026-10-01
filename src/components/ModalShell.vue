<script setup lang="ts">
defineProps<{
  open: boolean;
  title: string;
  subtitle?: string;
  wide?: boolean;
}>();

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="modal-backdrop" @mousedown.self="emit('close')">
      <section class="modal-card" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal-head">
          <div>
            <strong>{{ title }}</strong>
            <span v-if="subtitle">{{ subtitle }}</span>
          </div>
          <button type="button" class="close" aria-label="Fermer" @click="emit('close')">×</button>
        </header>
        <div class="modal-body"><slot /></div>
        <footer v-if="$slots.footer" class="modal-foot"><slot name="footer" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:10px;background:color-mix(in srgb,var(--app-bg) 74%,transparent);backdrop-filter:blur(10px)}
.modal-card{position:relative;width:min(980px,calc(100vw - 20px));max-height:calc(100vh - 20px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:0;background:var(--surface);box-shadow:var(--shadow)}
.modal-card.wide{width:min(1500px,calc(100vw - 20px));height:calc(100vh - 20px)}
.modal-head{min-height:68px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:10px 14px;border-bottom:1px solid var(--line-soft);background:var(--surface)}
.modal-head>div{display:grid;gap:4px;min-width:0}.modal-head strong{font-family:Georgia,"Times New Roman",serif;font-size:22px;line-height:1.05;font-weight:600;letter-spacing:-.025em;color:var(--text)}.modal-head span{font-size:10px;color:var(--muted);line-height:1.4}
.close{width:38px;height:38px;flex:none;border:1px solid var(--line);border-radius:0;background:var(--surface-2);color:var(--text);font-size:22px;line-height:1}.close:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.modal-body{flex:1;min-height:0;overflow:hidden;padding:10px;background:var(--surface);display:flex}.modal-body>*{width:100%;min-height:0}
.modal-foot{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:10px 14px;border-top:1px solid var(--line-soft);background:var(--surface)}
.modal-foot :deep(button){min-height:42px;border-radius:0;padding:9px 14px;font-size:10px;font-weight:800}
@media(max-width:700px){.modal-backdrop{padding:10px}.modal-card,.modal-card.wide{width:calc(100vw - 20px);max-height:calc(100vh - 20px)}.modal-card.wide{height:calc(100vh - 20px)}.modal-head{min-height:60px;padding:10px}.modal-head strong{font-size:19px}.modal-body{padding:10px}.modal-foot{padding:10px;flex-wrap:wrap}}
</style>
