// Cross-platform desktop build. Outputs contain no .env, database or OAuth tokens.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target =
  process.argv[2] ||
  `${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "x64" ? "amd64" : "arm64"}`;
if (
  ![
    "windows-amd64",
    "windows-arm64",
    "darwin-amd64",
    "darwin-arm64",
    "linux-amd64",
  ].includes(target)
)
  throw Error(
    "Choose windows-amd64/windows-arm64/darwin-amd64/darwin-arm64/linux-amd64",
  );
const [goos, goarch] = target.split("-");
execFileSync(
  process.execPath,
  [path.join(root, "frontend/node_modules/@angular/cli/bin/ng.js"), "build"],
  {
    cwd: path.join(root, "frontend"),
    env: { ...process.env, NG_CLI_ANALYTICS: "false" },
    stdio: "inherit",
  },
);
const embed = path.join(root, "backend/internal/desktop");
for (const dir of ["assets", "migrations"]) {
  for (const name of readdirSync(path.join(embed, dir)))
    if (name !== "README.txt")
      rmSync(path.join(embed, dir, name), { recursive: true, force: true });
}
cpSync(
  path.join(root, "frontend/dist/frontend/browser"),
  path.join(embed, "assets"),
  { recursive: true },
);
for (const name of readdirSync(path.join(root, "migrations")))
  if (name.endsWith(".sql"))
    cpSync(
      path.join(root, "migrations", name),
      path.join(embed, "migrations", name),
    );
const out = path.join(root, "release", target);
mkdirSync(out, { recursive: true });
execFileSync(
  "go",
  [
    "build",
    "-trimpath",
    "-o",
    path.join(out, goos === "windows" ? "WebDairy.exe" : "WebDairy"),
    "./cmd/diary",
  ],
  {
    cwd: path.join(root, "backend"),
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    stdio: "inherit",
  },
);
cpSync(path.join(root, "backend/.env.example"), path.join(out, ".env.example"));
cpSync(
  path.join(root, "docs/google-setup.md"),
  path.join(out, "Google-setup.md"),
);
const command =
  goos === "windows"
    ? '"%~dp0WebDairy.exe" -desktop'
    : 'cd "$(dirname "$0")"\nexec ./WebDairy -desktop';
writeFileSync(
  path.join(
    out,
    goos === "windows" ? "Start-WebDairy.cmd" : "Start-WebDairy.command",
  ),
  goos === "windows"
    ? `@echo off\r\ncd /d "%~dp0"\r\n${command}\r\npause\r\n`
    : `#!/bin/sh\n${command}\n`,
  { mode: 0o755 },
);
writeFileSync(
  path.join(out, "README.txt"),
  "Install/run PostgreSQL first. Copy .env.example to .env and configure your own database and optional Google OAuth client. Run Start-WebDairy. The app opens http://127.0.0.1:8080. Keep this process running. Use the same hostname; browser storage from port 4200 is separate. This is an unsigned development build; OS signing and real-device acceptance remain pending.",
);
console.log(`Desktop build created at ${out}`);
