<script setup lang="ts">
import StudioIcon from './StudioIcon.vue';
import { useThemeStore } from '../stores/theme';

useThemeStore();

defineProps<{ active: 'generator' | 'settings' }>();
</script>

<template>
  <div class="studio-shell">
    <aside class="studio-sidebar">
      <a class="brand" href="/">
        <span class="brand-mark">M</span>
        <span class="brand-copy">
          <strong>Micro Shop Studio</strong>
          <small>AI commerce generator</small>
        </span>
      </a>

      <div class="sidebar-slot">
        <slot name="sidebar" />
      </div>

      <div class="sidebar-resources">
        <span>Ressources</span>
        <a href="#"><StudioIcon name="file" :size="18" /> Documentation</a>
        <a href="#"><span class="help-dot">?</span> Aide & support</a>
      </div>

      <!-- sidebar-user volontairement masqué pour le moment.
      <div class="sidebar-user">
        <span class="avatar">MS</span>
        <span><strong>Workspace local</strong><small>Studio</small></span>
        <span class="chevron">⌄</span>
      </div>
      -->
    </aside>

    <section class="studio-content">
      <header class="studio-topbar">
        <!-- Barre de recherche désactivée tant que la recherche de projets n'est pas implémentée.
        <div class="topbar-search">
          <StudioIcon name="search" :size="18" />
          <input aria-label="Rechercher un projet" placeholder="Rechercher un projet…" />
        </div>
        -->
        <nav class="topnav">
          <a href="/" :class="{ active: active === 'generator' }">Générateur</a>
          <a href="/settings" :class="{ active: active === 'settings' }"><StudioIcon name="settings" :size="18" /> Paramètres IA</a>
        </nav>
      </header>
      <main><slot /></main>
    </section>
  </div>
</template>

<style scoped>
.studio-shell{min-height:100vh;display:grid;grid-template-columns:280px minmax(0,1fr);background:var(--app-bg);color:var(--text)}
.studio-sidebar{position:fixed;inset:0 auto 0 0;width:280px;height:100vh;display:flex;flex-direction:column;border-right:1px solid var(--line-soft);background:var(--sidebar-bg);padding:0 24px 20px;z-index:20}
.brand{height:92px;display:flex;align-items:center;gap:13px;text-decoration:none;border-bottom:1px solid var(--line-soft);margin:0 -24px;padding:0 36px}.brand-mark{width:34px;height:34px;display:grid;place-items:center;background:var(--accent);color:var(--accent-contrast);font-family:Georgia,serif;font-weight:800;font-size:18px;clip-path:polygon(0 0,100% 0,100% 100%,50% 76%,0 100%)}.brand-copy{display:grid}.brand strong{font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.05}.brand small{font-size:11px;color:var(--muted);margin-top:3px}.sidebar-slot{padding:38px 0 20px;min-height:0;overflow:auto}.sidebar-resources{margin-top:auto;border-top:1px solid var(--line-soft);padding:24px 8px 18px;display:grid;gap:14px}.sidebar-resources>span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.sidebar-resources a{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:13px;color:var(--muted-strong)}.help-dot{width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800}.sidebar-user{border-top:1px solid var(--line-soft);padding:18px 8px 0;display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px}.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--surface-soft);font-size:11px;font-weight:800}.sidebar-user>span:nth-child(2){display:grid;gap:2px}.sidebar-user strong{font-size:12px}.sidebar-user small{font-size:11px;color:var(--muted)}.chevron{color:var(--muted)}
.studio-content{grid-column:2;min-width:0;background:var(--app-bg)}.studio-topbar{height:78px;display:flex;align-items:center;justify-content:flex-end;gap:30px;padding:0 44px;border-bottom:1px solid var(--line-soft);background:var(--topbar-bg);position:relative;z-index:18}.topbar-search{margin-right:auto;width:min(360px,36vw);height:42px;display:flex;align-items:center;gap:10px;border:1px solid var(--line-soft);background:var(--input-bg);padding:0 13px}.topbar-search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:12px}.topbar-search input::placeholder{color:var(--muted)}.topnav{display:flex;align-items:center;gap:10px}.topnav a{height:44px;padding:0 18px;display:flex;align-items:center;gap:8px;text-decoration:none;font-size:13px;color:var(--text);border:1px solid transparent}.topnav a.active{background:var(--accent);color:var(--accent-contrast)}main{min-width:0}
@media(max-width:1080px){.studio-shell{grid-template-columns:220px minmax(0,1fr)}.studio-sidebar{width:220px;padding-left:18px;padding-right:18px}.brand{margin:0 -18px;padding:0 24px}.studio-topbar{padding:0 24px}.topbar-search{display:none}}
@media(max-width:780px){.studio-shell{display:block}.studio-sidebar{position:relative;inset:auto;width:auto;height:auto;padding:0 14px 10px}.studio-content{grid-column:auto}.brand{height:70px;margin:0 -14px;padding:0 18px}.brand-copy small{display:none}.sidebar-slot{padding:10px 0;overflow:visible}.sidebar-resources,.sidebar-user{display:none}.studio-topbar{height:64px;position:sticky;padding:0 14px}.topnav{width:100%;justify-content:flex-end}.topnav a{padding:0 11px;font-size:12px}.topnav a svg{display:none}}
</style>
