import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // The Device Wizard sends a device photo (base64) to a server action. Next's default 1MB
    // server-action body limit rejects most photos; the wizard downscales client-side, but raise
    // the cap so a fallback/large image still gets through (the action itself caps at 8MB).
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
