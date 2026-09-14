import nextPlugin from "@next/eslint-plugin-next";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooksPlugin from "eslint-plugin-react-hooks";

const eslintConfig = [
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooksPlugin,
    },
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      // Packaged-kernel build artifact (gitignored; see scripts/pack-standalone.mjs).
      "dist-kernel/**",
      "next-env.d.ts",
      // Generated workflow entrypoints (bundled at build time; not hand-written source).
      "src/app/.well-known/workflow/v1/flow/route.js",
      "src/app/.well-known/workflow/v1/step/route.js",
    ],
  },
];

export default eslintConfig;
