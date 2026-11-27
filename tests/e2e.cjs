// End-to-end browser test of the L7zip page served by the Docker image.
// Usage: BASE=http://localhost:8080 OUT=tests/out node tests/e2e.cjs
// Encrypted ZIPs it produces are written to $OUT so CI can open them with 7-Zip:
//   visible.zip  data.bin encrypted directly
//   wrapped.zip  data.bin wrapped in a plain archive.zip, which is encrypted
// If $OUT/interop.zip exists (AES-256 ZIP of hello.txt and data.bin made by 7-Zip,
// password "interop-pw"), it is decrypted too.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = path.resolve(process.env.OUT || "tests/out");
const PW = "correct horse battery staple";
fs.mkdirSync(OUT, { recursive: true });

const HELLO = { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("Hello, L7zip!\n") };
const DATA = { name: "data.bin", mimeType: "application/octet-stream", buffer: Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31) % 251)) };

let page;
const problems = [];

// Lists a ZIP with zip.js inside the page: [{ name, encrypted, size, text }]
async function readZip(buf, password) {
  return page.evaluate(async ([arr, password]) => {
    const r = new zip.ZipReader(new zip.BlobReader(new Blob([new Uint8Array(arr)])));
    const out = [];
    for (const e of await r.getEntries()) {
      if (e.directory) continue;
      const data = await e.getData(new zip.Uint8ArrayWriter(), { password: e.encrypted ? password : undefined });
      out.push({ name: e.filename, encrypted: e.encrypted, size: data.length, text: new TextDecoder().decode(data.slice(0, 64)) });
    }
    await r.close();
    return out;
  }, [Array.from(buf), password]);
}

// Builds a ZIP inside the page. entries: [{ name, text, password? }]; an entry without a
// password is stored unencrypted. inner: { name, entries } puts a ZIP of those entries inside.
async function makeZip(entries) {
  return Buffer.from(await page.evaluate(async (entries) => {
    const build = async (list) => {
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"));
      for (const e of list) {
        const reader = e.inner ? new zip.BlobReader(await build(e.inner)) : new zip.TextReader(e.text);
        await w.add(e.name, reader, e.password ? { password: e.password, encryptionStrength: 3 } : {});
      }
      return w.close();
    };
    return Array.from(new Uint8Array(await (await build(entries)).arrayBuffer()));
  }, entries));
}

async function clickDownload(locator) {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), locator.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync(await d.path()) };
}
const downloadButton = (panel) => page.locator(`#${panel}-out button`, { hasText: "Download" });

async function encrypt({ file, wrap, compress, name }) {
  await page.click("#tab-enc");
  await page.setInputFiles("#enc-file", file);
  await page.fill("#enc-pw", PW);
  await page.fill("#enc-pw2", PW);
  await page.fill("#enc-name", name);
  await page.setChecked("#enc-hide", wrap);
  await page.setChecked("#enc-compress", compress);
  await page.click("#enc-go");
  await page.waitForSelector("#enc-out:not([hidden])");
  assert.match(await page.textContent("#enc-msg"), /^Done\./);
  assert.equal(await downloadButton("enc").count(), 1);
  const dl = await clickDownload(downloadButton("enc"));
  assert.equal(dl.name, name);
  fs.writeFileSync(path.join(OUT, name), dl.buf);
  await page.click("#wipe");
  return dl.buf;
}

async function decrypt(name, buf, password) {
  await page.click("#tab-dec");
  await page.setInputFiles("#dec-file", { name, mimeType: "application/zip", buffer: buf });
  await page.fill("#dec-pw", password);
  await page.click("#dec-go");
  await page.waitForFunction(() => !document.getElementById("dec-go").disabled);
  return page.textContent("#dec-msg");
}

// Decrypts and returns the single download it offers.
async function decryptToDownload(name, buf, password) {
  const msg = await decrypt(name, buf, password);
  assert.match(msg, /^Decrypted/, msg);
  assert.equal(await downloadButton("dec").count(), 1);
  return { msg, ...(await clickDownload(downloadButton("dec"))) };
}

// Puts a big generated file on a file input inside the page (Playwright caps uploads at 50 MB).
// spec: { name, mb } for a filled file, or { name, password, zipOf: [{ name, mb }] } for an AES ZIP.
async function setBigFile(selector, spec) {
  await page.evaluate(async ([selector, spec]) => {
    const fill = (mb) => new Uint8Array(mb * 1024 * 1024).fill(7);
    let file;
    if (spec.zipOf) {
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { password: spec.password, encryptionStrength: 3, level: 0 });
      for (const f of spec.zipOf) await w.add(f.name, new zip.Uint8ArrayReader(fill(f.mb)));
      file = new File([await w.close()], spec.name, { type: "application/zip" });
    } else {
      file = new File([fill(spec.mb)], spec.name);
    }
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector(selector);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, spec]);
}

// Simulates dropping files on the page.
async function dropFiles(files) {
  await page.evaluate((files) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([f.text], f.name));
    document.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);
}

const tests = {
  async "only one file can be chosen, and there is no folder picker"() {
    assert.equal(await page.locator("#enc-file").getAttribute("multiple"), null);
    assert.equal(await page.locator("#dec-file").getAttribute("multiple"), null);
    assert.equal(await page.locator("[webkitdirectory]").count(), 0);
  },

  async "dropping several files is refused"() {
    await page.click("#tab-enc");
    await dropFiles([{ name: "a.txt", text: "a" }, { name: "b.txt", text: "b" }]);
    assert.equal(await page.textContent("#enc-msg"), "Drop one file at a time.");
    assert.equal(await page.textContent("#enc-chosen"), "");
    await dropFiles([{ name: "a.txt", text: "a" }]);
    assert.match(await page.textContent("#enc-chosen"), /^a\.txt · /);
    assert.match(await page.inputValue("#enc-name"), /^a-\d{8}\.zip$/);
  },

  async "encrypt one file, decrypt gives that file back"() {
    const buf = await encrypt({ file: DATA, wrap: false, compress: false, name: "visible.zip" });
    assert.deepEqual((await readZip(buf, PW)).map((e) => [e.name, e.encrypted, e.size]), [["data.bin", true, 70000]]);
    const dl = await decryptToDownload("visible.zip", buf, PW);
    assert.equal(dl.name, "data.bin");
    assert.ok(dl.buf.equals(DATA.buffer));
  },

  async "wrapping: encrypted ZIP holds archive.zip, and decrypting peels only that layer"() {
    const buf = await encrypt({ file: DATA, wrap: true, compress: true, name: "wrapped.zip" });
    assert.deepEqual((await readZip(buf, PW)).map((e) => [e.name, e.encrypted]), [["archive.zip", true]]);
    const dl = await decryptToDownload("wrapped.zip", buf, PW);
    assert.equal(dl.name, "archive.zip");
    assert.deepEqual((await readZip(dl.buf)).map((e) => [e.name, e.encrypted, e.size]), [["data.bin", false, 70000]]);
  },

  async "the site refuses its own unwrapped archive.zip, because it isn't encrypted"() {
    const plain = await makeZip([{ name: "data.bin", text: "x" }]);
    assert.match(await decrypt("archive.zip", plain, PW), /isn't password-protected/);
    assert.equal(await page.isHidden("#dec-out"), true);
  },

  async "a partly encrypted ZIP is refused"() {
    const mixed = await makeZip([{ name: "a.txt", text: "a", password: PW }, { name: "b.txt", text: "b" }]);
    assert.match(await decrypt("mixed.zip", mixed, PW), /isn't password-protected/);
  },

  async "wrong password is reported"() {
    const buf = fs.readFileSync(path.join(OUT, "visible.zip"));
    assert.equal(await decrypt("visible.zip", buf, "nope"), "Wrong password.");
    assert.equal(await page.isHidden("#dec-out"), true);
  },

  async "an encrypted ZIP inside is passed on still encrypted, never opened"() {
    const nested = await makeZip([{ name: "archive.zip", password: PW, inner: [{ name: "secret.txt", text: "s", password: PW }] }]);
    const dl = await decryptToDownload("nested.zip", nested, PW);
    assert.equal(dl.name, "archive.zip");
    assert.deepEqual((await readZip(dl.buf, PW)).map((e) => [e.name, e.encrypted]), [["secret.txt", true]]);
  },

  async "several files inside give one plain ZIP, with repeated names renamed"() {
    const multi = await makeZip([
      { name: "docs/a.txt", text: "1", password: PW }, { name: "b.txt", text: "2", password: PW },
    ]);
    const dl = await decryptToDownload("multi.zip", multi, PW);
    assert.match(dl.msg, /^Decrypted 2 files into one ZIP\./);
    assert.equal(dl.name, "multi-decrypted.zip");
    assert.deepEqual((await readZip(dl.buf)).map((e) => [e.name, e.encrypted, e.text]), [["docs/a.txt", false, "1"], ["b.txt", false, "2"]]);
    const names = await page.evaluate(() => {
      const used = new Set();
      return ["x/a.txt", "x/a.txt", "noext", "noext", "x/a.txt"].map((p) => uniquePath(used, p));
    });
    assert.deepEqual(names, ["x/a.txt", "x/a (2).txt", "noext", "noext (2)", "x/a (3).txt"]);
  },

  async "Clear everything cancels an encryption in progress"() {
    await page.click("#tab-enc");
    // Large enough that encryption is still running when the wipe happens.
    await setBigFile("#enc-file", { name: "big.bin", mb: 64 });
    await page.fill("#enc-pw", PW); await page.fill("#enc-pw2", PW);
    await page.setChecked("#enc-hide", true); await page.setChecked("#enc-compress", true);
    await page.click("#enc-go");
    await page.waitForFunction(() => document.getElementById("enc-msg").textContent === "Encrypting…");
    await page.click("#wipe");
    await page.waitForTimeout(3000);
    assert.equal(await page.isHidden("#enc-out"), true);
    assert.equal(await page.textContent("#enc-msg"), "");
    assert.equal(await page.isHidden("#enc-progress"), true);
    assert.equal(await page.isDisabled("#enc-file"), false);
  },

  async "the file can't be changed while encrypting"() {
    await page.click("#tab-enc");
    await setBigFile("#enc-file", { name: "big.bin", mb: 64 });
    await page.fill("#enc-pw", PW); await page.fill("#enc-pw2", PW);
    await page.setChecked("#enc-hide", false); await page.setChecked("#enc-compress", true);
    await page.click("#enc-go");
    await page.waitForFunction(() => document.getElementById("enc-msg").textContent === "Encrypting…");
    assert.equal(await page.isDisabled("#enc-file"), true);
    assert.equal(await page.isDisabled("#enc-go"), true);
    await dropFiles([{ name: "other.txt", text: "x" }]);
    assert.match(await page.textContent("#enc-chosen"), /^big\.bin/);
    await page.waitForSelector("#enc-out:not([hidden])", { timeout: 60_000 });
    assert.match(await page.textContent("#enc-out .name"), /^big-\d{8}\.zip$/);
    assert.equal(await page.isDisabled("#enc-file"), false);
  },

  async "choosing another ZIP while decrypting cancels the first"() {
    await page.click("#tab-dec");
    await setBigFile("#dec-file", { name: "big.zip", password: PW, zipOf: [{ name: "big1.bin", mb: 48 }, { name: "big2.bin", mb: 48 }] });
    await page.fill("#dec-pw", PW);
    await page.click("#dec-go");
    await page.waitForFunction(() => document.getElementById("dec-msg").textContent === "Decrypting…");
    const small = fs.readFileSync(path.join(OUT, "visible.zip"));
    await page.setInputFiles("#dec-file", { name: "second.zip", mimeType: "application/zip", buffer: small });
    assert.equal(await page.isHidden("#dec-progress"), true);
    assert.equal(await page.isDisabled("#dec-go"), false);
    await page.waitForTimeout(3000);   // the first decryption must not show up under the second file
    assert.equal(await page.isHidden("#dec-out"), true);
    assert.equal(await page.textContent("#dec-msg"), "");
    const dl = await decryptToDownload("second.zip", small, PW);
    assert.equal(dl.name, "data.bin");
  },

  async "Clear everything during decryption leaves no message or result"() {
    await page.click("#tab-dec");
    await setBigFile("#dec-file", { name: "big.zip", password: PW, zipOf: [{ name: "big1.bin", mb: 48 }, { name: "big2.bin", mb: 48 }] });
    await page.fill("#dec-pw", PW);
    await page.click("#dec-go");
    await page.waitForFunction(() => document.getElementById("dec-msg").textContent === "Decrypting…");
    await page.click("#wipe");
    await page.waitForTimeout(3000);
    assert.equal(await page.textContent("#dec-msg"), "");
    assert.equal(await page.isHidden("#dec-out"), true);
  },

  async "decrypts an AES-256 ZIP made by 7-Zip"() {
    const p = path.join(OUT, "interop.zip");
    if (!fs.existsSync(p)) { console.log("     (skipped: no interop.zip)"); return; }
    const dl = await decryptToDownload("interop.zip", fs.readFileSync(p), "interop-pw");
    assert.equal(dl.name, "interop-decrypted.zip");
    assert.deepEqual((await readZip(dl.buf)).map((e) => [e.name, e.encrypted, e.size]).sort(),
      [["data.bin", false, 70000], ["hello.txt", false, 14]]);
  },
};

(async () => {
  // Give 7-Zip the same input files so CI can compare what it extracts.
  const src = path.join(OUT, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const f of [HELLO, DATA]) fs.writeFileSync(path.join(src, f.name), f.buffer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  page.on("pageerror", (e) => problems.push("page error: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Invalid password/.test(m.text())) problems.push("console error: " + m.text()); });
  page.on("request", (r) => { if (!r.url().startsWith(BASE) && !/^(blob|data):/.test(r.url())) problems.push("off-site request: " + r.url()); });
  await page.goto(BASE + "/");
  await page.waitForFunction(() => typeof zip !== "undefined");

  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log("ok   " + name); }
    catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n     ")); }
    finally { await page.click("#wipe").catch(() => {}); }
  }
  // Reload so a fresh page checks that the service worker registers.
  await page.reload();
  try {
    await page.waitForFunction(() => /offline/.test(document.getElementById("offline-state")?.textContent || ""), null, { timeout: 15_000 });
    console.log("ok   service worker registers");
  } catch { failed++; console.log("FAIL service worker registers"); }

  for (const p of problems) { failed++; console.log("FAIL " + p); }
  await browser.close();
  console.log(failed ? `\n${failed} failure(s)` : "\nall passed");
  process.exit(failed ? 1 : 0);
})();
