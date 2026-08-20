import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than build output, so Next has to
  // compile them itself.
  transpilePackages: ["@cubing-companion/engine", "@cubing-companion/cube-link"],
};

export default nextConfig;
