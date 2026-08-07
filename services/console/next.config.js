// @ts-check

/**
 * Next.js config for the Quill console.
 *
 * - `output: 'standalone'` produces a self-contained server bundle for the
 *   container image (small image, no full node_modules copy).
 * - No remote images: the console renders no imagery beyond inline SVG, so
 *   next/image remote loading stays off by default (no remotePatterns).
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
};

module.exports = nextConfig;
