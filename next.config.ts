import { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  // ajv (pulled in by @ai-sdk/workflow for tool contextSchema validation)
  // uses dynamic require(), which Turbopack can't bundle into the generated
  // .well-known/workflow step route — keep it external and let Node require
  // it at runtime.
  serverExternalPackages: ["ajv"],
};

const withNextIntl = createNextIntlPlugin();
export default withWorkflow(withNextIntl(nextConfig));
