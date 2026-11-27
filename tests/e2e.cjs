// End-to-end browser test of the L7zip page served by the Docker image.
// Usage: BASE=http://localhost:8080 OUT=tests/out node tests/e2e.cjs
// Encrypted ZIPs it produces are written to $OUT so CI can open them with 7-Zip.
// If $OUT/interop.zip exists (AES-256 ZIP made by 7-Zip, password "interop-pw"), it is decrypted too.
"use strict";
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const BASE = process.env.BASE || "http://localhost:8080";
const OUT = path.resolve(process.env.OUT || "tests/out");
const PW = "correct horse battery staple";
fs.mkdirSync(OUT, { recursive: true });

const FILES = [
  { name: "hello.txt", mimeType: "text/plain", buffer: Buffer.from("Hello, L7zip!\n") },
  { name: "data.bin", mimeType: "application/octet-stream", buffer: Buffer.from(Array.from({ length: 70000 }, (_, i) => (i * 31) % 251)) },
];

let page;
const problems = [];

async function readZip(buf, password) {
  // Lists a ZIP with zip.js inside the page: [{ name, encrypted, text? }]
  return page.evaluate(async ([arr, password]) => {
    const r = new zip.ZipReader(new zip.BlobReader(new Blob([new Uint8Array(arr)])));
    const out = [];
    for (const e of await r.getEntries()) {
      const item = { name: e.filename, encrypted: e.encrypted };
      if (!e.directory) item.size = (await e.getData(new zip.Uint8ArrayWriter(), { password: e.encrypted ? password : undefined })).length;
      out.push(item);
    }
    await r.close();
    return out;
  }, [Array.from(buf), password]);
}

async function clickDownload(locator) {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), locator.click()]);
  return { name: d.suggestedFilename(), buf: fs.readFileSync(await d.path()) };
}

async function encrypt({ hide, compress, name }) {
  await page.click("#tab-enc");
  await page.setInputFiles("#enc-files", FILES);
  await page.fill("#enc-pw", PW);
  await page.fill("#enc-pw2", PW);
  await page.fill("#enc-name", name);
  await page.setChecked("#enc-hide", hide);
  await page.setChecked("#enc-compress", compress);
  await page.click("#enc-go");
  await page.waitForSelector("#enc-out:not([hidden])");
  assert.match(await page.textContent("#enc-msg"), /^Done: /);
  const dl = await clickDownload(page.locator("#enc-out button", { hasText: "Download" }));
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

// Puts big generated files on a file input inside the page (Playwright caps uploads at 50 MB).
// spec: [{ name, mb }] for zero-filled files, or { zipOf: [{ name, mb }], password } for an AES ZIP of them.
async function setBigFiles(selector, spec) {
  await page.evaluate(async ([selector, spec]) => {
    const fill = (mb) => new Uint8Array(mb * 1024 * 1024).fill(7);
    let files;
    if (spec.zipOf) {
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { password: spec.password, encryptionStrength: 3, level: 0 });
      for (const f of spec.zipOf) await w.add(f.name, new zip.Uint8ArrayReader(fill(f.mb)));
      files = [new File([await w.close()], spec.name, { type: "application/zip" })];
    } else {
      files = spec.map((f) => new File([fill(f.mb)], f.name));
    }
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    const input = document.querySelector(selector);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, [selector, spec]);
}

const rowNames = () => page.$$eval("#dec-out .row .name", (els) => els.map((e) => e.textContent));

const tests = {
  async "encrypt with hidden names, decrypt, Download all"() {
    const buf = await encrypt({ hide: true, compress: true, name: "hidden.zip" });
    const outer = await readZip(buf, PW);
    assert.deepEqual(outer.map((e) => [e.name, e.encrypted]), [["archive.zip", true]]);

    assert.match(await decrypt("hidden.zip", buf, PW), /^Decrypted 2 files/);
    assert.deepEqual((await rowNames()).sort(), ["data.bin", "hello.txt"]);
    const all = await clickDownload(page.locator("#dec-out button", { hasText: "Download all" }));
    assert.equal(all.name, "hidden-decrypted.zip");
    const entries = await readZip(all.buf);
    assert.deepEqual(entries.map((e) => [e.name, e.encrypted, e.size]).sort(),
      [["data.bin", false, 70000], ["hello.txt", false, 14]]);
  },

  async "encrypt with visible names, no compression, single-file download"() {
    const buf = await encrypt({ hide: false, compress: false, name: "visible.zip" });
    const entries = await readZip(buf, PW);
    assert.deepEqual(entries.map((e) => [e.name, e.encrypted]).sort(), [["data.bin", true], ["hello.txt", true]]);

    await decrypt("visible.zip", buf, PW);
    const row = page.locator("#dec-out .row", { hasText: "hello.txt" });
    const one = await clickDownload(row.locator("button"));
    assert.equal(one.name, "hello.txt");
    assert.equal(one.buf.toString(), "Hello, L7zip!\n");
  },

  async "wrong password is reported"() {
    const buf = fs.readFileSync(path.join(OUT, "visible.zip"));
    assert.equal(await decrypt("visible.zip", buf, "nope"), "Wrong password.");
    assert.equal(await page.isHidden("#dec-out"), true);
  },

  async "encrypted inner archive is rebuilt, not reused, for Download all"() {
    const buf = Buffer.from(await page.evaluate(async (pw) => {
      const enc = { password: pw, encryptionStrength: 3 };
      const inner = new zip.ZipWriter(new zip.BlobWriter("application/zip"), enc);
      await inner.add("a.txt", new zip.TextReader("a"));
      await inner.add("b.txt", new zip.TextReader("b"));
      const outer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), enc);
      await outer.add("archive.zip", new zip.BlobReader(await inner.close()));
      return Array.from(new Uint8Array(await (await outer.close()).arrayBuffer()));
    }, PW));
    assert.match(await decrypt("nested.zip", buf, PW), /^Decrypted 2 files/);
    const all = await clickDownload(page.locator("#dec-out button", { hasText: "Download all" }));
    assert.deepEqual((await readZip(all.buf)).map((e) => [e.name, e.encrypted]).sort(), [["a.txt", false], ["b.txt", false]]);
  },

  async "duplicate paths are renamed in the combined ZIP"() {
    const names = await page.evaluate(async () => {
      const b = await buildPlainZip([
        { path: "x/a.txt", blob: new Blob(["1"]) }, { path: "x/a.txt", blob: new Blob(["2"]) },
        { path: "noext", blob: new Blob(["3"]) }, { path: "noext", blob: new Blob(["4"]) },
      ]);
      const r = new zip.ZipReader(new zip.BlobReader(b));
      return (await r.getEntries()).map((e) => e.filename);
    });
    assert.deepEqual(names, ["x/a.txt", "x/a (2).txt", "noext", "noext (2)"]);
  },

  async "Clear everything cancels a Download all in progress"() {
    const buf = fs.readFileSync(path.join(OUT, "visible.zip"));
    await decrypt("visible.zip", buf, PW);
    await page.evaluate(() => {
      const orig = buildPlainZip;
      window.buildPlainZip = async (f) => { await new Promise((r) => setTimeout(r, 1000)); return orig(f); };
    });
    let downloads = 0;
    const count = () => downloads++;
    page.on("download", count);
    await page.click("#dec-out button:has-text('Download all')");
    await page.click("#wipe");
    await page.waitForTimeout(2000);
    page.off("download", count);
    assert.equal(downloads, 0);
    assert.equal(await page.isHidden("#dec-out"), true);
  },

  async "Download all build failure shows an error and re-enables the button"() {
    const buf = fs.readFileSync(path.join(OUT, "visible.zip"));
    await decrypt("visible.zip", buf, PW);
    await page.evaluate(() => { window.buildPlainZip = async () => { throw new Error("boom"); }; });
    const btn = page.locator("#dec-out button", { hasText: "Download all" });
    await btn.click();
    await page.waitForFunction(() => /combined ZIP/.test(document.getElementById("dec-msg").textContent));
    assert.equal(await btn.isDisabled(), false);
  },

  async "Clear everything cancels an encryption in progress"() {
    await page.click("#tab-enc");
    // Large enough that encryption is still running when the wipe happens.
    await setBigFiles("#enc-files", [{ name: "big.bin", mb: 64 }]);
    await page.fill("#enc-pw", PW); await page.fill("#enc-pw2", PW);
    await page.setChecked("#enc-hide", true); await page.setChecked("#enc-compress", true);
    await page.click("#enc-go");
    await page.waitForFunction(() => document.getElementById("enc-msg").textContent === "Encrypting…");
    await page.click("#wipe");
    await page.waitForTimeout(3000);
    assert.equal(await page.isHidden("#enc-out"), true);
    assert.equal(await page.textContent("#enc-msg"), "");
    assert.equal(await page.isHidden("#enc-progress"), true);
    assert.equal(await page.isDisabled("#enc-files"), false);
  },

  async "file list is locked while encrypting"() {
    await page.click("#tab-enc");
    await setBigFiles("#enc-files", [{ name: "big.bin", mb: 64 }, { name: "small.txt", mb: 0 }]);
    await page.fill("#enc-pw", PW); await page.fill("#enc-pw2", PW);
    await page.setChecked("#enc-hide", false); await page.setChecked("#enc-compress", true);
    await page.click("#enc-go");
    await page.waitForFunction(() => document.getElementById("enc-msg").textContent === "Encrypting…");
    assert.equal(await page.isDisabled("#enc-list button >> nth=1"), true);
    assert.equal(await page.isDisabled("#enc-files"), true);
    assert.equal(await page.isDisabled("#enc-go"), true);
    await page.waitForSelector("#enc-out:not([hidden])", { timeout: 60_000 });
    assert.equal(await page.isDisabled("#enc-list button >> nth=1"), false);
    assert.equal(await page.isDisabled("#enc-files"), false);
  },

  async "choosing another ZIP while decrypting cancels the first"() {
    await page.click("#tab-dec");
    await setBigFiles("#dec-file", { name: "big.zip", password: PW, zipOf: [{ name: "big1.bin", mb: 48 }, { name: "big2.bin", mb: 48 }] });
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
    await page.fill("#dec-pw", PW);
    assert.match(await decrypt("second.zip", small, PW), /^Decrypted 2 files/);
    assert.deepEqual((await rowNames()).sort(), ["data.bin", "hello.txt"]);
    const all = await clickDownload(page.locator("#dec-out button", { hasText: "Download all" }));
    assert.equal(all.name, "second-decrypted.zip");
  },

  async "decrypts an AES-256 ZIP made by 7-Zip"() {
    const p = path.join(OUT, "interop.zip");
    if (!fs.existsSync(p)) { console.log("     (skipped: no interop.zip)"); return; }
    assert.match(await decrypt("interop.zip", fs.readFileSync(p), "interop-pw"), /^Decrypted 2 files/);
    assert.deepEqual((await rowNames()).sort(), ["data.bin", "hello.txt"]);
  },
};

(async () => {
  // Give 7-Zip the same input files so CI can compare what it extracts.
  const src = path.join(OUT, "src");
  fs.mkdirSync(src, { recursive: true });
  for (const f of FILES) fs.writeFileSync(path.join(src, f.name), f.buffer);

  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true });
  page = await context.newPage();
  page.on("pageerror", (e) => problems.push("page error: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/boom|Invalid password/.test(m.text())) problems.push("console error: " + m.text()); });
  page.on("request", (r) => { if (!r.url().startsWith(BASE) && !/^(blob|data):/.test(r.url())) problems.push("off-site request: " + r.url()); });
  await page.goto(BASE + "/");
  await page.waitForFunction(() => typeof zip !== "undefined");
  await page.evaluate(() => { window.__buildPlainZip = buildPlainZip; });   // tests patch it; restored after each

  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try { await fn(); console.log("ok   " + name); }
    catch (e) { failed++; console.log("FAIL " + name + "\n     " + (e.stack || e).toString().split("\n").slice(0, 4).join("\n     ")); }
    finally {
      await page.click("#wipe").catch(() => {});
      await page.evaluate(() => { window.buildPlainZip = window.__buildPlainZip; }).catch(() => {});
    }
  }
  // Reload so a fresh page (no test patches) checks that the service worker registers.
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
