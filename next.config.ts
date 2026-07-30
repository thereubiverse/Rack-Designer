import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@napi-rs/canvas` ships a platform-specific `.node` binary that symbol discovery uses to
  // rasterise a PDF page server-side. Bundling it breaks the native binding lookup — it fails at
  // runtime with "Cannot find native binding", which surfaces as a generic "couldn't search this
  // plan" error. Listing it here keeps it a plain runtime require from node_modules.
  // pdfjs-dist is externalised for the same reason: it is loaded dynamically and resolves its
  // worker relative to its own package path.
  serverExternalPackages: ["@napi-rs/canvas", "pdfjs-dist"],
  experimental: {
    // The Device Wizard sends a device photo (base64) to a server action. Next's default 1MB
    // server-action body limit rejects most photos; the wizard downscales client-side, but raise
    // the cap so a fallback/large image still gets through (the action itself caps at 8MB).
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
