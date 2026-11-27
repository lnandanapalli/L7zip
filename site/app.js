/* L7zip — client-side AES-256 ZIP (WinZip AE-2 format) encrypt / decrypt.
 * Nothing is uploaded. Files and passwords stay in this browser tab.
 * Output opens in 7-Zip, WinZip, Keka, The Unarchiver, `7zz x file.zip`, etc.
 *
 * Rules, to keep this small and predictable:
 * - Encrypt takes exactly one file and makes one encrypted ZIP.
 * - Decrypt takes exactly one encrypted ZIP and peels only that one layer: one file inside gives
 *   that file; several give one plain ZIP of them. Archives inside are never opened. */
"use strict";

const INNER_NAME = "archive.zip";   // name of the plain ZIP the file is wrapped in when hiding its name
const $ = (id) => document.getElementById(id);

zip.configure({ useWebWorkers: true });

/* ------------------------------------------------------------ helpers */

function fmtSize(n) {
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
}

const MIME = {
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", heic: "image/heic", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", m4a: "audio/mp4", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", html: "text/html",
};
const mimeOf = (name) => MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
const baseName = (p) => p.split("/").pop();

function setMsg(el, text, kind = "") { el.textContent = text; el.className = "msg" + (kind ? " " + kind : ""); }

// Object URLs stay valid for 10 minutes (iOS may show a "Download?" prompt first),
// and are all revoked by "Clear everything" / closing the page.
const liveUrls = new Set();
function revokeUrl(url) { if (liveUrls.delete(url)) URL.revokeObjectURL(url); }
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  liveUrls.add(url);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => revokeUrl(url), 10 * 60_000);
}

// The single result of an encryption or decryption: name, size and one Download button.
function showResult(out, blob, name) {
  const row = document.createElement("div"); row.className = "row";
  const n = document.createElement("span"); n.className = "name"; n.textContent = name;
  const s = document.createElement("span"); s.className = "size"; s.textContent = fmtSize(blob.size);
  const b = document.createElement("button"); b.type = "button"; b.textContent = "Download";
  b.addEventListener("click", () => download(blob, name));
  row.append(n, s, b);
  out.textContent = ""; out.append(row); out.hidden = false;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const stem = (name) => name.replace(/\.[^.]*$/, "") || name;

/* ------------------------------------------------------------ tabs + misc UI */

for (const [tab, panel] of [["tab-enc", "panel-enc"], ["tab-dec", "panel-dec"]]) {
  $(tab).addEventListener("click", () => {
    for (const [t, p] of [["tab-enc", "panel-enc"], ["tab-dec", "panel-dec"]]) {
      $(t).setAttribute("aria-selected", String(t === tab));
      $(p).hidden = p !== panel;
    }
  });
}

document.querySelectorAll(".eye").forEach((b) => b.addEventListener("click", () => {
  const inp = $(b.dataset.for);
  const show = inp.type === "password";
  inp.type = show ? "text" : "password";
  b.textContent = show ? "Hide" : "Show";
  if (inp.id === "enc-pw") $("enc-pw2").type = inp.type;
}));

/* Rough password strength estimate (bits), shown as a bar. */
function strengthBits(pw) {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(pool || 1);
  if (/^(.)\1+$/.test(pw)) bits = Math.log2(pool) * 2;
  return bits;
}

/* ------------------------------------------------------------ ENCRYPT */

let encFile = null;

// The encryption in progress: bumping encGen tells it its result is no longer wanted,
// and encAbort stops zip.js. While it runs, the chosen file can't be changed.
let encGen = 0, encAbort = null;
const encBusy = () => encAbort !== null;

function cancelEnc() {
  encGen++;
  encAbort?.abort(); encAbort = null;
  $("enc-progress").hidden = true;
  $("enc-file").disabled = false;
}

function setEncFile(f) {
  if (encBusy()) return;
  encFile = f || null;
  $("enc-chosen").textContent = encFile ? `${encFile.name} · ${fmtSize(encFile.size)}` : "";
  $("enc-out").hidden = true; $("enc-out").textContent = "";
  // Suggest an output name from the file, unless the user typed their own.
  const nameBox = $("enc-name");
  if (encFile && (!nameBox.value || nameBox.dataset.auto === "1")) {
    nameBox.value = `${stem(encFile.name)}-${today()}.zip`; nameBox.dataset.auto = "1";
  }
  if (!encFile && nameBox.dataset.auto === "1") nameBox.value = "";
  setMsg($("enc-msg"), "");
  validateEnc();
}

function validateEnc() {
  const pw = $("enc-pw").value, pw2 = $("enc-pw2").value;
  const bits = strengthBits(pw);
  const bar = $("enc-strength").firstElementChild;
  bar.style.width = Math.min(100, bits / 90 * 100) + "%";
  bar.style.background = bits < 45 ? "var(--err)" : bits < 70 ? "var(--warn)" : "var(--ok)";
  $("enc-go").disabled = encBusy() || !encFile || !pw || pw !== pw2;
  if (encBusy()) return;
  if (encFile && pw && pw2 && pw !== pw2) setMsg($("enc-msg"), "Passwords don't match.", "err");
  else if (/[^\x20-\x7e]/.test(pw)) setMsg($("enc-msg"), "Your password has accented letters, emoji or other non-ASCII characters. This site and 7-Zip can open the file, but some ZIP tools handle these characters differently and won't accept the password. For the widest compatibility, use only A–Z, a–z, 0–9 and standard symbols.", "warn");
  else if (pw && bits < 45) setMsg($("enc-msg"), "Weak password. Encrypted ZIPs can be attacked offline, so use 5–6 random words or 14+ mixed characters.", "warn");
  else if ($("enc-msg").classList.contains("err") || $("enc-msg").classList.contains("warn")) setMsg($("enc-msg"), "");
}

$("enc-file").addEventListener("change", (e) => { setEncFile(e.target.files[0]); e.target.value = ""; });
$("enc-name").addEventListener("input", (e) => { e.target.dataset.auto = ""; });
["enc-pw", "enc-pw2"].forEach((id) => $(id).addEventListener("input", validateEnc));

// Drag & drop on desktop: exactly one file.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  const enc = !$("panel-enc").hidden;
  if (files.length > 1) { setMsg($(enc ? "enc-msg" : "dec-msg"), "Drop one file at a time.", "err"); return; }
  if (enc) setEncFile(files[0]); else setDecFile(files[0]);
});

$("enc-go").addEventListener("click", async () => {
  const pw = $("enc-pw").value, file = encFile;
  if (!file || !pw || pw !== $("enc-pw2").value) return;
  let name = ($("enc-name").value.trim() || "encrypted.zip").replace(/[\/\\:]/g, "_");
  if (!/\.zip$/i.test(name)) name += ".zip";
  const wrap = $("enc-hide").checked;
  const level = $("enc-compress").checked ? 6 : 0;

  const gen = ++encGen, ctrl = new AbortController(), signal = ctrl.signal;
  encAbort = ctrl; $("enc-file").disabled = true; validateEnc();
  const prog = $("enc-progress"), out = $("enc-out");
  const setProg = (v) => { if (gen === encGen) prog.value = v; };
  out.hidden = true; out.textContent = "";
  prog.hidden = false; prog.value = 0;
  setMsg($("enc-msg"), "Encrypting…");

  try {
    const lastModDate = new Date(file.lastModified || Date.now());
    const aes = { password: pw, encryptionStrength: 3, zipCrypto: false };
    let blob;
    if (wrap) {
      // Pass 1: plain archive.zip holding the file under its real name.
      const inner = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level });
      await inner.add(file.name, new zip.BlobReader(file),
        { lastModDate, signal, onprogress: (p, t) => setProg(0.5 * p / (t || 1)) });
      const innerBlob = await inner.close();
      // Pass 2: AES-256 ZIP with that one entry (stored; it's already compressed).
      const outer = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { ...aes, level: 0 });
      await outer.add(INNER_NAME, new zip.BlobReader(innerBlob),
        { signal, onprogress: (p, t) => setProg(0.5 + 0.5 * p / (t || 1)) });
      blob = await outer.close();
    } else {
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { ...aes, level });
      await w.add(file.name, new zip.BlobReader(file),
        { lastModDate, signal, onprogress: (p, t) => setProg(p / (t || 1)) });
      blob = await w.close();
    }

    if (gen !== encGen) return;   // "Clear everything" was pressed while encrypting
    setMsg($("enc-msg"), "Done. AES-256. Keep the password safe, because there's no way to recover it.", "ok");
    showResult(out, blob, name);
    $("enc-pw").value = ""; $("enc-pw2").value = "";
  } catch (e) {
    if (gen !== encGen) return;   // cancelled
    console.error(e);
    setMsg($("enc-msg"), "Encryption failed: " + (e.message || e), "err");
  } finally {
    if (gen === encGen) { encAbort = null; prog.hidden = true; $("enc-file").disabled = false; validateEnc(); }
  }
});

/* ------------------------------------------------------------ DECRYPT */

let decFile = null;

// Bumped by every new decryption, by choosing another ZIP and by "Clear everything",
// so a decryption still running for an older choice knows to stop.
let decGen = 0, decAbort = null;

function cancelDec() {
  decGen++;
  decAbort?.abort(); decAbort = null;
  $("dec-progress").hidden = true;
}

function setDecFile(f) {
  cancelDec();   // choosing another ZIP stops any decryption still running
  decFile = f || null;
  $("dec-chosen").textContent = decFile ? `${decFile.name} · ${fmtSize(decFile.size)}` : "";
  $("dec-out").hidden = true; $("dec-out").textContent = "";
  setMsg($("dec-msg"), "");
  validateDec();
}
function validateDec() { $("dec-go").disabled = !decFile || decAbort !== null; }

$("dec-file").addEventListener("change", (e) => { setDecFile(e.target.files[0]); e.target.value = ""; });
$("dec-pw").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("dec-go").disabled) $("dec-go").click(); });

// Entry paths for the plain output ZIP: repeated paths get " (2)", " (3)"… so ZipWriter accepts them.
function uniquePath(used, path) {
  let p = path;
  if (used.has(p)) {
    const slash = path.lastIndexOf("/") + 1, dot = path.lastIndexOf(".");
    const cut = dot > slash ? dot : path.length;
    for (let i = 2; used.has(p); i++) p = path.slice(0, cut) + ` (${i})` + path.slice(cut);
  }
  used.add(p);
  return p;
}

const userError = (msg) => Object.assign(new Error(msg), { user: true });

$("dec-go").addEventListener("click", async () => {
  if (!decFile) return;
  cancelDec();
  const gen = decGen, ctrl = new AbortController(), signal = ctrl.signal, file = decFile;
  decAbort = ctrl;
  const pw = $("dec-pw").value;
  const prog = $("dec-progress"), out = $("dec-out");
  const setProg = (v) => { if (gen === decGen) prog.value = v; };
  out.hidden = true; out.textContent = "";
  $("dec-go").disabled = true; prog.hidden = false; prog.value = 0;
  setMsg($("dec-msg"), "Decrypting…");

  let reader;
  try {
    reader = new zip.ZipReader(new zip.BlobReader(file));
    const entries = (await reader.getEntries()).filter((e) => !e.directory);
    if (!entries.length) throw userError("This ZIP is empty.");
    if (!entries.every((e) => e.encrypted)) throw userError("This ZIP isn't password-protected. L7zip only opens encrypted ZIPs; open this one with your computer or phone.");
    if (!pw) throw userError("Enter the password.");
    const weak = entries.some((e) => e.zipCrypto);

    // Peel this one layer only. Anything inside, including other ZIPs, is passed on as it is.
    const total = entries.reduce((a, e) => a + (e.uncompressedSize || 0), 0) || 1;
    let done = 0;
    const read = (entry) => entry.getData(new zip.BlobWriter(mimeOf(entry.filename)), {
      password: pw, signal, onprogress: (p) => setProg((done + p) / total),
    });

    let blob, name;
    if (entries.length === 1) {
      blob = await read(entries[0]);
      name = baseName(entries[0].filename);
    } else {
      // Several files: one plain ZIP of them, built one file at a time.
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level: 0 });
      const used = new Set();
      for (const entry of entries) {
        const data = await read(entry);
        await w.add(uniquePath(used, entry.filename), new zip.BlobReader(data),
          { signal, lastModDate: entry.lastModDate });
        done += entry.uncompressedSize || 0;
      }
      blob = await w.close();
      name = stem(file.name) + "-decrypted.zip";
    }
    if (gen !== decGen) return;   // cancelled: "Clear everything" or another ZIP chosen

    const what = entries.length === 1 ? "Decrypted." : `Decrypted ${entries.length} files into one ZIP.`;
    setMsg($("dec-msg"), weak ? what + " This ZIP uses the old ZipCrypto encryption, which is weak." : what, weak ? "warn" : "ok");
    showResult(out, blob, name);
    $("dec-pw").value = "";
  } catch (e) {
    if (gen !== decGen) return;   // cancelled
    if (!e.user) console.error(e);
    const m = e.user ? e.message
      : e.message === zip.ERR_INVALID_PASSWORD ? "Wrong password."
      : /signature|central directory|End of central/i.test(e.message || "") ? "This doesn't look like a valid ZIP file."
      : "Decryption failed: " + (e.message || e);
    setMsg($("dec-msg"), m, "err");
  } finally {
    try { await reader?.close(); } catch {}
    if (gen === decGen) { decAbort = null; prog.hidden = true; validateDec(); }
  }
});

/* ------------------------------------------------------------ wipe */

// Drops every reference to selected files, results and passwords so the browser can free them.
// (JavaScript can't zero memory directly; the garbage collector reclaims it.)
function wipeAll() {
  cancelEnc(); cancelDec();
  encFile = null; decFile = null;
  for (const url of [...liveUrls]) revokeUrl(url);
  for (const id of ["enc-pw", "enc-pw2", "dec-pw", "enc-name"]) { $(id).value = ""; $(id).type = id === "enc-name" ? "text" : "password"; }
  $("enc-name").dataset.auto = "";
  document.querySelectorAll(".eye").forEach((b) => (b.textContent = "Show"));
  for (const id of ["enc-out", "dec-out"]) { $(id).textContent = ""; $(id).hidden = true; }
  for (const id of ["enc-msg", "dec-msg"]) setMsg($(id), "");
  for (const id of ["enc-chosen", "dec-chosen"]) $(id).textContent = "";
  validateEnc(); validateDec();
}
$("wipe").addEventListener("click", wipeAll);
// Also wipe when the page is closed, reloaded or navigated away from,
// so nothing is kept in the back/forward cache.
addEventListener("pagehide", wipeAll);
addEventListener("pageshow", (e) => { if (e.persisted) wipeAll(); });

/* ------------------------------------------------------------ offline (service worker) */

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(() => navigator.serviceWorker.ready).then(() => {
    $("offline-state").textContent = "Available offline on this device.";
  }).catch(() => {});
}
