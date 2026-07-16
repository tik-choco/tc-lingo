// Fetches mistlib (MISTLIB_REPO/MISTLIB_REF from .env), builds the wasm
// package with wasm-pack, and copies the output into src/vendor/mistlib
// so the app can import it locally. Runs automatically before dev/build;
// when MISTLIB_REPO is not configured it exits quietly because the vendored
// artifacts are committed and the app works without a rebuild.
//
// The source repository URL is intentionally NOT hardcoded — it is a private
// repo and this file may live in a public repository. Set MISTLIB_REPO in
// .env (gitignored) or in the environment.
import { existsSync, mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(rootDir, ".env");
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const repo = process.env.MISTLIB_REPO;
const ref = process.env.MISTLIB_REF || "develop";

if (!repo) {
  console.log("fetch-mistlib: MISTLIB_REPO not set — using the committed vendored build. Copy .env.example to .env to enable auto-fetch.");
  process.exit(0);
}

const cacheDir = path.join(rootDir, ".mistlib-src");
const vendorDir = path.join(rootDir, "src", "vendor", "mistlib");

function run(cmd, args, cwd, extraEnv) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

// Network failures (offline, DNS hiccups) must not block dev/build — the
// vendored artifacts are committed, so fall back to them with a warning.
try {
  if (!existsSync(path.join(cacheDir, ".git"))) {
    rmSync(cacheDir, { recursive: true, force: true });
    run("git", ["clone", repo, cacheDir]);
  }
  run("git", ["fetch", "origin", ref], cacheDir);
} catch (err) {
  if (existsSync(path.join(vendorDir, "pkg", "mistlib_wasm.js"))) {
    console.warn(`fetch-mistlib: could not reach ${ref} (${err.message.trim()}) — using the existing vendored build`);
    process.exit(0);
  }
  throw err;
}
run("git", ["checkout", "FETCH_HEAD"], cacheDir);

// Skip the rebuild + re-vendor when the vendored output already comes from
// this exact commit — wasm-pack output is not byte-reproducible, so an
// unconditional rebuild dirties src/vendor/mistlib on every run.
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cacheDir })
  .toString()
  .trim();
const stampPath = path.join(vendorDir, ".mistlib-commit");
if (existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === commit) {
  console.log(`mistlib (${ref} @ ${commit.slice(0, 12)}) already vendored — skipping build`);
  process.exit(0);
}

const wasmCrateDir = path.join(cacheDir, "mistlib-wasm");
const wasmPackBin = process.platform === "win32" ? "wasm-pack.exe" : "wasm-pack";
// Remap the builder's home directory in embedded rustc debug paths so the
// committed wasm never leaks the local username (checked before vendoring).
run(wasmPackBin, ["build", "--target", "web", "--release"], wasmCrateDir, {
  RUSTFLAGS: [process.env.RUSTFLAGS, `--remap-path-prefix=${os.homedir()}=/build`]
    .filter(Boolean)
    .join(" "),
});

const builtWasm = readFileSync(path.join(wasmCrateDir, "pkg", "mistlib_wasm_bg.wasm"));
const homeToken = path.basename(os.homedir());
if (builtWasm.includes(Buffer.from(`\\Users\\${homeToken}`)) || builtWasm.includes(Buffer.from(`/home/${homeToken}`))) {
  console.error(`Built wasm embeds the local username (${homeToken}) — refusing to vendor it.`);
  process.exit(1);
}

rmSync(vendorDir, { recursive: true, force: true });
mkdirSync(vendorDir, { recursive: true });
cpSync(path.join(wasmCrateDir, "pkg"), path.join(vendorDir, "pkg"), { recursive: true });
const wrapperDestDir = path.join(vendorDir, "wrappers", "web");
mkdirSync(wrapperDestDir, { recursive: true });
cpSync(path.join(cacheDir, "wrappers", "web"), wrapperDestDir, { recursive: true });

// wasm-pack writes its own "ignore everything" .gitignore into pkg/, but
// this output is committed (not actually gitignored) — drop it so it
// doesn't silently exclude the vendored files from version control again.
rmSync(path.join(vendorDir, "pkg", ".gitignore"), { force: true });

// Rewrite the wasm import path: the wrapper normally lives at
// wrappers/web/index.js next to a sibling mistlib-wasm/pkg directory, but
// here pkg/ is vendored alongside wrappers/, one level up.
const wrapperIndexPath = path.join(wrapperDestDir, "index.js");
const wrapperSrc = readFileSync(wrapperIndexPath, "utf8").replace(
  "../../mistlib-wasm/pkg/mistlib_wasm.js",
  "../../pkg/mistlib_wasm.js",
);
writeFileSync(wrapperIndexPath, wrapperSrc);

writeFileSync(stampPath, `${commit}\n`);

console.log(`mistlib (${ref}) built and vendored into src/vendor/mistlib`);
