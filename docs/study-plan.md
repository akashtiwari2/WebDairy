# WebDairy: beginner se poora project samajhne ka study plan

Baseline: commit `300de0b`. Backend `47831`, development frontend `4300`,
PostgreSQL normally `5432`. Yeh learning plan hai; application/security behavior
isme change nahi kiya gaya hai. Discussed HMAC hardening abhi implemented nahi hai.

## 1. Time aur scope

- **18 weeks, 6 study days/week, 2 hours/day = 216 planned hours.**
- Day 7 rest/catch-up hai; us din naya module zaroori nahi.
- Beginner ke liye yeh pehla complete understanding pass ka estimate hai,
  mastery ki guarantee nahi. Foundation weak ho ya checkpoints pending hon toh
  2 extra weeks reserve rakho. Roz 1 hour par approximately double calendar time lagega.
- Inspected code: **78 authored files, 13,159 physical lines**, including tests,
  templates, styles, migrations and scripts. Empty lines/comments bhi count mein hain.
- In sab authored files ka line-by-line review karna hai. Config files bhi cover
  karni hain. `node_modules`, Go dependencies, generated bundles, embedded copies,
  binaries aur lock/checksum files ki har entry padhna scope mein nahi hai.
  Lockfiles/checksums ka purpose aur dependency APIs zaroor samajhni hain.

**Goal:** file padhne ke baad tum bata sako ki har meaningful line kyun hai,
input kahan se aaya, output kahan gaya, failure par kya hoga aur test kaise prove karta hai.

Saved progress, understood/pending topics, expected milestones, question bank aur
session history ke liye [learning notebook](learning/README.md) use karo. Laptop
copy/sync aur next session resume karne ke steps bhi wahin hain.

## 2. Daily 120-minute routine

| Time | Kaam |
|---|---|
| 15 min | Kal ka flow bina notes explain karo; 3 recall questions answer karo. |
| 40 min | Ek function/block line-by-line padho. Naya syntax chhote example se samjho. |
| 35 min | Usi concept ka small change ya isolated example khud likho. |
| 20 min | Debugger/Network/SQL/test se expected aur actual behavior compare karo. |
| 10 min | Notes, doubts aur file checklist update karo. |

Normal session mein 1–3 functions ya roughly 80–150 meaningful lines enough hain.
Simple HTML/CSS/fixtures jaldi cover honge; crypto, concurrency ya SQL transactions
ko zyada time do. Line count ko completion ka proof mat mano.

## 3. Learning workspace

1. Daily-use diary se alag learning checkout/branch aur **separate learning database** rakho.
   `git switch -c learning/webdiary` ek local learning branch banata hai.
2. Learning checkout ki `.env` mein sirf learning DB configure karo. Real diary DB
   par password replacement, deletion, corruption aur restore experiments mat karo.
3. Existing app ke saath same ports par second copy start nahi ho sakti. Learning
   session se pehle apni daily-use WebDairy stop karo, phir learning copy start karo.
4. Native Windows/Mac par frontend aur backend ke separate terminals use karo:

   ```text
   backend folder:  go run ./cmd/diary
   frontend folder: npm start
   ```

5. `scripts/*.sh` cloud/Linux Bash scripts hain. Windows PowerShell mein seedha
   nahi chalenge; unke exercises cloud ya properly configured WSL/Linux par karo.
   `node scripts/package.mjs windows-amd64` Windows/Mac se bhi build kar sakta hai.
6. Notes mein passwords, `.env` values, OAuth tokens ya real recovery keys mat copy karo.

## 4. Har block ko samajhne ka fixed method

Har block par yeh questions answer karo:

1. **Purpose:** yeh function kis user action/problem se related hai?
2. **Syntax/types:** har variable/import/type/operator ka matlab kya hai?
3. **Input:** value kis caller, request, DB row ya browser event se aayi?
4. **State/effect:** memory, DOM, cookie, IndexedDB, network ya PostgreSQL mein kya badla?
5. **Branches:** har `if`, `return`, `catch` aur error path kab chalega?
6. **Lifetime:** value/request/transaction/key kab tak alive rahegi? Cleanup kaun karega?
7. **Evidence:** kaunsa test ya experiment is behavior ko verify karta hai?

Pehle function ka overview, phir lines, phir complete call flow padho. Sirf syntax
translate karke next function par mat jao. Unknown dependency ka public API padho;
poori dependency library padhna zaroori nahi.

## 5. 18-week roadmap

Har week ke first 5 days mein reading + listed practical karo. Day 6 par associated
tests, remaining lines, recall aur checkpoint karo. Ek workflow kai files se guzarta
hai; isliye files ko revisit karna intentional hai. Full file tabhi tick hogi jab uske
remaining branches aur tests bhi explain kar sako.

| Week | Concepts aur source order | Practical + week-end deliverable |
|---|---|---|
| **1** | Terminal paths, Git basics, process/port, browser → proxy → Go → PostgreSQL, HTTP/JSON. Read `README.md`, `docs/setup.md`, `docs/api.md`, `frontend/package.json`, `proxy.conf.json`, `.env.example`. | App run karo. DevTools se `/api/health` inspect karo. Request/response ka diagram aur startup commands apne words mein likho. |
| **2** | Go: variables, types, functions, errors, structs, pointers, methods, packages, `defer`, context, goroutines/select. Read `backend/go.mod`, `backend/cmd/diary/main.go`, `main_test.go`. | Chhota Go program banao jo env value read kare, flag accept kare aur missing value par error de. Real startup ko `main → run → server` tak trace karo. |
| **3** | TypeScript: objects, interfaces, classes, imports, promises, `async/await`, `try/catch`. Angular: bootstrap, DI, signals/effects. Read `frontend/src/main.ts`, `app.config.ts`, `app.routes.ts`, `auth.service.ts`, `startup.service.ts`. | Isolated TS example mein successful/failed async request handle karo. Explain karo `await` ke baad ka code kab chalega aur signal se UI kab update hogi. |
| **4** | PostgreSQL: tables, PK/FK, UUID, JSONB, bytea, NULL, constraints, joins, transactions. Read all 7 `migrations/*.sql`, `backend/internal/database/migrate.go`, `private/store.go` data types. | 14 tables ka relationship map banao. Learning DB par simple SELECT/JOIN aur BEGIN/ROLLBACK practice karo. Migration dobara chalne par kya hota hai explain karo. |
| **5** | HTTP/Echo, handlers, middleware, Host/Origin validation, JSON/error/status mapping, request context. Read `backend/internal/server/private.go` helpers/routes, route call sites and `docs/api.md`. | Health request aur unauthenticated vault request inspect karo. Dummy local handler banao: valid request 200, invalid request 400. Controller vs store responsibility explain karo. |
| **6** | Login lifecycle: Argon2id hash, salt, verification, sessions, CSRF, cookie flags, rate limiting, logout/reset. Read `private/auth.go`, `auth_test.go`, auth routes in `server/private.go`, `auth.service.ts`, `auth-panel.ts/.html` login branches. | Learning account par wrong password, logout aur expired session observe karo. Login password vs diary passphrase ka difference bina notes explain karo. |
| **7** | Browser encryption: bytes/base64, random key, AES-GCM, nonce/tag/AAD, Argon2id, HKDF, passphrase/recovery wrappers. Read `vault-crypto.ts`, its spec, `vault.service.ts`, `docs/security.md`. | Synthetic data ko encrypt/decrypt karo. Wrong passphrase aur modified ciphertext reject hone ka test dekho. Setup → unlock → lock → recovery flow draw karo. Crypto algorithm khud design mat karo. |
| **8** | Angular component/template bindings, forms, events, computed signals, calendar/date handling, responsive CSS and accessibility basics. Read `app.ts`, `app.html`, `app.css`, `styles.css`, `index.html`, remaining auth panel lines, `app.spec.ts`. | Learning branch par ek label/spacing/layout change karo. Mobile viewport inspect karo. Button click se handler aur state change tak trace likho. |
| **9** | Core diary path: entry models, initialization, edit, encryption, save, SQL insert/update, expected revision and operation ID. Read `diary.service.ts` in chunks, `drafts.ts`, `private/store.go`, entry routes. | One date par 3 edits karo: same record ID aur revision changes observe karo. UI event → encrypted request → handler → SQL → response → Saved ka complete trace banao. |
| **10** | Autosave timers/queues, in-flight requests, durable encrypted drafts, reconnect, idempotence and conflicts. Complete `diary.service.ts`; read `private_integration_test.go` and relevant `test-browser.mjs` sections. | Unlocked synthetic diary mein backend stop karke draft likho; restart par save/recovery observe karo. Duplicate request aur stale revision ka expected result predict karo. Offline cold-open ki current limit explain karo. |
| **11** | Search, tags/mood, writing streak, timezone/theme, trash vs permanent purge. Read `library-panel.ts/.html/.spec.ts`, `writing-insights.ts/.spec.ts`, `preferences.service.ts`, `private/restore.go` purge section. | Synthetic trash entry restore karo; occupied date aur permanent deletion cases samjho. Streak edge case add karo. Explain karo search DB mein plaintext query kyun nahi bhejti. |
| **12** | Backup creation, encrypted archive format, snapshot consistency, browser copies and health calculations. Read `backup-format.ts/.spec.ts`, `backup-store.ts`, export/snapshot portions of `backup.service.ts`, backend snapshot endpoint and `private/restore.go`. | Encrypted synthetic backup export karo; format fields identify karo. Wrong key aur tampered file reject hote dekho. DB backup vs emergency draft export ka difference likho. |
| **13** | Restore preview/stage/commit, binding hashes, optimistic baseline, safety archive, transaction rollback and epoch. Complete `private/restore.go`, `restore_integration_test.go`, `backup.service.ts`, `backup-panel.ts/.html`, backup specs, restore sections of browser tests. | Separate fresh learning DB mein restore karo. Bad file, stale preview aur simulated failure ke cases verify karo. Existing diary replacement ke before/after states draw karo. |
| **14** | OAuth roles, authorization code, PKCE/state, redirect, verified identity, Google-only/local login. Read sign-in portions of `cloud/google.go`, `server/google.go`, `private/google.go`, `google.service.ts/.spec.ts`, `docs/google-setup.md`. | Mock tests mein code/state callback trace karo. Sign-in, Drive permission aur diary unlock ko separately explain karo. Real OAuth credentials available na hon toh mock workflow continue karo. |
| **15** | Drive API, OS token storage, refresh, immutable uploads, schedules, retention/retries and download/restore. Read `cloud/drive.go`, remaining Google files, `cloud/google_test.go`, `google_integration_test.go`, `backup-schedule.ts/.spec.ts`, `backup.service.spec.ts`. | Due/not-due/retry schedule cases test karo. Mock Drive failure se last good backup preserve hota hai ya nahi trace karo. App closed hone par backup ki limit explain karo. |
| **16** | Packaged browser lifecycle: embedded assets/migrations, loopback server, setup validation, config save, second-instance reuse and shutdown. Read `desktop/desktop.go`, `setup.go`, `setup.html`, `setup_test.go`; revisit `main.go` packaged paths. | Learning package ko wrong DB credentials ke saath start karo, retry/setup samjho. Source mode vs package mode aur `.env` precedence explain karo. |
| **17** | Build/distribution, Bash/Node orchestration, ZIP format/checksum basics, integration/browser test harness; legacy sample code. Complete all `scripts/*`, `entries/store.go` and its integration test, `server/server.go` and `server_test.go`; remaining config files. | Windows ZIP khud build karo. Test harness ke setup/assertion/cleanup phases explain karo. Legacy plaintext sample API current private app mein mount kyun nahi hoti prove karo. |
| **18** | Full-system review, remaining-file closure, failure diagnosis and small independent feature. Revisit unclear functions and checklist. | Neeche diya final assessment complete karo. Ek small utility feature khud implement karke relevant test aur explanation do. Unclear files ko complete mark mat karo; pending items ka next schedule likho. |

## 6. First week: exact daily tasks

| Day | 2-hour target | Session ke end par proof |
|---|---|---|
| 1 | Repo tree dekho; frontend/backend/DB ka role samjho; learning DB choose karo; app run karo. | Apne words mein startup steps aur 4-box architecture sketch. |
| 2 | `pwd`/`Get-Location`, `cd`, relative/absolute paths, `./cmd/diary`, npm scripts aur processes samjho. | Bina copy-paste folder change karke backend/frontend start aur apne processes stop karo. |
| 3 | HTTP URL, method, header, JSON body, response status; browser Network tab. | `/api/health` ka request/response explain karo; 401 aur 503 ka difference batao. |
| 4 | `package.json`, `proxy.conf.json`, `.env.example`; environment vs file settings, ports/origins. | Explain karo `npm start` aur plain `ng serve` mein proxy ka kya farq hai; `.env` Git mein kyun nahi jati. |
| 5 | Git status/diff/log, learning branch, one small UI text change and revert. | Sirf intended line diff mein ho; dependencies/generated files accidentally commit na hon. |
| 6 | Review; complete request route manually trace karo; unknown Go/TS/SQL terms list banao. | Neeche ke Week 1 checkpoint ke 5 answers bina notes do. |

Week 1 checkpoint:

1. Browser `4300` par request karta hai toh backend `47831` tak kaise jati hai?
2. `.env` file banana aur process environment variable set karna kaise alag hain?
3. PostgreSQL, pgAdmin aur Go backend teen alag cheezein kyun hain?
4. App ka login password, PostgreSQL password aur diary passphrase ka role kya hai?
5. Browser tab close karna aur backend process stop karna kaise alag hai?

## 7. Progress tracking aur weekly review

Har session ke liye local notes mein yeh template use karo:

```text
Week / Day / Date:
File + function / reviewed line range:
User action / purpose:
Input → processing → output:
New syntax or concept:
Failure path + cleanup:
Practical change / experiment:
Test / observed result:
Mere 3 recall questions:
Pending doubt:
Next starting point:
```

File ko complete mark karne se pehle:

- Har meaningful block aur uska caller explain kar sakta hoon.
- Main path ke saath error/retry/cleanup branches bhi samajh aayi hain.
- Ek relevant experiment/test dekha ya chalaya hai; expected result pehle predict kiya tha.
- Bina original copy kiye function ka small equivalent example bana sakta hoon.

Har Day 6 par 20-minute oral walkthrough, 20-minute closed-notes quiz,
40-minute practical/test aur 40-minute pending lines/revision karo. Test code
khud explain karo: **Arrange → Act → Assert**, aur assertion galat behavior par
fail hogi ya nahi. Sirf green test output dekhna understanding ka proof nahi hai.

Milestones:

- **Week 4:** startup aur schema explain; basic Go/TS/SQL examples independently.
- **Week 7:** login vs unlock vs recovery ka correct distinction.
- **Week 10:** ek edit ko UI se committed DB ciphertext tak trace.
- **Week 13:** invalid restore existing diary ko kyun preserve karta hai explain.
- **Week 16:** Google/Drive/local package responsibilities aur limits explain.
- **Week 18:** full file checklist review + independent change + failure diagnosis.

## 8. Final assessment

1. Login, unlock, edit/autosave, lock/reopen, export aur new-DB restore ka complete
   flow bina notes draw karo. Har arrow par function/file identify karo.
2. Wrong database password, stopped backend, expired session, revision conflict,
   wrong passphrase aur corrupted backup ko independently diagnose karo.
3. Har table ka purpose batao; `password_hash`, key wrappers aur request hashes
   ka difference explain karo. Current DB-write/HMAC limitation clearly batao.
4. Search/UX/streak jaisa small change khud likho; ek meaningful associated test
   add/change karo. Crypto algorithms ya authentication ko first practice feature mat banao.
5. Windows ZIP khud banao aur package contents/startup requirements explain karo.
6. Remaining unanswered questions likho. Unread lines ko mark pending rakho;
   estimate revise karna false completion se better hai.

## 9. Checks ka use

Native unit checks:

```text
backend folder:  go test ./...
backend folder:  go vet ./...
frontend folder: npm test
frontend folder: npm run build
repo root:      node scripts/package.mjs windows-amd64
```

`go test ./...` without `TEST_DATABASE_URL` disposable DB integration workflows
skip karta hai; ise full DB verification mat samajhna. Cloud/Linux par the existing
`scripts/test-integration.sh`, `scripts/test-browser.sh` aur `scripts/test-launcher.sh`
appropriate module ke week mein padho/chalao. Inke Docker/Chromium/port prerequisites
pehle padho. Browser script ko personal diary par directly mat chalao.

Real Google login/Drive validation ko mock tests se alag track karo. Credentials
ya internet pending hone par Go/Angular/SQL/crypto/mock learning rukni nahi chahiye.

## 10. Complete authored-file checklist

Checkbox ka matlab **review + explanation + practical evidence complete** hai.
Yeh baseline inventory hai; code change hone par nayi files/ranges append karo.

### backend

- [ ] `backend/cmd/diary/main.go` (236 lines)
- [ ] `backend/cmd/diary/main_test.go` (63 lines)
- [ ] `backend/internal/cloud/drive.go` (188 lines)
- [ ] `backend/internal/cloud/google.go` (319 lines)
- [ ] `backend/internal/cloud/google_test.go` (223 lines)
- [ ] `backend/internal/database/migrate.go` (66 lines)
- [ ] `backend/internal/desktop/desktop.go` (82 lines)
- [ ] `backend/internal/desktop/setup.go` (417 lines)
- [ ] `backend/internal/desktop/setup.html` (30 lines)
- [ ] `backend/internal/desktop/setup_test.go` (151 lines)
- [ ] `backend/internal/entries/store.go` (169 lines)
- [ ] `backend/internal/entries/store_integration_test.go` (233 lines)
- [ ] `backend/internal/private/auth.go` (164 lines)
- [ ] `backend/internal/private/auth_test.go` (65 lines)
- [ ] `backend/internal/private/google.go` (58 lines)
- [ ] `backend/internal/private/restore.go` (384 lines)
- [ ] `backend/internal/private/restore_integration_test.go` (202 lines)
- [ ] `backend/internal/private/store.go` (317 lines)
- [ ] `backend/internal/server/google.go` (323 lines)
- [ ] `backend/internal/server/google_integration_test.go` (304 lines)
- [ ] `backend/internal/server/private.go` (439 lines)
- [ ] `backend/internal/server/private_integration_test.go` (265 lines)
- [ ] `backend/internal/server/server.go` (162 lines)
- [ ] `backend/internal/server/server_test.go` (176 lines)

### frontend/src

- [ ] `frontend/src/app/app.config.ts` (10 lines)
- [ ] `frontend/src/app/app.css` (302 lines)
- [ ] `frontend/src/app/app.html` (250 lines)
- [ ] `frontend/src/app/app.routes.ts` (3 lines)
- [ ] `frontend/src/app/app.spec.ts` (387 lines)
- [ ] `frontend/src/app/app.ts` (253 lines)
- [ ] `frontend/src/app/auth-panel.html` (425 lines)
- [ ] `frontend/src/app/auth-panel.ts` (194 lines)
- [ ] `frontend/src/app/auth.service.ts` (83 lines)
- [ ] `frontend/src/app/backup-format.spec.ts` (195 lines)
- [ ] `frontend/src/app/backup-format.ts` (234 lines)
- [ ] `frontend/src/app/backup-panel.html` (355 lines)
- [ ] `frontend/src/app/backup-panel.ts` (144 lines)
- [ ] `frontend/src/app/backup-schedule.spec.ts` (23 lines)
- [ ] `frontend/src/app/backup-schedule.ts` (7 lines)
- [ ] `frontend/src/app/backup-store.ts` (67 lines)
- [ ] `frontend/src/app/backup.service.spec.ts` (237 lines)
- [ ] `frontend/src/app/backup.service.ts` (516 lines)
- [ ] `frontend/src/app/diary.service.ts` (765 lines)
- [ ] `frontend/src/app/drafts.ts` (53 lines)
- [ ] `frontend/src/app/google.service.spec.ts` (80 lines)
- [ ] `frontend/src/app/google.service.ts` (149 lines)
- [ ] `frontend/src/app/library-panel.html` (105 lines)
- [ ] `frontend/src/app/library-panel.spec.ts` (120 lines)
- [ ] `frontend/src/app/library-panel.ts` (122 lines)
- [ ] `frontend/src/app/preferences.service.ts` (88 lines)
- [ ] `frontend/src/app/startup.service.ts` (19 lines)
- [ ] `frontend/src/app/vault-crypto.spec.ts` (80 lines)
- [ ] `frontend/src/app/vault-crypto.ts` (282 lines)
- [ ] `frontend/src/app/vault.service.ts` (332 lines)
- [ ] `frontend/src/app/writing-insights.spec.ts` (58 lines)
- [ ] `frontend/src/app/writing-insights.ts` (82 lines)
- [ ] `frontend/src/index.html` (14 lines)
- [ ] `frontend/src/main.ts` (6 lines)
- [ ] `frontend/src/styles.css` (608 lines)

### migrations

- [ ] `migrations/001_initial.sql` (21 lines)
- [ ] `migrations/002_development_entries.sql` (12 lines)
- [ ] `migrations/003_development_tombstones.sql` (5 lines)
- [ ] `migrations/004_development_operations.sql` (8 lines)
- [ ] `migrations/005_private_vault.sql` (31 lines)
- [ ] `migrations/006_local_release.sql` (21 lines)
- [ ] `migrations/007_google_identity.sql` (7 lines)

### scripts

- [ ] `scripts/check.sh` (9 lines)
- [ ] `scripts/db.sh` (23 lines)
- [ ] `scripts/dev.sh` (40 lines)
- [ ] `scripts/env.sh` (10 lines)
- [ ] `scripts/install.sh` (21 lines)
- [ ] `scripts/package-archive.mjs` (61 lines)
- [ ] `scripts/package.mjs` (145 lines)
- [ ] `scripts/test-browser.mjs` (747 lines)
- [ ] `scripts/test-browser.sh` (47 lines)
- [ ] `scripts/test-integration.sh` (11 lines)
- [ ] `scripts/test-launcher.mjs` (192 lines)
- [ ] `scripts/test-launcher.sh` (64 lines)

### Configuration / dependency contracts

- [ ] `README.md`
- [ ] `.gitignore`
- [ ] `backend/.env.example`
- [ ] `backend/go.mod`
- [ ] `frontend/package.json`
- [ ] `frontend/angular.json`
- [ ] `frontend/proxy.conf.json`
- [ ] `frontend/tsconfig.json`
- [ ] `frontend/tsconfig.app.json`
- [ ] `frontend/tsconfig.spec.json`
- [ ] `frontend/.gitignore`
- [ ] `frontend/.editorconfig`
- [ ] `frontend/.vscode/launch.json`
- [ ] `frontend/.vscode/tasks.json`

`frontend/package-lock.json` aur `backend/go.sum`: reproducibility/integrity ka purpose samjho; generated hash entries ko line-by-line memorize nahi karna.
