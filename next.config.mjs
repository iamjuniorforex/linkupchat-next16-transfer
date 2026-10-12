/** @type {import('next').NextConfig} */

// Frame policy: the Arena Live Preview renders the app inside a proxy/iframe,
// so blocking framing breaks the browser-accessible preview. Frame blocking is
// only enforced in production builds (or when ALLOWED_FRAME_ORIGINS is unset in
// production). Never hard-code secrets here — configuration lives in env vars.
const isProd = process.env.NODE_ENV === 'production';
const allowedFrameOrigins = process.env.ALLOWED_FRAME_ORIGINS ?? '';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' }
];

if (isProd && !allowedFrameOrigins) {
  securityHeaders.push({ key: 'X-Frame-Options', value: 'DENY' });
  securityHeaders.push({
    key: 'Content-Security-Policy',
    value: "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  });
}
if (isProd && allowedFrameOrigins) {
  securityHeaders.push({
    key: 'Content-Security-Policy',
    value: `object-src 'none'; base-uri 'self'; frame-ancestors 'self' ${allowedFrameOrigins}`
  });
}
if (isProd) {
  securityHeaders.push({
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains'
  });
}

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [],
    formats: ['image/avif', 'image/webp']
  },
  experimental: {
    serverComponentsExternalPackages: ['bcryptjs', '@aws-sdk/client-s3']
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders
      }
    ];
  }
};

export default nextConfig;
