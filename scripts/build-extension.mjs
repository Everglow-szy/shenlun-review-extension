import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const fromRoot = (...parts) => resolve(projectRoot, ...parts);

await mkdir(fromRoot("dist/assets"), { recursive: true });

async function bundleExtensionEntry(entry, filename, format, name) {
  await build({
    configFile: false,
    root: projectRoot,
    publicDir: false,
    logLevel: "warn",
    build: {
      outDir: fromRoot("dist/assets"),
      emptyOutDir: false,
      target: "chrome120",
      sourcemap: true,
      minify: false,
      lib: {
        entry: fromRoot(entry),
        formats: [format],
        name,
        fileName: () => filename
      }
    }
  });
}

await bundleExtensionEntry(
  "src/background/service-worker.ts",
  "service-worker.js",
  "es",
  "ShenlunServiceWorker"
);
await bundleExtensionEntry(
  "src/content/exam-content-script.ts",
  "exam-content-script.js",
  "iife",
  "ShenlunExamBridge"
);
await bundleExtensionEntry(
  "src/content/chatgpt-content-script.ts",
  "chatgpt-content-script.js",
  "iife",
  "ShenlunChatGPTBridge"
);
const manifest = JSON.parse(await readFile(fromRoot("dist/manifest.json"), "utf8"));
const required = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])
].filter(Boolean);

if (!required.includes("assets/service-worker.js")) {
  throw new Error("manifest.json 未引用构建后的 service worker");
}

console.log("Extension scripts bundled successfully.");
