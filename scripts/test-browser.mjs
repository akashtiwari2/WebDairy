// Run ONLY with a fresh disposable database, Angular development server and
// temporary Chromium profile (CDP on loopback 9222). Refuses an existing vault.
// Test passwords/diary strings below are synthetic; recovery keys stay in RAM.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
async function reload() {
  const loaded = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", listener);
      reject(new Error("Page reload timed out"));
    }, 10000);
    const listener = (e) => {
      if (JSON.parse(e.data).method === "Page.loadEventFired") {
        clearTimeout(timer);
        ws.removeEventListener("message", listener);
        resolve();
      }
    };
    ws.addEventListener("message", listener);
  });
  await send("Page.reload", { ignoreCache: true });
  await loaded;
}
async function action(code) {
  return evaluate(`(async()=>{const a=${app},p=${panel};${code}})()`);
}
try {
  await send("Page.enable");
  await send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: process.env.WEBDIARY_BROWSER_DOWNLOADS,
  });
  await send("Page.navigate", { url: "http://127.0.0.1:4300" });
  await waitFor(`!!window.ng && !!document.querySelector('#start-new-diary')`);
  assert.equal(
    await evaluate(`!!document.querySelector('app-backup-panel')`),
    false,
    "Welcome should show a focused choice, not the full backup form",
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('#google-login') && document.querySelector('#google-login').disabled`,
    ),
    true,
    "Unconfigured Google is visible with honest unavailable feedback",
  );
  assert.equal(
    await evaluate(
      `document.body.innerText.includes('PostgreSQL ready') || document.body.innerText.includes('DEVELOPMENT')`,
    ),
    false,
  );
  await evaluate(`document.querySelector('#start-new-diary').click()`);
  await waitFor(`!!document.querySelector('#setup-login')`);
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
  // Desktop diary fits the viewport, including a six-week calendar month.
  for (const [width, height] of [
    [1440, 900],
    [1366, 768],
    [1024, 650],
  ]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await action(`a.calendarOpen.set(true);a.setMonth('2026-08');`);
    await sleep(100);
    const layout = await evaluate(
      `(()=>{const editor=document.querySelector('.editor'),body=document.querySelector('#body');return {pageHeight:document.documentElement.scrollHeight,windowHeight:window.innerHeight,pageWidth:document.documentElement.scrollWidth,windowWidth:window.innerWidth,bodyHeight:body.clientHeight,buttonsVisible:[...document.querySelectorAll('.editor-actions button')].every(b=>b.getBoundingClientRect().bottom<=window.innerHeight)};})()`,
    );
    assert.ok(
      layout.pageHeight <= layout.windowHeight + 1,
      "Desktop diary has unwanted page scroll at " +
        width +
        "x" +
        height +
        ": " +
        JSON.stringify(layout),
    );
    assert.ok(layout.pageWidth <= layout.windowWidth, "Horizontal overflow");
    assert.ok(layout.bodyHeight >= 96, "Editor remains usable");
    assert.equal(layout.buttonsVisible, true, "Save controls stay visible");
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const [date, title, body] of [
    ["2024-02-29", "SYNTHETIC LEAP", "SYNTHETIC OLD BODY"],
    ["2099-10-20", "SYNTHETIC FUTURE", "SYNTHETIC FUTURE BODY"],
  ]) {
    const result = await action(
      `await a.select(${JSON.stringify(date)});a.diary.edit(a.selected(),${JSON.stringify(title)},${JSON.stringify(body)},'Happy',['SYNTHETIC TAG']);await a.diary.save(a.selected());return a.entry().status;`,
    );
    assert.equal(result, "saved");
  }
  assert.equal(
    await evaluate(
      `document.body.innerText.includes('Restore saved text') || document.body.innerText.includes('Save now')`,
    ),
    false,
  );
  await waitFor(`${app}.backup.localReady()`);
  assert.equal(await action(`return a.backup.health().kind;`), "missing");
  assert.equal(
    await action(`return a.streak().total;`),
    1,
    "Future dates do not count toward writing streak",
  );
  // UI-only mock metadata: automatic latest selection must not overwrite an older
  // snapshot explicitly chosen by the user. Real Google acceptance remains separate.
  await action(
    `window.originalGoogleStatus={...a.backup.google.status()};window.originalPreferences={...a.preferences.value()};a.preferences.set({...a.preferences.value(),backup_frequency:'manual'});a.backup.google.status.set({...a.backup.google.status(),configured:true,linked:true,drive_connected:true,email:'synthetic@example.com'});a.backup.google.listed.set(true);a.backup.google.files.set([{id:'older_snapshot',createdTime:'2024-01-01T00:00:00Z',appProperties:{snapshot_at:'2024-01-01T00:00:00Z'}},{id:'latest_snapshot',createdTime:'2024-02-01T00:00:00Z',appProperties:{snapshot_at:'2024-02-01T00:00:00Z'}}]);a.openTool('backup');`,
  );
  await waitFor(`!!document.querySelector('#show-drive-restore')`);
  await evaluate(`document.querySelector('#show-drive-restore').click()`);
  await waitFor(`!!document.querySelector('#drive-backup')`);
  assert.equal(
    await evaluate(`document.querySelector('#drive-backup').value`),
    "latest_snapshot",
  );
  await evaluate(
    `const input=document.querySelector('#drive-backup');input.value='older_snapshot';input.dispatchEvent(new Event('change'));`,
  );
  await sleep(100);
  assert.equal(
    await evaluate(`document.querySelector('#drive-backup').value`),
    "older_snapshot",
  );
  assert.equal(
    await evaluate(`document.querySelector('#verify-drive').disabled`),
    true,
    "Backup password is required before verification",
  );
  await action(
    `a.backup.google.status.set(window.originalGoogleStatus);a.backup.google.files.set([]);a.backup.google.listed.set(false);a.preferences.set(window.originalPreferences);a.openTool('diary');delete window.originalGoogleStatus;delete window.originalPreferences;`,
  );
  // A local backend outage must preserve encrypted edits and resume without a manual save.
  await action(
    `await a.select('2024-02-29');window.featureFetch=window.fetch;window.fetch=(url,...args)=>String(url).startsWith('/api/')?Promise.reject(new TypeError('synthetic backend outage')):window.featureFetch(url,...args);a.diary.edit(a.selected(),'SYNTHETIC LEAP','SYNTHETIC OFFLINE FIRST','Sad',['SYNTHETIC TAG']);await a.diary.save(a.selected());a.diary.edit(a.selected(),'SYNTHETIC LEAP','SYNTHETIC OFFLINE LATEST','Calm',['SYNTHETIC TAG','Travel']);await a.diary.save(a.selected());`,
  );
  assert.equal(
    await action(
      `return a.entry().localDraftReady && a.diary.connectionLost();`,
    ),
    true,
  );
  assert.equal(
    await action(`return a.entry().body;`),
    "SYNTHETIC OFFLINE LATEST",
  );
  await waitFor(`document.body.innerText.includes('Saved on this device')`);
  await action(
    `window.fetch=window.featureFetch;delete window.featureFetch;window.dispatchEvent(new Event('online'));`,
  );
  await waitFor(`${app}.entry().status==='saved'`);
  assert.equal(
    await action(
      `return {body:a.entry().savedBody,mood:a.entry().savedMood,tags:a.entry().savedTags};`,
    ).then((x) => JSON.stringify(x)),
    JSON.stringify({
      body: "SYNTHETIC OFFLINE LATEST",
      mood: "Calm",
      tags: ["SYNTHETIC TAG", "Travel"],
    }),
  );
  await action(`a.settings.set(true);`);
  await waitFor(`!!document.querySelector('#show-streak')`);
  await evaluate(`document.querySelector('#show-streak').click()`);
  await action(`a.openTool('diary');`);
  await waitFor(`!!document.querySelector('#body')`);
  assert.equal(
    await evaluate(`!!document.querySelector('#writing-streak')`),
    false,
  );
  await action(
    `a.preferences.set({...a.preferences.value(),show_streak:true});`,
  );
  await action(`await a.select('2099-10-20');`);
  if (process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR) {
    mkdirSync(process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR, { recursive: true });
    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR + "/diary-desktop.png",
      Buffer.from(shot.data, "base64"),
    );
    await action(`a.settings.set(true);`);
    await waitFor(`!!document.querySelector('.preferences-grid')`);
    assert.equal(
      await evaluate(`!!document.querySelector('#body')`),
      false,
      "Settings uses its own view",
    );
    const settings = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR + "/settings-desktop.png",
      Buffer.from(settings.data, "base64"),
    );
    await action(`a.openTool('diary');`);
    await waitFor(`!!document.querySelector('#body')`);
  }
  const list = await action(
    `return await a.vault.auth.request('/api/entries');`,
  );
  assert.equal(list.records.length, 2);
  assert.equal(JSON.stringify(list).includes("SYNTHETIC"), false);
  assert.equal(JSON.stringify(list).includes("2099-10-20"), false);
  const cookies = await send("Network.getCookies", {
    urls: ["http://127.0.0.1:4300/api/vault"],
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
    url: "http://127.0.0.1:4300",
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
    `await a.select('2099-10-20');window.originalFetch=window.fetch;window.fetch=(path,init)=>init?.method==='PUT'&&String(path).startsWith('/api/entries/')||String(path).startsWith('/api/backup/')?Promise.resolve(new Response('{}',{status:503})):window.originalFetch(path,init);a.diary.edit(a.selected(),'SYNTHETIC FUTURE','SYNTHETIC OFFLINE DRAFT');await a.diary.save(a.selected());const offline=await a.backup.exportBackup(true);if(JSON.stringify(offline).includes('SYNTHETIC'))throw new Error('Plaintext in emergency export');await a.backup.inspectText(JSON.stringify(offline),${JSON.stringify(setup.secret)},'recovery');if(a.backup.preview().source!=='browser-draft')throw new Error('Emergency export is not labelled');await a.vault.perform(()=>a.vault.lock());`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  const persisted = await evaluate(
    `new Promise((resolve,reject)=>{const r=indexedDB.open('webdiary-encrypted-drafts');r.onsuccess=()=>{const q=r.result.transaction('drafts').objectStore('drafts').getAll();q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(new Error('Read drafts failed'));};})`,
  );
  assert.equal(persisted.length, 1);
  assert.equal(JSON.stringify(persisted).includes("SYNTHETIC"), false);
  assert.equal(JSON.stringify(persisted).includes("2099-10-20"), false);
  await reload();
  await waitFor(`!!document.querySelector('#unlock-pass')`);
  await action(`p.passphrase='synthetic vault passphrase';await p.unlock();`);
  await waitFor(`!!document.querySelector('#body')`);
  await action(`await a.select('2099-10-20');`);
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
    `a.diary.drafts.put=window.originalPut;await a.diary.save(a.selected());p.current='recovered synthetic passphrase';p.currentLogin='synthetic login password';p.loginPassword='replacement synthetic login';await p.changeLogin();`,
  );
  assert.equal(await action(`return a.vault.state();`), "login");
  await action(
    `p.loginPassword='replacement synthetic login';await p.login();p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  // Phase 3: real UI search stays local, with case-insensitive/date filters.
  await action(`a.tools.set('library');`);
  await waitFor(`!!document.querySelector('#search-query')`);
  const library = `window.ng.getComponent(document.querySelector('app-library-panel'))`;
  const search = await evaluate(
    `(async()=>{const a=${app},l=${library};window.phase3Requests=[];const original=window.fetch;window.fetch=(path,init)=>{window.phase3Requests.push(String(path));return original(path,init)};l.query.set('sToRaGe FaIlUrE');l.from.set('2099-10-20');l.until.set('2099-10-20');return {count:l.results().length,body:l.results()[0]?.body,requests:window.phase3Requests};})()`,
  );
  assert.equal(search.count, 1);
  assert.equal(search.body, "SYNTHETIC STORAGE FAILURE");
  assert.deepEqual(search.requests, []);
  await evaluate(`${library}.open.emit('2099-10-20')`);
  await waitFor(
    `${app}.tools()==='diary' && !!document.querySelector('#body')`,
  );
  // Preserve trash on same-date recreation; compare occupied dates, restore elsewhere.
  await action(
    `await a.select('2031-03-04');a.diary.edit(a.selected(),'SYNTHETIC TRASH ORIGINAL','SYNTHETIC TRASH ORIGINAL BODY');await a.diary.save(a.selected());window.trashID=a.entry().id;await a.diary.deleteEntry(a.selected());await a.diary.load(a.selected());a.diary.edit(a.selected(),'SYNTHETIC OCCUPIED','SYNTHETIC KEEP OCCUPIED');await a.diary.save(a.selected());a.tools.set('library');`,
  );
  await waitFor(`!!document.querySelector('app-library-panel')`);
  await evaluate(
    `${library}.tab.set('trash');${library}.inspect(window.trashID);`,
  );
  await waitFor(`document.body.innerText.includes('This date is occupied')`);
  const occupied = await action(
    `try{await a.diary.restoreTrash(window.trashID,'2031-03-04');return false;}catch{return a.diary.state('2031-03-04').body==='SYNTHETIC KEEP OCCUPIED';}`,
  );
  assert.equal(occupied, true);
  await evaluate(
    `${library}.alternative.set('2031-03-05');${library}.restore(window.trashID);`,
  );
  await waitFor(
    `${app}.tools()==='diary' && ${app}.selected()==='2031-03-05' && ${app}.entry().status==='saved'`,
  );
  assert.equal(
    await action(`return a.entry().body;`),
    "SYNTHETIC TRASH ORIGINAL BODY",
  );
  for (const date of ["2031-03-04", "2031-03-05"])
    await action(
      `await a.diary.deleteEntry('${date}');const row=[...a.diary.trash().values()].find(s=>s.date==='${date}');await a.diary.purgeTrash(row.id);`,
    );
  // Include title-only Today and retained trash in the portable snapshot.
  const today = await action(`return a.today();`);
  await action(
    `await a.select(${JSON.stringify(today)});a.diary.edit(a.selected(),'SYNTHETIC TODAY TITLE ONLY','');await a.diary.save(a.selected());await a.select('2031-03-07');a.diary.edit(a.selected(),'SYNTHETIC RETAINED TRASH','SYNTHETIC RETAINED TRASH BODY');await a.diary.save(a.selected());await a.diary.deleteEntry(a.selected());a.preferences.set({...a.preferences.value(),theme:'dark',timezone:'America/New_York'});`,
  );
  assert.equal(
    await evaluate(`document.documentElement.dataset.theme`),
    "dark",
  );
  await action(
    `await a.vault.lock();p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.selected()===a.today();`), true);
  // Confirm the hidden calendar expands the editor, and mobile layout has no overflow.
  await action(`a.calendarOpen.set(false);`);
  await waitFor(`document.querySelector('.workspace.calendar-hidden')!==null`);
  assert.equal(
    await evaluate(`document.querySelector('.workspace').children.length`),
    1,
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length`,
    ),
    1,
  );
  if (process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR) {
    mkdirSync(process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR, { recursive: true });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await action(`a.tools.set('backup');`);
    await waitFor(`!!document.querySelector('#file-backups')`);
    await evaluate(`document.querySelector('#file-backups').open=true`);
    await waitFor(`!!document.querySelector('#export-backup')`);
    const desktop = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR + "/backups-desktop.png",
      Buffer.from(desktop.data, "base64"),
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(200);
    assert.equal(
      await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),
      true,
    );
    const mobile = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR + "/backups-mobile.png",
      Buffer.from(mobile.data, "base64"),
    );
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await action(`a.tools.set('diary');`);
  }
  const expected = await action(
    `return {active:[...a.diary.states().values()].filter(s=>s.revision>0).map(s=>({date:s.date,title:s.title,body:s.body,mood:s.mood||'',tags:s.tags||[]})).sort((a,b)=>a.date.localeCompare(b.date)),trash:[...a.diary.trash().values()].map(s=>({date:s.date,title:s.title,body:s.body,mood:s.mood||'',tags:s.tags||[]}))};`,
  );
  const archive = await action(`return await a.backup.exportBackup();`);
  assert.equal(JSON.stringify(archive).includes("SYNTHETIC"), false);
  assert.equal(await action(`return a.backup.health().kind;`), "recent");
  await sleep(300);
  const downloaded = readdirSync(process.env.WEBDIARY_BROWSER_DOWNLOADS).filter(
    (n) => n.endsWith(".diary"),
  );
  assert.ok(downloaded.length > 0);
  const backupName = downloaded.find(
    (name) =>
      JSON.parse(
        readFileSync(
          process.env.WEBDIARY_BROWSER_DOWNLOADS + "/" + name,
          "utf8",
        ),
      ).ciphertext === archive.ciphertext,
  );
  assert.ok(
    backupName,
    "Database export was downloaded separately from emergency drafts",
  );
  const file = readFileSync(
    process.env.WEBDIARY_BROWSER_DOWNLOADS + "/" + backupName,
    "utf8",
  );
  assert.equal(JSON.parse(file).format, "webdiary-backup");
  assert.equal(file.includes("SYNTHETIC"), false);
  // Invalid file/key preview never changes the existing database.
  const before = await action(
    `return JSON.stringify(await a.vault.auth.request('/api/backup/snapshot'));`,
  );
  const invalid = { ...archive, ciphertext: "AAAAAAAAAAAAAAAAAAAAAA==" };
  assert.equal(
    await action(
      `try{await a.backup.inspectText(${JSON.stringify(JSON.stringify(invalid))},${JSON.stringify(replacement)},'recovery');return false;}catch{return a.backup.preview()===null;}`,
    ),
    true,
  );
  assert.equal(
    await action(
      `try{await a.backup.inspectText(${JSON.stringify(JSON.stringify(archive))},'wrong synthetic passphrase','passphrase');return false;}catch{return a.backup.preview()===null;}`,
    ),
    true,
  );
  const after = await action(
    `return JSON.stringify(await a.vault.auth.request('/api/backup/snapshot'));`,
  );
  assert.deepEqual(JSON.parse(after).records, JSON.parse(before).records);
  assert.deepEqual(JSON.parse(after).vault, JSON.parse(before).vault);
  // Failed local safety storage cannot authorize replacement.
  await action(
    `await a.backup.inspectText(${JSON.stringify(JSON.stringify(archive))},${JSON.stringify(replacement)},'recovery');window.originalBackupSave=a.backup.store.save;a.backup.store.save=async()=>{throw new Error('Synthetic backup storage full');};`,
  );
  assert.equal(
    await action(
      `try{await a.backup.prepareSafety();return false;}catch{return !a.backup.safetyReady();}finally{a.backup.store.save=window.originalBackupSave;}`,
    ),
    true,
  );
  assert.equal(
    await action(
      `try{await a.backup.commit('',true);return false;}catch{return a.vault.state()==='unlocked';}`,
    ),
    true,
  );
  await action(
    `await a.backup.inspectText(${JSON.stringify(JSON.stringify(archive))},${JSON.stringify(replacement)},'recovery');await a.backup.prepareSafety();await a.select('2099-10-20');a.diary.edit(a.selected(),'Title','SYNTHETIC CHANGED AFTER SAFETY');await a.diary.save(a.selected());`,
  );
  const stale = await action(
    `try{await a.backup.commit('',true);return '';}catch(e){return e.message;}`,
  );
  assert.ok(stale.includes("Current diary changed"));
  assert.equal(
    await action(`return a.diary.state('2099-10-20').body;`),
    "SYNTHETIC CHANGED AFTER SAFETY",
  );
  // Simulate a lost successful commit response. Retry acknowledges once without replacing again.
  await action(
    `await a.backup.prepareSafety();const original=window.fetch;let lost=true;window.fetch=async(path,init)=>{const response=await original(path,init);if(lost&&String(path)==='/api/restore/commit'&&response.ok){lost=false;throw new TypeError('Synthetic lost restore acknowledgement');}return response;};await a.backup.commit('',true);`,
  );
  assert.equal(await action(`return a.vault.state();`), "unlocked");
  assert.equal(
    await action(`return a.diary.state('2099-10-20').body;`),
    "SYNTHETIC STORAGE FAILURE",
  );
  assert.equal(await action(`return a.backup.history().length;`), 1);
  const safetyID = await action(`return a.backup.history()[0].id;`);
  await action(`await a.backup.downloadHistory(${JSON.stringify(safetyID)});`);
  // Gate: recreate ONLY this runner's disposable DB, restore from the downloaded file
  // using each independent secret, and choose a fresh local login each time.
  const database = process.env.WEBDIARY_BROWSER_DATABASE;
  assert.match(database, /^webdiary_browser_[0-9]+_[0-9]+$/);
  for (const mode of ["passphrase", "recovery"]) {
    await action(`await a.vault.lock();`);
    execFileSync(
      "docker",
      [
        "exec",
        "webdiary-postgres",
        "dropdb",
        "--force",
        "-U",
        "diary_dev",
        database,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      "docker",
      ["exec", "webdiary-postgres", "createdb", "-U", "diary_dev", database],
      { stdio: "pipe" },
    );
    execFileSync(
      process.env.WEBDIARY_BROWSER_BINARY,
      ["-migrate", "-migrations", "./migrations"],
      {
        env: process.env,
        stdio: "pipe",
      },
    );
    // Existing pool connections were terminated by dropdb; wait until bootstrap
    // succeeds on a reconnected pool before loading the fresh setup page.
    let reconnected = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await fetch("http://127.0.0.1:8080/api/auth/session")).ok) {
        reconnected = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(
      reconnected,
      "Backend reconnected to recreated disposable database",
    );
    await reload();
    await waitFor(`!!document.querySelector('#restore-diary')`);
    await evaluate(`document.querySelector('#restore-diary').click()`);
    await waitFor(`!!document.querySelector('#import-file')`);
    const secret =
      mode === "passphrase" ? "recovered synthetic passphrase" : replacement;
    await action(
      `await a.backup.inspectText(${JSON.stringify(file)},${JSON.stringify(secret)},'${mode}');`,
    );
    assert.equal(await action(`return a.backup.preview().active;`), 3);
    assert.equal(await action(`return a.backup.preview().trashed;`), 1);
    await action(
      `await a.backup.commit('fresh synthetic ${mode} login',true);`,
    );
    await waitFor(
      `${app}.vault.state()==='unlocked' && !!document.querySelector('#body')`,
    );
    const restored = await action(
      `return {active:[...a.diary.states().values()].filter(s=>s.revision>0).map(s=>({date:s.date,title:s.title,body:s.body,mood:s.mood||'',tags:s.tags||[]})).sort((a,b)=>a.date.localeCompare(b.date)),trash:[...a.diary.trash().values()].map(s=>({date:s.date,title:s.title,body:s.body,mood:s.mood||'',tags:s.tags||[]}))};`,
    );
    assert.deepEqual(restored, expected);
    assert.equal(
      await action(`return a.preferences.value().timezone;`),
      "America/New_York",
    );
    assert.equal(
      await evaluate(`document.documentElement.dataset.theme`),
      "dark",
    );
    assert.equal(await action(`return a.selected()===a.today();`), true);
  }
  // Long text scrolls inside the editor, without moving desktop save controls.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await action(
    `a.openTool('diary');await a.select('2099-10-20');a.diary.edit(a.selected(),'SYNTHETIC LONG ENTRY',('SYNTHETIC LONG TEXT'+String.fromCharCode(10)).repeat(400));await a.diary.save(a.selected());`,
  );
  await sleep(100);
  assert.equal(
    await evaluate(
      `document.querySelector('#body').scrollHeight>document.querySelector('#body').clientHeight`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `document.documentElement.scrollHeight<=window.innerHeight+1`,
    ),
    true,
  );
  assert.equal(
    await evaluate(
      `[...document.querySelectorAll('.editor-actions button')].every(b=>b.getBoundingClientRect().bottom<=window.innerHeight)`,
    ),
    true,
  );
  // A fresh mobile load starts with a collapsed calendar and reachable navigation.
  await action(`await a.vault.lock();`);
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await reload();
  await waitFor(`!!document.querySelector('#unlock-pass')`);
  await action(
    `p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  await waitFor(`!!document.querySelector('#body')`);
  assert.equal(await action(`return a.calendarOpen();`), false);
  assert.equal(
    await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),
    true,
  );
  if (process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR) {
    const mobile = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(
      process.env.WEBDIARY_BROWSER_SCREENSHOT_DIR + "/diary-mobile.png",
      Buffer.from(mobile.data, "base64"),
    );
  }
  // Authenticated ciphertext corruption cannot open an empty replacement vault.
  await action(
    `const page=await a.vault.auth.request('/api/entries');const r=page.records[0];await a.vault.auth.request('/api/entries/'+r.id,'PUT',{crypto_version:1,vault_epoch:a.vault.vault.vault_epoch,nonce:r.nonce,ciphertext:'AAAAAAAAAAAAAAAAAAAAAA==',expected_revision:r.revision,operation_id:crypto.randomUUID()});await a.vault.perform(()=>a.vault.lock());p.passphrase='recovered synthetic passphrase';await p.unlock();`,
  );
  assert.equal(await action(`return a.vault.state();`), "locked");
  assert.equal(await action(`return a.diary.states().size;`), 0);
  assert.ok((await action(`return a.vault.error();`)).includes("integrity"));
  console.log(
    `PASS: guided Drive UI selection (mock metadata), mood/tags encrypted API and backup restore, optional streak, backup health, offline durable drafts and automatic reconnect, simpler autosave controls, desktop viewport fit, long-text editor scrolling, independent settings/mobile navigation, setup, encrypted API/IndexedDB, wrong keys, second-tab exclusion, lock/reload drafts, passphrase change, recovery rotation, auto-lock, storage failure, login change and tampering; Phase 3 local search, occupied trash restore/purge, encrypted file download/emergency export, failed-safety preservation, invalid-file preservation, stale-safety rejection, lost-commit retry and clean-database recovery with BOTH passphrase and recovery key. Setup KDF flow: ${Math.round(setup.ms)} ms.`,
  );
} finally {
  ws.close();
}
