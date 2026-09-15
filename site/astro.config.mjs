import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://leningrad-codex-tei.netlify.app',
  output: 'static',
  integrations: [sitemap()],
});
