import { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const nextConfig: NextConfig = {
  turbopack: {
    root: process.cwd(),
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
