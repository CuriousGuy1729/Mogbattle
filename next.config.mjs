import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Never bundle the browser-only TFJS engine into the server build.
      // loadHuman() returns before the dynamic import on the server, so this
      // external is resolved-but-never-executed there.
      config.externals.push({ "@vladmandic/human": "commonjs @vladmandic/human" });
    } else {
      // Use the self-contained browser ESM build (no tfjs-node dependency).
      config.resolve.alias["@vladmandic/human$"] = path.join(
        __dirname,
        "node_modules/@vladmandic/human/dist/human.esm.js"
      );
    }
    return config;
  },
};

export default nextConfig;
