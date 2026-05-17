/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
    // Remotion bundler/renderer son herramientas Node-only (Chromium headless, esbuild,
    // webpack interno). No deben bundlearse al runtime de Next.js; se cargan dinámicamente
    // en el server cuando el pipeline las invoca.
    serverComponentsExternalPackages: [
      '@remotion/bundler',
      '@remotion/renderer',
      'esbuild',
    ],
  },
  transpilePackages: [
    '@video-factory/core',
    '@video-factory/contracts',
    '@video-factory/ui',
    '@video-factory/block-script-processor',
    '@video-factory/block-tts-elevenlabs',
    '@video-factory/block-subtitles-whisper',
    '@video-factory/block-image-gen-imagen',
    '@video-factory/block-compositor-remotion',
  ],
  webpack: (config, { isServer }) => {
    // Permite que webpack resuelva imports `./foo.js` a `./foo.ts` (estilo Node ESM
    // pero ejecutado por bundler). Estándar para monorepos TS con `type: module`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.js', '.ts', '.tsx'],
    };

    // En API routes (server bundles), marcar @remotion/bundler y @remotion/renderer
    // como externals — son Node-only (Chromium headless, esbuild, webpack interno) y
    // no deben bundlearse. `serverComponentsExternalPackages` no cubre API routes,
    // por eso lo hacemos a nivel webpack.
    if (isServer) {
      const externals = config.externals;
      const externalsList = Array.isArray(externals) ? externals : [externals].filter(Boolean);
      externalsList.push({
        '@remotion/bundler': 'commonjs @remotion/bundler',
        '@remotion/renderer': 'commonjs @remotion/renderer',
      });
      config.externals = externalsList;
    }

    return config;
  },
};

export default nextConfig;
