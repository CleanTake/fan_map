import type { NextConfig } from "next";
import { resolve } from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: resolve(__dirname, ".."),
  },
  allowedDevOrigins: [
    "vilma-balsamiferous-coequally.ngrok-free.dev",
    ...(process.env.FANMAP_DEV_ORIGINS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
  ],
};

export default nextConfig;
