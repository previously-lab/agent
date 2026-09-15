import { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withWorkflow } from "workflow/next";

// The local workflow world's queue delivers each step to the flow endpoint
// over HTTP with 30s headers/body timeouts (@workflow/world-local defaults).
// A housekeeping or doStreamStep turn whose LLM call takes >30s (slow
// provider, big slice) trips that ceiling: the delivery is killed mid-step,
// the queue redelivers, and doStreamStep (maxRetries=0 by design) fails the
// whole run with a spurious FatalError. Steps' own model calls are already
// bounded at 120s by withFirstByteTimeout (src/lib/models/fetch-timeout.ts),
// so 300s of transport headroom matches the platform's wall-clock ceiling.
process.env.WORKFLOW_LOCAL_HEADERS_TIMEOUT_MS ??= "300000";
process.env.WORKFLOW_LOCAL_BODY_TIMEOUT_MS ??= "300000";

const nextConfig: NextConfig = {
  // Produce .next/standalone ONLY for the client kernel packaging build
  // (NEXT_PUBLIC_PREVIOUSLY_TARGET=client, set by scripts/build-standalone.mjs —
  // see doc/design/v0.9-client.md §6). It MUST stay off cloud deploys: Next
  // 16.3 + standalone breaks Vercel's onBuildComplete (the adapter build skips
  // the whole-server trace file, then packaging reads it — ENOENT
  // .next/next-server.js.nft.json, vercel/next.js#96646).
  output:
    process.env.NEXT_PUBLIC_PREVIOUSLY_TARGET === "client"
      ? "standalone"
      : undefined,
  // Keep runtime data directories out of the standalone trace. `memory/` is
  // traced only because getMemoryRoot()/demo-fs resolve paths dynamically via
  // `join(process.cwd(), ...)` — at runtime client mode re-roots memory at
  // MEMORY_ROOT and demo-fs reads `<cwd>/../you`, so neither reads
  // the copies Next would ship inside .next/standalone. Shipping them bloats
  // the @previously-lab/kernel artifact with local dev data.
  outputFileTracingExcludes: {
    "*": ["./memory/**/*", "./you/**/*"],
  },
  turbopack: {
    root: process.cwd(),
  },
  // ajv (pulled in by @ai-sdk/workflow for tool contextSchema validation)
  // uses dynamic require(), which Turbopack can't bundle into the generated
  // .well-known/workflow step route — keep it external and let Node require
  // it at runtime.
  serverExternalPackages: ["ajv"],
  // Docs moved to the official site — permanently redirect all in-app docs
  // URLs (bare and locale-prefixed) to https://previously.ldwid.com.
  async redirects() {
    return [
      {
        source: "/docs/:path*",
        destination: "https://previously.ldwid.com/docs/:path*",
        permanent: true,
      },
      {
        source: "/en/docs/:path*",
        destination: "https://previously.ldwid.com/en/docs/:path*",
        permanent: true,
      },
      {
        source: "/zh/docs/:path*",
        destination: "https://previously.ldwid.com/zh/docs/:path*",
        permanent: true,
      },
    ];
  },
};

const withNextIntl = createNextIntlPlugin();
export default withWorkflow(withNextIntl(nextConfig));
