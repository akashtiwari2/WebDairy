// Run ONLY with a fresh disposable database, Angular development server and
// temporary Chromium profile (CDP on loopback 9222). Refuses an existing vault.
// Test passwords/diary strings below are synthetic; recovery keys stay in RAM.
import assert from "node:assert/strict";
const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
const tab = tabs.find((t) => t.type === "page");
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let next = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const d = JSON.parse(e.data);
  if (d.id) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    d.error ? p.reject(new Error(d.error.message)) : p.resolve(d.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description ?? "Browser action failed",
    );
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const app = `window.ng.getComponent(document.querySelector('app-root'))`;
const panel = `window.ng.getComponent(document.querySelector('app-auth-panel'))`;
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return;
    await sleep(100);
  }
  throw new Error("Browser condition timed out: " + expression);
}
async function action(code) {
  return evaluate(`(async()=>{const a=${app},p=${panel};${code}})()`);
}
try {
  await send("Page.navigate", { url: "http://127.0.0.1:4200" });
  await waitFor(`!!window.ng && !!document.querySelector('#setup-login')`);
  assert.equal(
    await action(`return a.vault.state();`),
    "setup",
    "Use a fresh disposable database.",
  );
  const setup = await action(
    `p.loginPassword='synthetic login password';p.passphrase=p.confirmation='synthetic vault passphrase';const start=performance.now();await p.setup();return {secret:a.vault.recoverySecret(),ms:performance.now()-start};`,
  );
  assert.equal(setup.secret.length, 64);
  await action(
    `p.recoveryInput='0'.repeat(64);p.savedOffline=true;await p.verify();`,
  );
  assert.equal(await action(`return a.vault.state();`), "setup");
  await action(
    `p.recoveryInput=${JSON.stringify(setup.secret)};p.savedOffline=true;await p.verify();`,
  );
  await waitFor(`!!document.querySelector('#body')`);
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  for (const [date, title, body] of [
    ["2024-02-29", "SYNTHETIC LEAP", "SYNTHETIC OLD BODY"],
    ["2099-10-20", "SYNTHETIC FUTURE", "SYNTHETIC FUTURE BODY"],
  ]) {
    const result = await action(
      `await a.select(${JSON.stringify(date)});a.diary.edit(a.selected(),${JSON.stringify(title)},${JSON.stringify(body)});await a.diary.save(a.selected());return a.entry().status;`,
    );
    assert.equal(result, "saved");
  }
  const list = await action(
    `return await a.vault.auth.request('/api/entries');`,
  );
  assert.equal(list.records.length, 2);
  assert.equal(JSON.stringify(list).includes("SYNTHETIC"), false);
  assert.equal(JSON.stringify(list).includes("2099-10-20"), false);
  const cookies = await send("Network.getCookies", {
    urls: ["http://127.0.0.1:4200/api/vault"],
  });
  assert.ok(
    cookies.cookies
      .filter((c) => c.name.startsWith("diary_"))
      .every((c) => c.httpOnly && c.sameSite === "Strict"),
  );
  await action(`await a.vault.perform(()=>a.vault.lock());`);
  assert.equal(
    await evaluate(`document.body.innerText.includes('SYNTHETIC FUTURE')`),
    false,
  );
  assert.equal(await action(`return a.diary.states().size;`), 0);
  await action(`p.passphrase='wrong synthetic passphrase';await p.unlock();`);
  assert.equal(await action(`return a.vault.state();`), "locked");
  await action(`p.passphrase='synthetic vault passphrase';await p.unlock();`);
  assert.equal(
    await action(`return a.diary.state('2099-10-20').body;`),
    "SYNTHETIC FUTURE BODY",
  );
  // A second tab cannot open the same vault while the first holds its Web Lock.
  const second = await send("Target.createTarget", {
    url: "http://127.0.0.1:4200",
  });
  const target = (
    await (await fetch("http://127.0.0.1:9222/json")).json()
  ).find((t) => t.id === second.targetId);
  const other = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => other.addEventListener("open", r, { once: true }));
  const otherEvaluate = (expression) =>
    new Promise((resolve, reject) => {
      other.addEventListener(
        "message",
        (e) => {
          const d = JSON.parse(e.data);
          if (d.id === 1)
            d.result?.exceptionDetails
              ? reject(new Error("Second tab evaluation failed"))
              : resolve(d.result.result.value);
        },
        { once: true },
      );
      other.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
  await sleep(1200);
  const secondResult = await otherEvaluate(
    `(async()=>{const a=${app};await a.vault.perform(()=>a.vault.unlock('synthetic vault passphrase'));return {state:a.vault.state(),error:a.vault.error()};})()`,
  );
  assert.equal(secondResult.state, "locked");
  assert.ok(secondResult.error.includes("another tab"));
  other.close();
  await send("Target.closeTarget", { targetId: second.targetId });
  // Emulate backend outage; draft encryption/IndexedDB still succeeds before lock.
  await action(
    `window.originalFetch=window.fetch;window.fetch=(path,init)=>init?.method==='PUT'&&String(path).startsWith('/api/entries/')?Promise.resolve(new Response('{}',{status:503})):window.originalFetch(path,init);a.diary.edit(a.selected(),'SYNTHETIC FUTURE','SYNTHETIC OFFLINE DRAFT');await a.diary.save(a.selected());await a.vault.perform(()=>a.vault.lock());`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  const persisted = await evaluate(
    `new Promise((resolve,reject)=>{const r=indexedDB.open('webdiary-encrypted-drafts');r.onsuccess=()=>{const q=r.result.transaction('drafts').objectStore('drafts').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(new Error('Read drafts failed'));};})`,
  );
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("SYNTHETIC"), false);
  assert.equal(JSON.stringify(persisted).includes("2099-10-20"), false);
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`!!document.querySelector('#unlock-pass')`);
  await action(
    `p.passphrase='synthetic vault passphrase';await p.unlock();await a.select('2099-10-20');`,
  );
  assert.equal(
    await action(`return a.entry().body;`),
    "SYNTHETIC OFFLINE DRAFT",
  );
  await action(`await a.diary.save(a.selected());`);
  assert.equal(await action(`return a.entry().status;`), "saved");
  await action(
    `await a.vault.perform(()=>a.vault.changePassphrase('synthetic vault passphrase','new synthetic vault passphrase'));await a.vault.perform(()=>a.vault.lock());p.passphrase='synthetic vault passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  await action(
    `p.passphrase='new synthetic vault passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  await action(
    `await a.vault.perform(()=>a.vault.rotateRecovery('new synthetic vault passphrase'));`,
  );
  const replacement = await action(`return a.vault.recoverySecret();`);
  assert.equal(replacement.length, 64);
  assert.notEqual(replacement, setup.secret);
  await action(
    `p.recoveryInput=${JSON.stringify(replacement)};p.savedOffline=true;await p.verify();await a.vault.perform(()=>a.vault.lock());await a.vault.perform(()=>a.vault.recover(${JSON.stringify(setup.secret)},'recovered synthetic passphrase'));`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  await action(
    `await a.vault.perform(()=>a.vault.recover(${JSON.stringify(replacement)},'recovered synthetic passphrase'));`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  assert.equal(
    await action(`return a.diary.state('2099-10-20').body;`),
    "SYNTHETIC OFFLINE DRAFT",
  );
  // Accelerate the clock, not the production timeout: test five-minute inactivity.
  await action(
    `window.originalNow=Date.now;Date.now=()=>window.originalNow()+6*60000;`,
  );
  await waitFor(`${app}.vault.state()==='locked'`);
  await action(
    `Date.now=window.originalNow;p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  // IDB failure refuses lock and preserves the key/editor for retry.
  await action(
    `await a.select('2099-10-20');a.diary.edit(a.selected(),'Title','SYNTHETIC STORAGE FAILURE');window.originalPut=a.diary.drafts.put;a.diary.drafts.put=async()=>{throw new Error('Synthetic storage failure');};await a.vault.perform(()=>a.vault.lock());`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  assert.equal(
    await action(`return a.entry().body;`),
    "SYNTHETIC STORAGE FAILURE",
  );
  await action(
    `a.diary.drafts.put=window.originalPut;await a.diary.save(a.selected());await a.vault.perform(()=>a.vault.changeLogin('synthetic login password','replacement synthetic login'));`,
  );
  assert.equal(await action(`return a.vault.state();`), "login");
  await action(
    `p.loginPassword='replacement synthetic login';await p.login();p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  // Authenticated ciphertext corruption cannot open an empty replacement vault.
  await action(
    `const page=await a.vault.auth.request('/api/entries');const r=page.records[0];await a.vault.auth.request('/api/entries/'+r.id,'PUT',{crypto_version:1,nonce:r.nonce,ciphertext:'AAAAAAAAAAAAAAAAAAAAAA==',expected_revision:r.revision,operation_id:crypto.randomUUID()});await a.vault.perform(()=>a.vault.lock());p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  assert.equal(await action(`return a.diary.states().size;`), 0);
  assert.ok((await action(`return a.vault.error();`)).includes("integrity"));
  console.log(
    `PASS: setup, encrypted API/IndexedDB, wrong keys, second-tab exclusion, lock/reload drafts, passphrase change, recovery rotation, auto-lock, storage failure, login change and tampering. Setup KDF flow: ${Math.round(setup.ms)} ms.`,
  );
} finally {
  ws.close();
}
