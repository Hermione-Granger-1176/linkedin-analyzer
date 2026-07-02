import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const sentryUploadEnabled = Boolean(
    process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default defineConfig({
    base: "./",
    root: "web",
    publicDir: "public",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        sourcemap: sentryUploadEnabled ? "hidden" : false,
    },
    plugins: [
        VitePWA({
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.js",
            injectRegister: false,
            injectManifest: {
                globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest,woff2}"],
            },
            manifest: {
                name: "LinkedIn Analyzer",
                short_name: "LI Analyzer",
                description:
                    "Clean and analyze your LinkedIn data exports. Free, private, runs entirely in your browser.",
                start_url: "./",
                scope: "./",
                display: "standalone",
                background_color: "rgba(255, 253, 247, 1)",
                theme_color: "rgba(255, 253, 247, 1)",
                icons: [
                    {
                        src: "assets/icon-192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "assets/icon-512.png",
                        sizes: "512x512",
                        type: "image/png",
                    },
                    {
                        src: "assets/icon.svg",
                        sizes: "any",
                        type: "image/svg+xml",
                    },
                ],
            },
        }),
        ...(sentryUploadEnabled
            ? [
                  sentryVitePlugin({
                      org: process.env.SENTRY_ORG,
                      project: process.env.SENTRY_PROJECT,
                      authToken: process.env.SENTRY_AUTH_TOKEN,
                      telemetry: false,
                      release: {
                          name: process.env.VITE_APP_RELEASE || undefined,
                      },
                      sourcemaps: {
                          filesToDeleteAfterUpload: ["web/dist/**/*.map"],
                      },
                  }),
              ]
            : []),
    ],
});
