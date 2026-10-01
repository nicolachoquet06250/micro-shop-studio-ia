<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number; strokeWidth?: number }>(), { size: 20, strokeWidth: 1.8 });
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="name==='folder'"><path d="M3 6.5h6l2 2H21v9.5H3z"/><path d="M3 6.5V5h6l2 2"/></template>
    <template v-else-if="name==='grid'"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></template>
    <template v-else-if="name==='code'"><path d="m8 9-4 3 4 3"/><path d="m16 9 4 3-4 3"/><path d="m14 5-4 14"/></template>
    <template v-else-if="name==='shield'"><path d="M12 3 5 6v5c0 4.8 2.7 8 7 10 4.3-2 7-5.2 7-10V6z"/><path d="M12 8v5"/><path d="M12 17h.01"/></template>
    <template v-else-if="name==='plug'"><path d="m8 12 8-8"/><path d="m7 7 3 3"/><path d="m14 14 3 3"/><path d="M5 9 3 11a4 4 0 0 0 6 6l2-2"/><path d="m13 9 2-2a4 4 0 0 1 6 6l-2 2"/></template>
    <template v-else-if="name==='image'"><rect x="3" y="4" width="18" height="16"/><circle cx="8" cy="9" r="1.5"/><path d="m5 18 5-5 3 3 2-2 4 4"/></template>
    <template v-else-if="name==='archive'"><rect x="4" y="5" width="16" height="4"/><path d="M5 9v10h14V9"/><path d="M9 13h6"/></template>
    <template v-else-if="name==='sparkles'"><path d="m12 3 1.2 3.2L16 7.5l-2.8 1.3L12 12l-1.2-3.2L8 7.5l2.8-1.3z"/><path d="m18 13 .7 1.8 1.8.7-1.8.7L18 19l-.7-1.8-1.8-.7 1.8-.7z"/><path d="m5 12 .8 2.2L8 15l-2.2.8L5 18l-.8-2.2L2 15l2.2-.8z"/></template>
    <template v-else-if="name==='search'"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></template>
    <template v-else-if="name==='settings'"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H10v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1L3.8 17l.1-.1A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4V10h.1A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.3-1.9l-.1-.1L6.6 3.8l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V2.4h4v.1a1.7 1.7 0 0 0 1.4 1.7 1.7 1.7 0 0 0 1.9-.3l.1-.1 2.8 2.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7 1z"/></template>
    <template v-else-if="name==='sun'"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></template>
    <template v-else-if="name==='moon'"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.5 6.5 0 0 0 21 12.8z"/></template>
    <template v-else-if="name==='monitor'"><rect x="3" y="4" width="18" height="12"/><path d="M8 20h8M12 16v4"/></template>
    <template v-else-if="name==='database'"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5"/><path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></template>
    <template v-else-if="name==='bolt'"><path d="m13 2-8 12h7l-1 8 8-12h-7z"/></template>
    <template v-else-if="name==='check'"><path d="m5 12 4 4L19 6"/></template>
    <template v-else-if="name==='trash'"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></template>
    <template v-else-if="name==='arrow-right'"><path d="M5 12h14M14 7l5 5-5 5"/></template>
    <template v-else-if="name==='file'"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 12h6M9 16h6"/></template>
    <template v-else><circle cx="12" cy="12" r="8"/></template>
  </svg>
</template>
