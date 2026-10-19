# Learning progress

Last updated: **19 October 2026 (Asia/Kolkata)**.

## Dashboard

| Item | Current record |
|---|---|
| Curriculum | 18 weeks × 6 days × 2 hours = 216 planned hours |
| Study start date | Not confirmed; creation date ko automatic Day 1 completion nahi maana gaya |
| Current learning position | Orientation discussed; Week 1 / Day 1 practical checkpoint pending |
| Actual study time | Not recorded |
| Formally verified weekly milestones | 0 / 18; assessments abhi conduct nahi hui hain |
| Fully reviewed/verified authored files | 0 / 78; formal line-by-line reviews abhi record nahi hui hain |
| Source baseline | `300de0b`; study plan initially saved in `ab6e75d` |
| Current app ports | Frontend 4300, backend/package 47831, PostgreSQL normally 5432 |
| Primary tracker location | Repo `docs/learning/`; complete source checklist `docs/study-plan.md` |

0 Verified ka matlab zero knowledge nahi hai. Iska matlab abhi independent recall
aur formal practical assessments ka saved evidence nahi hai.

## Ab tak kya discuss hua / kis cheez ka evidence hai

Dates of older messages are not inferred. Yeh earlier conversation ka orientation
summary hai; future sessions mein own explanation aur practical evidence add karenge.

| Topic | Current status | Evidence / kya confirm karna hai |
|---|---|---|
| Repo clone aur personal/company SSH accounts | User-reported practical | Personal alias se clone successful output share hua tha; SSH alias → private key resolution dobara explain karna hai. |
| PostgreSQL service aur DB login | User-reported practical | `pg_isready` accepting connections aur `postgres` role se `diary_db` connection share hua tha; role/password/DB ka difference verify karna hai. |
| Frontend startup / npm scripts | User-reported practical | User ne `npm start` se app chalne ki report di; `npm start` vs plain `ng serve` aur proxy ka recall baaki hai. |
| Go module/import paths | Discussed | Module name, local package aur external dependency resolution ka small practical baaki hai. |
| `go run ./cmd/diary` / `-migrate` | Discussed | Package path, program flags aur migration call flow independently explain karna hai. |
| Environment variables / `.env` / paths | Discussed | Process lifetime, working directory aur file/env precedence practical karna hai. |
| Loopback / ports / Angular proxy | Discussed | Browser → 4300 → 47831 → DB flow trace karna hai. |
| Table purpose aur relationships | Discussed | 14-table map aur PK/FK relationships tumhe khud banana hai. |
| Entry/date/revision/operation ID | Discussed | Same date par edits aur duplicate/stale saves ka learning-DB practical baaki hai. |
| Login password vs diary passphrase vs recovery key | Discussed | Teenon roles apne words mein explain karne hain. |
| Argon2id / salt / password hashing | Discussed | Same password + stored salt se verification aur new random salt ka effect practical karna hai. |
| Wrapped diary key / AES-GCM verification | Discussed | Wrong passphrase par decrypt/tag verification kyun fail hoti hai explain karna hai. |
| Recovery / HKDF / key envelope | Discussed | Actual recovery secret aur stored encrypted key copy ka difference explain karna hai. |
| DB hash replacement aur HMAC proposal | Discussed | Current app limitation aur proposed protection distinguish karni hai; HMAC abhi implemented nahi hai. |
| Backup vs restore vs simultaneous sync | Discussed | One-laptop-at-a-time flow aur app-closed backup limit ka recall baaki hai. |
| Google identity / Drive permission / vault unlock | Discussed | Teen independent steps aur token storage ko trace karna hai. |
| ZIP packaging / launcher | Discussed | Assistant ne packages build kiye; learner ne independently ZIP build karke evidence abhi share nahi kiya. |
| Full code line-by-line | Pending | 78 authored files ka checklist hai; formal reviewed ranges abhi record nahi hui hain. |

## Samajh aaya: learner-confirmed evidence

Abhi koi topic independently explained + assessed ke roop mein mark nahi kiya gaya.
Next session mein tumhara answer yahan apne words mein preserve karenge.

| Date | Topic | Tumhara explanation / practical evidence | Related question/file |
|---|---|---|---|
| — | — | First assessment pending | — |

## Abhi kya samajhna/practice karna baaki hai

- [ ] Architecture aur process/port basics independently explain karna.
- [ ] Go syntax/functions/errors/context aur startup code.
- [ ] TypeScript promises/async-await aur Angular signals/templates/DI.
- [ ] SQL constraints, joins, transactions aur migration lifecycle.
- [ ] Login/session/CSRF aur password verification line-by-line.
- [ ] Passphrase/recovery wrapping aur actual crypto call flow.
- [ ] Autosave → encrypted draft → API → SQL → acknowledgement.
- [ ] Conflicts, idempotence, offline/reconnect aur error cleanup.
- [ ] Search, tags/mood, streak, trash/purge aur preferences.
- [ ] Encrypted backup format, preview/staging, safety copy aur atomic restore.
- [ ] Google OAuth/PKCE, Drive scopes, OS credential storage aur schedules.
- [ ] Browser launcher/config, package build, test harness aur legacy tables.

## Next session card

- **Position:** Week 1 / Day 1.
- **Read:** repo folders, README setup sections, `frontend/package.json`,
  `frontend/proxy.conf.json`, `backend/cmd/diary/main.go` ka overview.
- **Practical:** separate learning DB confirm karke app run; Network tab mein health request inspect.
- **Expected output:** startup commands + architecture sketch + own explanation.
- **Ask:** Q001–Q005 in `questions.md`.
- **Completion rule:** actual result/answer mile tab record update karna.

## Per-file completion

Single checklist [study-plan.md](../study-plan.md#10-complete-authored-file-checklist)
mein rakhi hai; duplicate checkbox list yahan maintain nahi karenge. Session log
mein reviewed function/line range add karenge, phir full file complete hone par tick karenge.
