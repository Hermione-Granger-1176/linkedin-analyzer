import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
    base: "./",
    root: "web",
    publicDir: "public",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
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
                short_name: "LinkedIn Analyzer",
                start_url: "./",
                scope: "./",
                display: "standalone",
                background_color: "rgba(250, 248, 243, 1)",
                theme_color: "rgba(250, 248, 243, 1)",
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
                ],
            },
        }),
    ],
});
