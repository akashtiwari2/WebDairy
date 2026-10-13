import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const tabs = await (await fetch("http://127.0.0.1:9222/json")).json();
const ws = new WebSocket(
  tabs.find((t) => t.type === "page").webSocketDebuggerUrl,
);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map(),
  exceptions = [];
ws.addEventListener("message", (e) => {
  const x = JSON.parse(e.data);
  if (x.method === "Runtime.exceptionThrown")
    exceptions.push(x.params.exceptionDetails.text);
  if (x.id) {
    const p = pending.get(x.id);
    pending.delete(x.id);
    x.error ? p.reject(new Error(x.error.message)) : p.resolve(x.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, { resolve, reject });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      r.exceptionDetails.exception?.description || "Browser evaluation failed",
    );
  return r.result.value;
};
const wait = async (expression) => {
  for (let i = 0; i < 120; i++) {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Browser condition failed: " + expression);
};
const fill = async (selector, value) =>
  evaluate(
    `(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
try {
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: "http://127.0.0.1:8080/" });
  await wait(
    `!!document.querySelector('#connection') && !document.querySelector('#connection').hidden`,
  );
  const status = await (
    await fetch("http://127.0.0.1:8080/setup/status")
  ).json();
  assert.equal(status.ready, false);
  assert.ok(
    status.message.includes("PostgreSQL"),
    "Unavailable database gets actionable guidance",
  );
  const before = readFileSync(process.env.WEBDIARY_LAUNCH_CONFIG, "utf8");
  await fill("#user", "diary_dev");
  await fill("#database", process.env.WEBDIARY_LAUNCH_DATABASE);
  await fill("#port", "1");
  await evaluate(`document.querySelector('#connection').requestSubmit()`);
  await wait(
    `document.querySelector('#message').textContent.includes('PostgreSQL')&&!document.querySelector('#connect').disabled`,
  );
  assert.equal(
    readFileSync(process.env.WEBDIARY_LAUNCH_CONFIG, "utf8"),
    before,
    "Failed connection must not overwrite settings",
  );
  await fill("#port", "5432");
  await fill("#database", process.env.WEBDIARY_LAUNCH_DATABASE + "_other");
  await evaluate(`document.querySelector('#connection').requestSubmit()`);
  await wait(
    `document.querySelector('#message').textContent.includes('another app') && !document.querySelector('#connect').disabled`,
  );
  assert.equal(
    readFileSync(process.env.WEBDIARY_LAUNCH_CONFIG, "utf8"),
    before,
    "Another database must not replace saved connection",
  );
  await fill("#database", process.env.WEBDIARY_LAUNCH_DATABASE);
  await evaluate(`document.querySelector('#connection').requestSubmit()`);
  await wait(`!!document.querySelector('#start-new-diary')`);
  const config = readFileSync(process.env.WEBDIARY_LAUNCH_CONFIG, "utf8");
  assert.ok(config.includes('CUSTOM_SETTING="retained"'));
  assert.ok(config.includes(process.env.WEBDIARY_LAUNCH_DATABASE));
  assert.equal(
    await evaluate(`!!document.querySelector('app-backup-panel')`),
    false,
    "Welcome is a focused screen",
  );
  assert.equal(
    await evaluate(
      `!!document.querySelector('#google-login') && document.querySelector('#google-login').disabled`,
    ),
    true,
    "Google setup state remains visible",
  );
  await evaluate(`document.querySelector('#start-new-diary').click()`);
  await wait(`!!document.querySelector('#setup-login')`);
  await fill("#setup-login", "synthetic packaged login password");
  await fill("#setup-pass", "synthetic packaged vault passphrase");
  await fill("#setup-confirm", "synthetic packaged vault passphrase");
  await evaluate(
    `document.querySelector('[aria-label="Set up vault"] form').requestSubmit()`,
  );
  await wait(`!!document.querySelector('#recovery-key')`);
  const secret = await evaluate(
    `document.querySelector('#recovery-key').textContent.trim()`,
  );
  assert.equal(secret.length, 64);
  await fill("#recovery-confirm", secret);
  await evaluate(
    `document.querySelector('input[name="offline"]').click();document.querySelector('[aria-label="Save recovery key"] form').requestSubmit()`,
  );
  await wait(
    `!!document.querySelector('#body')&&!document.querySelector('#body').disabled`,
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.sr-only')).position`,
    ),
    "absolute",
    "Production stylesheet must load under the packaged CSP",
  );
  assert.equal(
    await evaluate(`getComputedStyle(document.querySelector('#body')).resize`),
    "none",
    "Desktop editor scrolling uses the loaded production layout",
  );
  await fill("#title", "SYNTHETIC PACKAGED TITLE");
  await fill("#body", "SYNTHETIC PACKAGED BODY");
  await evaluate(
    `const mood=document.querySelector('#entry-mood');mood.value='Happy';mood.dispatchEvent(new Event('change'));const tags=document.querySelector('#entry-tags');tags.value='Testing';tags.dispatchEvent(new Event('change'));`,
  );
  await wait(
    `document.querySelector('.draft-status').textContent.trim()==='Saved'`,
  );
  const records = await evaluate(
    `(async()=>{const r=await fetch('/api/entries');return await r.json()})()`,
  );
  assert.equal(records.records.length, 1);
  assert.equal(JSON.stringify(records).includes("SYNTHETIC"), false);
  assert.equal(
    await evaluate(
      `document.documentElement.scrollHeight<=window.innerHeight+1`,
    ),
    true,
  );
  assert.deepEqual(exceptions, []);
  const diaryShot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    process.env.WEBDIARY_LAUNCH_SCREENSHOTS + "/diary.png",
    Buffer.from(diaryShot.data, "base64"),
  );
  await evaluate(`document.querySelector('#lock-vault').click()`);
  await wait(`!!document.querySelector('#unlock-pass')`);
  assert.equal(
    await evaluate(`!!document.querySelector('app-backup-panel')`),
    false,
    "Unlock does not display backup forms",
  );
  assert.equal(
    await evaluate(
      `document.body.innerText.includes('PostgreSQL ready')||document.body.innerText.includes('DEVELOPMENT')`,
    ),
    false,
  );
  const unlockShot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    process.env.WEBDIARY_LAUNCH_SCREENSHOTS + "/unlock.png",
    Buffer.from(unlockShot.data, "base64"),
  );
  console.log(
    "PASS: first-run connection failure/retry, CSP-compatible recovery setup, encrypted autosave/mood/tags, focused unlock and desktop viewport fit.",
  );
} finally {
  ws.close();
}
