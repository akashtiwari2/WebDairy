// Cross-platform browser launcher build. Outputs contain no .env, database or OAuth tokens.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { packageArchive } from "./package-archive.mjs";
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
    "-ldflags",
    "-X main.packagedBrowser=true",
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
for (const [name, flags] of [
  ["Start-WebDairy", ""],
  ["Setup-WebDairy", "-configure"],
  ["Reset-login", "-reset-login"],
]) {
  writeFileSync(
    path.join(out, `${name}.${goos === "windows" ? "cmd" : "command"}`),
    goos === "windows"
      ? `@echo off\r\ncd /d "%~dp0"\r\n"%~dp0WebDairy.exe" ${flags}\r\npause\r\n`
      : `#!/bin/sh\ncd "$(dirname "$0")"\n./WebDairy ${flags}\nresult=$?\nif [ "$result" -ne 0 ]; then printf 'WebDairy could not start. Press Enter to close.'; read answer; fi\nexit "$result"\n`,
    { mode: 0o755 },
  );
}
cpSync(path.join(root, "docs/daily-use.md"), path.join(out, "Daily-use.md"));
writeFileSync(
  path.join(out, "README.txt"),
  `WEBDIARY — YOUR DIARY IN YOUR BROWSER

1. Install PostgreSQL once and keep it running. pgAdmin is optional.
2. Extract this folder. Open Start-WebDairy (Windows: .cmd, Mac: .command).
   On Windows, double-clicking WebDairy.exe also works.
3. Your browser opens automatically. On first use enter your PostgreSQL
   username, password and diary database. WebDairy can create a missing database
   and applies database updates automatically. Existing entries are kept.
4. Create your diary or connect Google and restore a backup.

Daily use: open Start-WebDairy, unlock and write. Keep the launcher window
running. Closing a browser tab does not stop the local program; Ctrl+C in the
launcher window stops it. PostgreSQL must also stay running. No Go or Node is
needed to run this package. No native desktop window or Tauri is included.

Settings are saved outside this package in your user settings folder:
Windows: %APPDATA%\\WebDairy\\.env
Mac: ~/Library/Application Support/WebDairy/.env
An existing .env beside the executable is still supported. Do not share it.
Upgrading: stop your old WebDairy, extract the new package and start it;
user settings and PostgreSQL diary data remain in place.

To add/change the optional Google client or database connection, stop WebDairy
and open Setup-WebDairy. See Google-setup.md; no Google client credentials are
included. Backups need internet, Drive permission, and an open/unlocked diary.
Before switching laptops, wait for Backed up; on the new laptop restore the
latest backup with its diary password or recovery key. This is backup/restore,
not simultaneous-device sync.

The packaged browser uses http://127.0.0.1:8080. Use the same browser profile and
hostname. Development port 4200 has separate browser draft storage: save or
export unsaved drafts before changing ports. This is an unsigned development
build; real Google-account and Windows/Mac acceptance/signing remain pending.
`,
);
console.log(`Browser launcher build created at ${out}`);
const executableName = goos === "windows" ? "WebDairy.exe" : "WebDairy";
const files = [
  { name: executableName, mode: 0o755 },
  ...["Start-WebDairy", "Setup-WebDairy", "Reset-login"].map((name) => ({
    name: `${name}.${goos === "windows" ? "cmd" : "command"}`,
    mode: 0o755,
  })),
  ...["README.txt", "Daily-use.md", "Google-setup.md", ".env.example"].map(
    (name) => ({ name, mode: 0o644 }),
  ),
];
const archive = path.join(root, "release", `WebDairy-${target}.zip`);
packageArchive(out, files, archive);
writeFileSync(
  `${archive}.sha256`,
  `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${path.basename(archive)}\n`,
);
console.log(`Download package created at ${archive}`);
