import { defineConfig, fontProviders } from 'astro/config';

export default defineConfig({
  i18n: { locales: ['es', 'en'], defaultLocale: 'es' },
  // self-hosted at build time: no render-blocking request to Google, files preloaded from our own origin
  fonts: [
    { provider: fontProviders.google(), name: 'Montserrat', cssVariable: '--font-sans', weights: [300, 400, 500, 600], subsets: ['latin'], fallbacks: ['sans-serif'] },
    { provider: fontProviders.google(), name: 'JetBrains Mono', cssVariable: '--font-mono', weights: [300, 400], subsets: ['latin'], fallbacks: ['monospace'] },
  ],
  // three is only reached through import(): pre-bundle it at startup, or Vite discovers it late,
  // re-optimizes and answers the page's requests with 504 "Outdated Optimize Dep" (blank hero in dev)
  vite: {
    optimizeDeps: {
      include: [
        'three',
        'three/addons/postprocessing/EffectComposer.js',
        'three/addons/postprocessing/RenderPass.js',
        'three/addons/postprocessing/UnrealBloomPass.js',
        'three/addons/postprocessing/OutputPass.js',
        'three/addons/geometries/RoundedBoxGeometry.js',
        'three/addons/environments/RoomEnvironment.js',
      ],
    },
  },
});
