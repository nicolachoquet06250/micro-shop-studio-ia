<script setup lang="ts">
import { computed, onMounted } from 'vue';
import AppShell from './AppShell.vue';
import StudioIcon from './StudioIcon.vue';
import ThemeSwitch from './ThemeSwitch.vue';
import { useSettingsStore } from '../stores/settings';

const settings = useSettingsStore();
const statusLabel = computed(() => {
  if (settings.modelsLoading) return 'Chargement des modèles…';
  if (settings.modelsError) return settings.modelsError;
  if (settings.models.length) return `${settings.models.length} modèle(s) détecté(s)`;
  return 'Renseigne l’URL et la clé pour interroger /models.';
});

onMounted(() => {
  if (settings.baseUrl && settings.apiKey) void settings.refreshModels();
});
</script>

<template>
  <AppShell active="settings">
    <template #sidebar>
      <nav class="settings-side-nav">
        <a href="/settings" class="active"><StudioIcon name="settings" :size="19" /> Paramètres IA</a>
        <a href="/"><StudioIcon name="sparkles" :size="19" /> Générateur</a>
      </nav>
    </template>

    <section class="settings-hero">
      <p>Configuration locale</p>
      <h1>Paramètres de l’API IA</h1>
      <span>Configure le fournisseur, le modèle et l’apparence de Micro Shop Studio.</span>
    </section>

    <div class="settings-layout">
      <section class="settings-panel">
        <header>
          <div><h2>Connexion IA</h2><p>Ces informations restent dans le stockage local de ce navigateur.</p></div>
          <span class="status" :class="{ ok: settings.ready }">{{ settings.ready ? 'Prêt' : 'À configurer' }}</span>
        </header>

        <div class="settings-grid">
          <label>
            <span>URL de base de l’API <b>*</b></span>
            <input v-model.trim="settings.baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="off" />
            <small>La liste est chargée depuis <code>&lt;baseUrl&gt;/models</code>.</small>
          </label>

          <label>
            <span>Clé API <b>*</b></span>
            <input v-model="settings.apiKey" type="password" placeholder="sk-…" autocomplete="off" />
            <small>La clé est transmise au proxy Astro, puis à l’API distante côté serveur.</small>
          </label>

          <label class="full">
            <span>Modèle <b>*</b></span>
            <div class="select-row">
              <select v-model="settings.model" :disabled="settings.modelsLoading || !settings.models.length">
                <option value="" disabled>Sélectionner un modèle</option>
                <option v-for="model in settings.models" :key="model" :value="model">{{ model }}</option>
              </select>
              <button type="button" class="secondary" :disabled="settings.modelsLoading || !settings.baseUrl || !settings.apiKey" @click="settings.refreshModels">Actualiser</button>
            </div>
            <small :class="{ error: settings.modelsError }">{{ statusLabel }}</small>
          </label>

          <label>
            <span>Temperature</span>
            <input v-model.number="settings.temperature" type="number" min="0" max="2" step="0.1" inputmode="decimal" />
            <small>Contrôle la variabilité des réponses. Valeur enregistrée et envoyée à chaque requête IA. Certains modèles n’acceptent que leur valeur par défaut (souvent <code>1</code>).</small>
          </label>

          <label class="full">
            <span>Compatibilité du raisonnement</span>
            <div class="select-row">
              <select v-model="settings.reasoningStrategy">
                <option value="auto">Automatique — recommandé</option>
                <option value="reasoning_effort">OpenAI-compatible — reasoning_effort</option>
                <option value="vllm">vLLM — chat_template_kwargs</option>
                <option value="prompt">Prompt portable — /think /no_think + consigne</option>
                <option value="none">Aucun contrôle explicite</option>
              </select>
              <button type="button" class="secondary" @click="settings.clearReasoningCache">Réinitialiser détection</button>
            </div>
            <small>En automatique, l’application négocie la stratégie compatible avec l’endpoint et la mémorise par URL + modèle.</small>
          </label>
        </div>
      </section>

      <aside class="settings-aside">
        <section class="appearance-card">
          <div class="appearance-title"><StudioIcon name="sun" :size="20" /><div><h3>Apparence</h3><p>Par défaut, l’interface suit le thème du système.</p></div></div>
          <ThemeSwitch />
        </section>

        <section class="proxy-card">
          <StudioIcon name="shield" :size="20" />
          <div><strong>Proxy Astro intégré</strong><p>Le navigateur appelle uniquement <code>/api/openai/*</code>. Astro relaie ensuite les requêtes vers l’API distante pour éviter les blocages CORS.</p></div>
        </section>
      </aside>
    </div>
  </AppShell>
</template>

<style scoped>
.settings-side-nav{display:grid;gap:5px}.settings-side-nav a{height:48px;display:flex;align-items:center;gap:13px;padding:0 14px;text-decoration:none;color:var(--muted-strong);border-left:2px solid transparent;font-size:13px}.settings-side-nav a:hover{background:var(--surface-soft);color:var(--text)}.settings-side-nav a.active{background:var(--accent-soft);color:var(--text);border-left-color:var(--accent);font-weight:800}
.settings-hero{padding:54px 52px 34px;border-bottom:1px solid var(--line-soft);background:linear-gradient(90deg,var(--surface) 0%,var(--app-bg) 70%)}.settings-hero>p{margin:0 0 10px;color:var(--accent);text-transform:uppercase;letter-spacing:.17em;font-size:10px;font-weight:900}.settings-hero h1{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:46px;letter-spacing:-.045em;font-weight:500}.settings-hero>span{display:block;margin-top:10px;color:var(--muted);font-size:13px}
.settings-layout{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;padding:28px 44px 60px}.settings-panel,.appearance-card,.proxy-card{border:1px solid var(--line-soft);background:var(--surface);box-shadow:var(--shadow-sm)}.settings-panel{padding:30px 34px}.settings-panel>header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding-bottom:24px;border-bottom:1px solid var(--line-soft)}.settings-panel h2{margin:0;font-family:Georgia,"Times New Roman",serif;font-size:28px}.settings-panel header p{margin:5px 0 0;color:var(--muted);font-size:11px}.status{padding:6px 9px;border:1px solid var(--line);font-size:9px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.status.ok{border-color:color-mix(in srgb,var(--success) 30%,var(--line));color:var(--success)}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 18px;padding-top:25px}.settings-grid label{display:grid;gap:8px}.settings-grid .full{grid-column:1/-1}.settings-grid label>span{font-size:12px;font-weight:800}.settings-grid b{color:var(--accent)}input,select{width:100%;min-height:46px;border:1px solid var(--line);background:var(--input-bg);color:var(--text);padding:11px 13px;outline:none;border-radius:0;font-size:12px}input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 14%,transparent)}small{color:var(--muted);font-size:10px;line-height:1.45}.error{color:var(--danger)}.select-row{display:grid;grid-template-columns:1fr auto;gap:8px}.secondary{min-height:46px;border:1px solid var(--line);background:transparent;color:var(--text);padding:0 15px;font-size:10px;font-weight:800}.secondary:disabled{opacity:.45}.settings-aside{display:grid;align-content:start;gap:14px}.appearance-card,.proxy-card{padding:20px}.appearance-card{display:grid;gap:18px}.appearance-title{display:flex;align-items:flex-start;gap:11px;color:var(--accent)}.appearance-title>div{display:grid;gap:3px}.appearance-title h3{margin:0;color:var(--text);font-family:Georgia,"Times New Roman",serif;font-size:20px}.appearance-title p,.proxy-card p{margin:0;color:var(--muted);font-size:10px;line-height:1.5}.proxy-card{display:flex;align-items:flex-start;gap:11px;color:var(--accent)}.proxy-card>div{display:grid;gap:5px}.proxy-card strong{color:var(--text);font-size:12px}code{color:var(--accent)}
@media(max-width:1050px){.settings-layout{grid-template-columns:1fr;padding:24px}.settings-aside{grid-template-columns:1fr 1fr}.settings-hero{padding-left:24px}}
@media(max-width:700px){.settings-grid{grid-template-columns:1fr}.settings-grid .full{grid-column:auto}.settings-aside{grid-template-columns:1fr}.select-row{grid-template-columns:1fr}.settings-hero{padding:34px 18px}.settings-hero h1{font-size:38px}.settings-layout{padding:14px}.settings-panel{padding:22px 16px}}
</style>
