# Questions, answers aur pending understanding

Initialized: **19 October 2026 (Asia/Kolkata)**.

`Discussed` = explanation di gayi; `Verified` tab hoga jab tumhara own answer aur
practical/recall evidence record hoga. Neeche ke answer notes hints hain, learner
ke submitted answers nahi. Historical chats ke exact dates/time invent nahi kiye gaye.

## Current recall / next session questions

| ID | Question | Current status | Tumhara own answer / evidence |
|---|---|---|---|
| Q001 | Browser, Angular, Go backend aur PostgreSQL alag kya kaam karte hain? | Pending assessment | — |
| Q002 | Frontend 4300 se `/api/health` backend 47831 tak kaise pahunchti hai? | Discussed; recall pending | — |
| Q003 | `npm start` aur plain `ng serve` mein proxy ke liye kya difference hai? | Discussed; recall pending | — |
| Q004 | `.env` file vs `export`/PowerShell env variable: value kahan aur kab tak rahegi? | Discussed; practical pending | — |
| Q005 | PostgreSQL password, app login password aur diary passphrase ko alag kyun rakhte hain? | Discussed; recall pending | — |

## Pehle poochhe gaye security / DB questions

| ID | Question | Answer note | Current status | Own explanation / practical |
|---|---|---|---|---|
| Q006 | Passphrase store nahi hota toh entered value match kaise hoti hai? | Stored salt se wrapping key derive; encrypted diary key decrypt; AES-GCM tag verify. Literal passphrase comparison nahi. | Discussed | — |
| Q007 | Apna password hash generate karke `owner_auth.password_hash` replace kar doon toh login hoga? | Current matching Argon2id format/parameters mein possible; diary unlock independently protected. HMAC protection abhi planned hai. | Discussed | — |
| Q008 | Argon2id hash kya hai? | Password + salt + fixed cost settings se verifier; verification mein same settings use. Hash decrypt nahi hota; guessing possible hai. | Discussed | — |
| Q009 | Recovery secret DB mein nahi toh validate kaise hota hai? | Recovery secret + salt se HKDF wrapping key; encrypted diary key ki recovery copy decrypt/tag verify. | Discussed | — |
| Q010 | Login credentials, key wrappers aur tokens exactly kahan hain? | Login hash owner_auth; wrappers vaults.key_envelope; session/CSRF hashes sessions; OAuth tokens OS storage; DB connection .env. | Discussed | — |
| Q011 | Salt/nonce/ciphertext dekhkar kya pata chalega? | Algorithm/public parameters/encrypted bytes; original secret directly nahi. Passphrase envelope se offline guesses possible. | Discussed | — |
| Q012 | DB admin ko completely powerless bana sakte hain? | DB admin deletion/rollback kar sakta hai. Encryption secrecy aur availability alag hain; unlocked OS different boundary hai. | Discussed | — |
| Q013 | HMAC hash replacement ko kaise rokega? | DB ke bahar key se account state signature; changed state verify fail. Abhi implementation nahi hai. | Discussed; proposed design | — |
| Q014 | Login password bhoolne par recovery kaise hogi? | Current Reset-login behavior aur proposed passphrase/recovery-proof reset alag hain; proposal abhi implement nahi. Login reset writing decrypt nahi karta. | Discussed; current/proposed flow distinction assess karni hai | — |
| Q015 | Ek date par dobara likhun toh nayi row ya same entry? Revision kya hai? | Current client one active entry/date rakhta hai; record updates advance revision; operation IDs retries track karte hain. | Discussed; DB practical pending | — |
| Q016 | 14 tables ko alag kyun banaya? | Auth, encrypted content/keys, retries, restore lifecycle, migrations aur legacy samples ki responsibilities alag. | Discussed; diagram pending | — |

## Setup / packaging / backup questions

| ID | Question | Current status | Own explanation / evidence |
|---|---|---|---|
| Q017 | `go run ./cmd/diary -migrate` mein har part kya karta hai? | Discussed | — |
| Q018 | Go import mein GitHub module path local code ko kaise find karta hai? | Discussed | — |
| Q019 | SSH alias personal/company private key ka path kaise select karta hai? | Discussed; user-reported clone success | — |
| Q020 | Git user.name/email aur SSH authentication ka relation kya hai? | Discussed | — |
| Q021 | ZIP khud kaise build karna hai; run karne wale laptop par kya installed chahiye? | Discussed; independent build pending | — |
| Q022 | Backup/restore aur simultaneous-device sync mein kya difference hai? | Discussed | — |
| Q023 | App closed/locked ho toh scheduled Drive backup chalega? | Discussed; recall pending | — |
| Q024 | Google sign-in se diary automatically decrypt kyun nahi hoti? | Discussed; recall pending | — |

## Naya doubt add karne ka template

Next ID: **Q025**. Duplicate question dobara aaye toh existing ID ka revision log
update karo; repeat question ko failure ya mastery ka automatic proof mat mano.

```text
ID / Date:
Mera question:
Related file / function / line range:
Mera current guess:
Explanation received:
Mera own explanation after learning:
Practical / expected vs actual result:
Status: Pending / Discussed / Verified / Revisit
Next follow-up:
```
