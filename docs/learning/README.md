# Akash ka WebDairy learning notebook

Last initialized: **19 October 2026 (Asia/Kolkata)**.

Yeh folder learning ka saved record hai. Main curriculum aur 78-file checklist
[study-plan.md](../study-plan.md) mein hai. Application code is notebook se change nahi hota.

## Kya kahan milega

| File | Kaam |
|---|---|
| [Full study plan](../study-plan.md) | 18-week curriculum, daily routine, practicals aur source-file checklist. |
| [progress.md](progress.md) | Abhi kahan hain, kaunse topics discuss hue, kya verify hua aur kya baaki hai. |
| [milestones.md](milestones.md) | Har week ka expected result, time budget aur actual completion evidence. |
| [questions.md](questions.md) | Poochhe gaye questions, answer notes, tumhara own answer aur remaining doubts. |
| [session-log.md](session-log.md) | Har lesson mein kya padha, kya practice ki aur next session kahan se start hoga. |

## Current next step

**Week 1, Day 1:** learning DB/checkout identify karna, app run karna, aur
`Browser → Angular :4300 → Go :47831 → PostgreSQL` apne words mein explain karna.
Abhi formal line-by-line lesson aur checkpoint verification start nahi hua hai.
Pichhli conversations mein kuch setup actions user ne run kiye hain; unki evidence
aur pending explanation [progress.md](progress.md) mein separately recorded hai.

## Status ka matlab

- **Pending:** topic/assessment abhi complete nahi hua.
- **Discussed:** explanation chat mein di gayi; understanding abhi check karni hai.
- **User-reported practical:** tumne execution/output share kiya; conceptual recall baaki ho sakta hai.
- **Verified:** tumne apne words mein explain kiya aur relevant practical/quiz evidence mila.
- **Revisit:** explanation ya practical mein gap mila; next revision required hai.

Sirf answer padhne, assistant ke tests pass hone, ya code ban jaane se tumhara
learning milestone Verified nahi hoga. Reviewed line range bhi record karenge.

## Har learning session ke baad ka update

1. `session-log.md` mein date, actual minutes, files/functions/line ranges,
   tumhara explanation, practical result aur next step append karo.
2. `progress.md` mein relevant topic ka status/evidence update karo.
3. `questions.md` mein tumhara own answer aur new doubts record karo.
4. Milestone ke acceptance criteria meet hon toh `milestones.md` mein actual
   date/evidence add karo. Full source file cover ho tab study plan ki checkbox tick karo.
5. Files save karo. Dates aur study hours invent mat karo; missing ho toh Not recorded likho.

## Laptop par copy

### Existing Git clone mein

WebDairy project root mein, current work save karne ke baad:

```text
git pull origin main
```

Phir VS Code mein `docs/learning/README.md` kholo. Markdown preview Windows par
`Ctrl+Shift+V`, Mac par `Cmd+Shift+V` hai. Actual local folder wahi hai jahan tumne
WebDairy clone kiya hai; cloud ko tumhare laptop ka exact path pata nahi hai.

### Separate Desktop copy

Chat se `WebDairy-Learning-Notebook.zip` download karke Desktop par extract karo.
`START-HERE.txt` se start karo. Is copy ko offline bhi padh/edit kar sakte ho.
ZIP us waqt ke plan/progress ka snapshot hai. Updated copy ke liye naya ZIP
download karo, ya Git clone wale notebook ko use karo.

## Laptop aur cloud ka progress ek jaisa kaise rakhen

Ek notebook ko main editable copy choose karo. Dono jagah parallel edit karoge toh
Git conflicts resolve karne pad sakte hain.

- Assistant cloud mein tracker update kare: laptop par `git pull` karo.
- Tum laptop ke Git clone mein tracker update karo: changed study files inspect
  karke commit/push karo, tab next cloud session un updates ko read kar sakta hai.
- Separate Desktop ZIP folder ke edits automatically GitHub par nahi jayenge;
  relevant Markdown changes Git clone mein copy karke commit karne honge.
- No-edit local copy banani ho toh current folder ko date ke saath duplicate kar sakte ho.

Tracker-only local updates save karne ka example, project root se:

```text
git status
git diff -- docs/learning docs/study-plan.md
git add docs/learning docs/study-plan.md
git commit -m "Update my WebDairy learning progress"
git push
```

Push current branch ko publish karta hai. Learning branch par ho toh us branch ke
updates ko next cloud task mein bhi select/merge karna hoga; main apne aap update nahi hota.
Git conflict par notes delete karke shortcut mat lo; dono records preserve karo.

## Next chat mein resume prompt

```text
WebDairy learning continue karo. Pehle docs/learning/progress.md,
questions.md aur session-log.md padho. Last next-step se start karo.
Ek chhota block samjhao, mujhse explanation/practical lo, phir trackers update karo.
```

Sirf learning notes save karo. Passwords, `.env`, real recovery keys, OAuth tokens
ya personal diary text notebook/GitHub mein mat daalo.
