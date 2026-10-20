import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  allowedDevOrigins: ["vilma-balsamiferous-coequally.ngrok-free.dev"],
};

export default nextConfig;
