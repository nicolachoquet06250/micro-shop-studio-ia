import { createApp } from 'vue';
import { createPinia } from 'pinia';
import GeneratorApp from '../../src/components/GeneratorApp.vue';
import SettingsApp from '../../src/components/SettingsApp.vue';
import '../../src/styles/global.css';

const Root = location.pathname.replace(/\/+$/, '') === '/settings' ? SettingsApp : GeneratorApp;
const app = createApp(Root);
app.use(createPinia());
app.mount('#app');
