/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
  transpilePackages: ['@video-factory/core', '@video-factory/contracts', '@video-factory/ui'],
};

export default nextConfig;
