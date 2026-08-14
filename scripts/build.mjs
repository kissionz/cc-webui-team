import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

const tscCli = "node_modules/typescript/bin/tsc";
execFileSync(process.execPath, [tscCli, "-p", "tsconfig.json"], { stdio: "inherit" });
execFileSync(process.execPath, [tscCli, "-p", "tsconfig.client.json"], { stdio: "inherit" });

await mkdir("dist/public", { recursive: true });
await Promise.all([
  cp("index.html", "dist/public/index.html"),
  cp("styles.css", "dist/public/styles.css"),
  cp("src/lineage/pyodps-helper.py", "dist/lineage/pyodps-helper.py"),
]);

await build({
  entryPoints: ["src/client/app.ts"],
  outfile: "dist/public/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});
