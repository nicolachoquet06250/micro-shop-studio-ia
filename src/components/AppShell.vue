<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import StudioIcon from './StudioIcon.vue';
import { useThemeStore } from '../stores/theme';

useThemeStore();

const props = withDefaults(defineProps<{ active: 'generator' | 'settings'; topbarSticky?: boolean }>(), {
  topbarSticky: true,
});

const renderedTopbarSticky = ref(props.topbarSticky);
const topbarExiting = ref(false);
const topbarEntering = ref(false);
let topbarExitTimer: ReturnType<typeof setTimeout> | null = null;
let topbarEnterFrame = 0;

function clearTopbarExitTimer() {
  if (topbarExitTimer !== null) {
    clearTimeout(topbarExitTimer);
    topbarExitTimer = null;
  }
}

function clearTopbarEnterFrame() {
  if (topbarEnterFrame) {
    cancelAnimationFrame(topbarEnterFrame);
    topbarEnterFrame = 0;
  }
}

watch(
  () => props.topbarSticky,
  (sticky) => {
    clearTopbarExitTimer();
    clearTopbarEnterFrame();

    if (sticky) {
      const wasRenderedSticky = renderedTopbarSticky.value;
      renderedTopbarSticky.value = true;
      topbarExiting.value = false;

      // Quand la barre retrouve son état sticky après être sortie du flux,
      // on la positionne d'abord juste au-dessus du viewport puis on retire
      // cette classe à la frame suivante pour déclencher le slide vers le bas.
      if (!wasRenderedSticky) {
        topbarEntering.value = true;

        // Force Vue puis le navigateur à peindre l'état initial
        // (sticky + translateY(-100%)) avant de lancer la transition.
        // Sans cette séparation, Vue peut regrouper les deux états dans
        // le même rendu et le slide-in devient imperceptible.
        void nextTick().then(() => {
          if (!props.topbarSticky) return;
          topbarEnterFrame = requestAnimationFrame(() => {
            topbarEnterFrame = requestAnimationFrame(() => {
              if (props.topbarSticky) topbarEntering.value = false;
              topbarEnterFrame = 0;
            });
          });
        });
      } else {
        topbarEntering.value = false;
      }
      return;
    }

    topbarEntering.value = false;

    // Garde la barre en position sticky le temps du slide-out. Elle ne repasse
    // dans le flux normal qu'une fois l'animation terminée.
    renderedTopbarSticky.value = true;
    requestAnimationFrame(() => {
      if (props.topbarSticky) return;
      topbarExiting.value = true;
      topbarExitTimer = setTimeout(() => {
        if (!props.topbarSticky) renderedTopbarSticky.value = false;
        topbarExiting.value = false;
        topbarExitTimer = null;
      }, 340);
    });
  },
);

const mobileNavOpen = ref(false);

const EDGE_SWIPE_ZONE = 24;
const SWIPE_TRIGGER_DISTANCE = 64;
const SWIPE_DIRECTION_RATIO = 1.35;

let touchEnabled = false;
let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;
let touchGesture: 'open' | 'close' | null = null;

function isTouchDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return navigator.maxTouchPoints > 0 || window.matchMedia('(any-pointer: coarse)').matches;
}

function isOffcanvasNavigationActive() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(max-width: 780px)').matches;
}

function resetTouchGesture() {
  touchTracking = false;
  touchGesture = null;
}

function onTouchStart(event: TouchEvent) {
  if (!touchEnabled || !isOffcanvasNavigationActive() || event.touches.length !== 1) {
    resetTouchGesture();
    return;
  }

  const touch = event.touches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;

  if (!mobileNavOpen.value && touchStartX <= EDGE_SWIPE_ZONE) {
    touchTracking = true;
    touchGesture = 'open';
    return;
  }

  if (mobileNavOpen.value) {
    const sidebar = document.getElementById('studio-mobile-navigation');
    const sidebarRight = sidebar?.getBoundingClientRect().right ?? Math.min(window.innerWidth * 0.86, 320);
    if (touchStartX <= sidebarRight) {
      touchTracking = true;
      touchGesture = 'close';
      return;
    }
  }

  resetTouchGesture();
}

function onTouchMove(event: TouchEvent) {
  if (!touchTracking || event.touches.length !== 1) return;

  const touch = event.touches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;

  // Dès qu'un geste devient clairement vertical, on l'abandonne afin de ne
  // jamais perturber le scroll natif de la page ou de la sidebar.
  if (Math.abs(deltaY) > Math.abs(deltaX) * SWIPE_DIRECTION_RATIO) {
    resetTouchGesture();
  }
}

function onTouchEnd(event: TouchEvent) {
  if (!touchTracking || !touchGesture || event.changedTouches.length !== 1) {
    resetTouchGesture();
    return;
  }

  const touch = event.changedTouches[0];
  const deltaX = touch.clientX - touchStartX;
  const deltaY = touch.clientY - touchStartY;
  const horizontalEnough = Math.abs(deltaX) >= SWIPE_TRIGGER_DISTANCE;
  const horizontalDominant = Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_DIRECTION_RATIO;

  if (horizontalEnough && horizontalDominant) {
    if (touchGesture === 'open' && deltaX > 0) mobileNavOpen.value = true;
    if (touchGesture === 'close' && deltaX < 0) closeMobileNav();
  }

  resetTouchGesture();
}

function closeMobileNav() {
  mobileNavOpen.value = false;
}

function toggleMobileNav() {
  mobileNavOpen.value = !mobileNavOpen.value;
}

function onSidebarNavigation(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('a, button')) closeMobileNav();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && mobileNavOpen.value) closeMobileNav();
}

watch(mobileNavOpen, (open) => {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('mobile-nav-open', open);
});

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  touchEnabled = isTouchDevice();
  if (touchEnabled) {
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', resetTouchGesture, { passive: true });
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (touchEnabled) {
    window.removeEventListener('touchstart', onTouchStart);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('touchcancel', resetTouchGesture);
  }
  clearTopbarExitTimer();
  clearTopbarEnterFrame();
  document.documentElement.classList.remove('mobile-nav-open');
});
</script>

<template>
  <div class="studio-shell">
    <aside id="studio-mobile-navigation" class="studio-sidebar" :class="{ open: mobileNavOpen }" @click="onSidebarNavigation">
      <a class="brand" href="/">
        <img class="brand-mark" src="/brand-mark.png" alt="" />
        <span class="brand-copy">
          <strong>Micro Shop Studio</strong>
          <small>AI commerce generator</small>
        </span>
      </a>

      <nav class="mobile-primary-nav" aria-label="Navigation principale">
        <a href="/" :class="{ active: active === 'generator' }"><StudioIcon name="sparkles" :size="18" /> Générateur</a>
        <a href="/settings" :class="{ active: active === 'settings' }"><StudioIcon name="settings" :size="18" /> Paramètres IA</a>
      </nav>

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
      <header
        class="studio-topbar"
        :class="{
          'desktop-sticky-enabled': renderedTopbarSticky,
          'desktop-sticky-exit': topbarExiting,
          'desktop-sticky-enter': topbarEntering,
        }"
      >
        <a class="mobile-title-brand" href="/">
          <img class="brand-mark" src="/brand-mark.png" alt="" />
          <span>Micro Shop Studio</span>
        </a>
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
        <button
          type="button"
          class="mobile-menu-toggle"
          :class="{ active: mobileNavOpen }"
          :aria-expanded="mobileNavOpen"
          aria-controls="studio-mobile-navigation"
          :aria-label="mobileNavOpen ? 'Fermer la navigation' : 'Ouvrir la navigation'"
          @click="toggleMobileNav"
        >
          <span></span><span></span><span></span>
        </button>
      </header>
      <main><slot /></main>
    </section>
    <button v-show="mobileNavOpen" type="button" class="mobile-nav-backdrop" aria-label="Fermer la navigation" @click="closeMobileNav"></button>
  </div>
</template>

<style scoped>
.studio-shell{min-height:100vh;display:grid;grid-template-columns:280px minmax(0,1fr);background:var(--app-bg);color:var(--text)}
.studio-sidebar{position:fixed;inset:0 auto 0 0;width:280px;height:100vh;display:flex;flex-direction:column;border-right:1px solid var(--line-soft);background:var(--sidebar-bg);padding:0 24px 20px;z-index:20}
.brand{height:92px;display:flex;align-items:center;gap:13px;text-decoration:none;border-bottom:1px solid var(--line-soft);margin:0 -24px;padding:0 36px}.brand-mark{width:34px;height:34px;display:block;flex:0 0 auto;object-fit:contain}.brand-copy{display:grid}.brand strong{font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.05}.brand small{font-size:11px;color:var(--muted);margin-top:3px}.sidebar-slot{padding:38px 0 20px;min-height:0;overflow:auto}.sidebar-resources{margin-top:auto;border-top:1px solid var(--line-soft);padding:24px 8px 18px;display:grid;gap:14px}.sidebar-resources>span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.sidebar-resources a{display:flex;align-items:center;gap:12px;text-decoration:none;font-size:13px;color:var(--muted-strong)}.help-dot{width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800}.sidebar-user{border-top:1px solid var(--line-soft);padding:18px 8px 0;display:grid;grid-template-columns:38px 1fr auto;align-items:center;gap:10px}.avatar{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;background:var(--surface-soft);font-size:11px;font-weight:800}.sidebar-user>span:nth-child(2){display:grid;gap:2px}.sidebar-user strong{font-size:12px}.sidebar-user small{font-size:11px;color:var(--muted)}.chevron{color:var(--muted)}
.mobile-primary-nav,.mobile-title-brand,.mobile-menu-toggle,.mobile-nav-backdrop{display:none}.studio-content{grid-column:2;min-width:0;background:var(--app-bg)}.studio-topbar{height:78px;display:flex;align-items:center;justify-content:flex-end;gap:30px;padding:0 44px;border-bottom:1px solid var(--line-soft);background:var(--topbar-bg);position:relative;top:auto;z-index:18}.studio-topbar.desktop-sticky-enabled{position:sticky;top:0}@media(min-width:781px){.studio-topbar.desktop-sticky-enabled{transform:translateY(0);transition:transform .32s cubic-bezier(.22,1,.36,1);will-change:transform}.studio-topbar.desktop-sticky-enabled.desktop-sticky-exit,.studio-topbar.desktop-sticky-enabled.desktop-sticky-enter{transform:translateY(-100%)}}@media(prefers-reduced-motion:reduce){.studio-topbar.desktop-sticky-enabled{transition:none!important}}.topbar-search{margin-right:auto;width:min(360px,36vw);height:42px;display:flex;align-items:center;gap:10px;border:1px solid var(--line-soft);background:var(--input-bg);padding:0 13px}.topbar-search input{width:100%;border:0;outline:0;background:transparent;color:var(--text);font-size:12px}.topbar-search input::placeholder{color:var(--muted)}.topnav{display:flex;align-items:center;gap:10px}.topnav a{height:44px;padding:0 18px;display:flex;align-items:center;gap:8px;text-decoration:none;font-size:13px;color:var(--text);border:1px solid transparent}.topnav a.active{background:var(--accent);color:var(--accent-contrast)}main{min-width:0}
@media(max-width:1080px){.studio-shell{grid-template-columns:220px minmax(0,1fr)}.studio-sidebar{width:220px;padding-left:18px;padding-right:18px}.brand{margin:0 -18px;padding:0 24px}.studio-topbar{padding:0 24px}.topbar-search{display:none}}
@media(max-width:780px){
  .studio-shell{display:block}
  .studio-content{grid-column:auto}
  .studio-sidebar{position:fixed;inset:0 auto 0 0;width:min(86vw,320px);height:100dvh;padding:0 18px 18px;transform:translateX(-102%);transition:transform .22s ease;z-index:80;box-shadow:18px 0 48px color-mix(in srgb,#000 28%,transparent)}
  .studio-sidebar.open{transform:translateX(0)}
  .studio-sidebar .brand{height:72px;margin:0 -18px;padding:0 22px}
  .studio-sidebar .brand-copy small{display:block}
  .mobile-primary-nav{display:grid;gap:5px;padding:18px 0 6px;border-bottom:1px solid var(--line-soft)}
  .mobile-primary-nav a{height:46px;display:flex;align-items:center;gap:12px;padding:0 14px;text-decoration:none;color:var(--muted-strong);border-left:2px solid transparent;font-size:13px}
  .mobile-primary-nav a.active{background:var(--accent-soft);color:var(--text);border-left-color:var(--accent);font-weight:800}
  .sidebar-slot{padding:14px 0 20px;min-height:0;overflow:auto}
  .sidebar-resources{display:grid;margin-top:auto;padding-top:18px}
  .sidebar-user{display:none}
  .studio-topbar{height:64px;position:sticky;top:0;padding:0 14px 0 16px;justify-content:space-between;z-index:50}
  .topnav{display:none}
  .mobile-title-brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:var(--text);font-family:Georgia,'Times New Roman',serif;font-weight:700;font-size:15px;min-width:0}
  .mobile-title-brand .brand-mark{width:30px;height:30px;flex:0 0 auto;object-fit:contain}
  .mobile-title-brand>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .mobile-menu-toggle{display:grid;width:42px;height:42px;place-content:center;gap:5px;border:1px solid var(--line-soft);background:var(--surface);color:var(--text);padding:0;flex:0 0 auto}
  .mobile-menu-toggle span{display:block;width:19px;height:1.5px;background:currentColor;transition:transform .18s ease,opacity .18s ease}
  .mobile-menu-toggle.active span:nth-child(1){transform:translateY(6.5px) rotate(45deg)}
  .mobile-menu-toggle.active span:nth-child(2){opacity:0}
  .mobile-menu-toggle.active span:nth-child(3){transform:translateY(-6.5px) rotate(-45deg)}
  .mobile-nav-backdrop{display:block;position:fixed;inset:0;z-index:70;border:0;background:color-mix(in srgb,#000 42%,transparent);padding:0}
}
:global(html.mobile-nav-open){overflow:hidden}
</style>
