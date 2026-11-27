/* L7zip — client-side AES-256 ZIP (WinZip AE-2 format) encrypt / decrypt.
 * Nothing is uploaded. Files and passwords stay in this browser tab.
 * Output opens in 7-Zip, WinZip, Keka, The Unarchiver, `7zz x file.zip`, etc. */
"use strict";

const INNER_NAME = "archive.zip";   // name of the inner ZIP when "Hide file names" is on
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

// iPhone/iPad (including iPadOS, which reports itself as a Mac with touch). Used to hide the folder picker.
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function button(label, onClick, secondary = false) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; if (secondary) b.className = "secondary";
  b.addEventListener("click", onClick);
  return b;
}

/* Save control: a single Download button. */
function saveButtons(blob, name) {
  return [button("Download", () => download(blob, name))];
}

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

// Folder picking isn't supported on iPhone/iPad; hide the button there.
const testInput = document.createElement("input");
if (!("webkitdirectory" in testInput) || IS_IOS) {
  $("enc-folder-label").hidden = true;
}

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

let encFiles = [];   // { file, path }

function addFiles(list) {
  const taken = new Set(encFiles.map((f) => f.path));
  for (const file of list) {
    let path = (file.webkitRelativePath || file.name).replace(/^\/+/, "");
    if (taken.has(path)) {
      const dot = path.lastIndexOf(".");
      const stem = dot > path.lastIndexOf("/") ? path.slice(0, dot) : path;
      const ext = dot > path.lastIndexOf("/") ? path.slice(dot) : "";
      let i = 2; while (taken.has(`${stem} (${i})${ext}`)) i++;
      path = `${stem} (${i})${ext}`;
    }
    taken.add(path);
    encFiles.push({ file, path });
  }
  if (!$("enc-name").value && encFiles.length) {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const first = encFiles.length === 1 ? baseName(encFiles[0].path).replace(/\.[^.]*$/, "") : "encrypted";
    $("enc-name").value = `${first}-${stamp}.zip`;
  }
  renderEncList();
}

function renderEncList() {
  const ul = $("enc-list"); ul.textContent = "";
  let total = 0;
  encFiles.forEach((f, i) => {
    total += f.file.size;
    const li = document.createElement("li");
    const n = document.createElement("span"); n.className = "name"; n.textContent = f.path;
    const s = document.createElement("span"); s.className = "size"; s.textContent = fmtSize(f.file.size);
    const x = document.createElement("button"); x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Remove " + f.path);
    x.addEventListener("click", () => { encFiles.splice(i, 1); renderEncList(); });
    li.append(n, s, x); ul.append(li);
  });
  $("enc-summary").textContent = encFiles.length ? `${encFiles.length} file${encFiles.length > 1 ? "s" : ""} · ${fmtSize(total)}` : "";
  validateEnc();
}

function validateEnc() {
  const pw = $("enc-pw").value, pw2 = $("enc-pw2").value;
  const bits = strengthBits(pw);
  const bar = $("enc-strength").firstElementChild;
  bar.style.width = Math.min(100, bits / 90 * 100) + "%";
  bar.style.background = bits < 45 ? "var(--err)" : bits < 70 ? "var(--warn)" : "var(--ok)";
  let problem = "";
  if (!encFiles.length) problem = "";
  else if (!pw) problem = "";
  else if (pw2 && pw !== pw2) problem = "Passwords don't match.";
  const ok = encFiles.length > 0 && pw.length > 0 && pw === pw2;
  $("enc-go").disabled = !ok;
  if (problem) setMsg($("enc-msg"), problem, "err");
  else if (/[^\x20-\x7e]/.test(pw)) setMsg($("enc-msg"), "Your password has accented letters, emoji or other non-ASCII characters. This site and 7-Zip can open the file, but some ZIP tools handle these characters differently and won't accept the password. For the widest compatibility, use only A–Z, a–z, 0–9 and standard symbols.", "warn");
  else if (pw && bits < 45) setMsg($("enc-msg"), "Weak password. Encrypted ZIPs can be attacked offline, so use 5–6 random words or 14+ mixed characters.", "warn");
  else if ($("enc-msg").classList.contains("err") || $("enc-msg").classList.contains("warn")) setMsg($("enc-msg"), "");
}

$("enc-files").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
$("enc-folder").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
["enc-pw", "enc-pw2"].forEach((id) => $(id).addEventListener("input", validateEnc));

// Drag & drop on desktop.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault();
  if (!e.dataTransfer?.files?.length) return;
  if (!$("panel-enc").hidden) addFiles(e.dataTransfer.files);
  else setDecFile(e.dataTransfer.files[0]);
});

$("enc-go").addEventListener("click", async () => {
  const pw = $("enc-pw").value;
  if (!pw || pw !== $("enc-pw2").value) return;
  let name = ($("enc-name").value.trim() || "encrypted.zip").replace(/[\/\\:]/g, "_");
  if (!/\.zip$/i.test(name)) name += ".zip";
  const hide = $("enc-hide").checked;
  const level = $("enc-compress").checked ? 6 : 0;

  const prog = $("enc-progress"), out = $("enc-out");
  out.hidden = true; out.textContent = "";
  $("enc-go").disabled = true; prog.hidden = false; prog.value = 0;
  setMsg($("enc-msg"), "Encrypting…");

  const total = encFiles.reduce((a, f) => a + f.file.size, 0) || 1;
  // When hiding names the data is processed twice (inner zip, then encrypted outer zip).
  const passes = hide ? 2 : 1;
  let done = 0;
  const tick = (pass) => (p) => { prog.value = Math.min(1, ((pass * total) + done + p) / (total * passes)); };

  try {
    let blob;
    const entryOpts = (f) => ({ lastModDate: new Date(f.file.lastModified || Date.now()) });

    if (hide) {
      // Pass 1: plain inner ZIP holding the real file names.
      const inner = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level });
      for (const f of encFiles) {
        await inner.add(f.path, new zip.BlobReader(f.file), { ...entryOpts(f), onprogress: tick(0) });
        done += f.file.size;
      }
      const innerBlob = await inner.close();
      // Pass 2: AES-256 outer ZIP with one entry, archive.zip (stored; it's already compressed).
      done = 0;
      const outer = new zip.ZipWriter(new zip.BlobWriter("application/zip"),
        { password: pw, encryptionStrength: 3, zipCrypto: false, level: 0 });
      const scale = total / (innerBlob.size || 1);
      await outer.add(INNER_NAME, new zip.BlobReader(innerBlob),
        { onprogress: (p) => { prog.value = Math.min(1, (total + p * scale) / (total * 2)); } });
      blob = await outer.close();
    } else {
      const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"),
        { password: pw, encryptionStrength: 3, zipCrypto: false, level });
      for (const f of encFiles) {
        await w.add(f.path, new zip.BlobReader(f.file), { ...entryOpts(f), onprogress: tick(0) });
        done += f.file.size;
      }
      blob = await w.close();
    }

    prog.value = 1;
    setMsg($("enc-msg"), `Done: ${name} (${fmtSize(blob.size)}). AES-256. Keep the password safe, because there's no way to recover it.`, "ok");
    const actions = document.createElement("div"); actions.className = "actions";
    actions.append(...saveButtons(blob, name));
    out.append(actions); out.hidden = false;
    $("enc-pw").value = ""; $("enc-pw2").value = ""; validateEnc();
  } catch (e) {
    console.error(e);
    setMsg($("enc-msg"), "Encryption failed: " + (e.message || e), "err");
  } finally {
    prog.hidden = true;
    $("enc-go").disabled = !(encFiles.length && $("enc-pw").value && $("enc-pw").value === $("enc-pw2").value);
  }
});

/* ------------------------------------------------------------ DECRYPT */

let decFile = null;

function setDecFile(f) {
  decFile = f || null;
  $("dec-chosen").textContent = decFile ? `${decFile.name} · ${fmtSize(decFile.size)}` : "";
  $("dec-out").hidden = true; $("dec-out").textContent = "";
  setMsg($("dec-msg"), "");
  validateDec();
}
function validateDec() { $("dec-go").disabled = !decFile; }

$("dec-file").addEventListener("change", (e) => { setDecFile(e.target.files[0]); e.target.value = ""; });
$("dec-pw").addEventListener("keydown", (e) => { if (e.key === "Enter" && !$("dec-go").disabled) $("dec-go").click(); });

async function extractAll(reader, password, onprog) {
  const entries = (await reader.getEntries()).filter((e) => !e.directory);
  const total = entries.reduce((a, e) => a + (e.uncompressedSize || 0), 0) || 1;
  let done = 0;
  const files = [];
  for (const entry of entries) {
    const blob = await entry.getData(new zip.BlobWriter(mimeOf(entry.filename)), {
      password: entry.encrypted ? password : undefined,
      onprogress: (p) => onprog((done + p) / total),
    });
    done += entry.uncompressedSize || 0;
    files.push({ path: entry.filename, blob, encrypted: entry.encrypted, zipCrypto: !!entry.zipCrypto });
  }
  return files;
}

$("dec-go").addEventListener("click", async () => {
  if (!decFile) return;
  const pw = $("dec-pw").value;
  const prog = $("dec-progress"), out = $("dec-out");
  out.hidden = true; out.textContent = "";
  $("dec-go").disabled = true; prog.hidden = false; prog.value = 0;
  setMsg($("dec-msg"), "Decrypting…");

  let reader;
  try {
    reader = new zip.ZipReader(new zip.BlobReader(decFile));
    const entries = await reader.getEntries();
    const anyEncrypted = entries.some((e) => e.encrypted);
    if (anyEncrypted && !pw) throw Object.assign(new Error("This ZIP is encrypted. Enter the password."), { user: true });

    let files = await extractAll(reader, pw, (p) => { prog.value = p * 0.5; });
    let notes = [];
    if (!anyEncrypted) notes.push("This ZIP wasn't encrypted.");
    if (files.some((f) => f.zipCrypto)) notes.push("This ZIP uses the old ZipCrypto encryption, which is weak.");

    // Unwrap the hidden-names inner archive.
    let innerBlob = null;   // plain ZIP of all files (reused for "Download all")
    if (files.length === 1 && files[0].path === INNER_NAME) {
      innerBlob = files[0].blob;
      try {
        const inner = new zip.ZipReader(new zip.BlobReader(innerBlob));
        files = await extractAll(inner, pw, (p) => { prog.value = 0.5 + p * 0.5; });
        await inner.close();
      } catch { innerBlob = null; /* not a zip after all — show as-is */ }
    }
    prog.value = 1;

    const totalSize = files.reduce((a, f) => a + f.blob.size, 0);
    setMsg($("dec-msg"), [`Decrypted ${files.length} file${files.length !== 1 ? "s" : ""} (${fmtSize(totalSize)}).`, ...notes].join(" "),
      notes.length ? "warn" : "ok");

    // "Download all" saves one regular (unencrypted) ZIP: a single download works on every
    // browser including iPhone Safari, keeps folder structure, and iOS Files / macOS open it natively.
    if (files.length > 1) {
      const allName = decFile.name.replace(/\.zip$/i, "") + "-decrypted.zip";
      const actions = document.createElement("div"); actions.className = "actions";
      const btn = button("Download all (.zip)", async () => {
        if (!innerBlob) {
          btn.disabled = true;
          const w = new zip.ZipWriter(new zip.BlobWriter("application/zip"), { level: 0 });
          for (const f of files) await w.add(f.path, new zip.BlobReader(f.blob));
          innerBlob = await w.close();
          btn.disabled = false;
        }
        download(innerBlob, allName);
      });
      actions.append(btn); out.append(actions);
    }

    for (const f of files) {
      const row = document.createElement("div"); row.className = "row";
      const n = document.createElement("span"); n.className = "name"; n.textContent = f.path;
      const s = document.createElement("span"); s.className = "size"; s.textContent = fmtSize(f.blob.size);
      row.append(n, s, ...saveButtons(f.blob, baseName(f.path)));
      out.append(row);
    }
    out.hidden = false;
    $("dec-pw").value = "";
  } catch (e) {
    console.error(e);
    const m = e.user ? e.message
      : e.message === zip.ERR_INVALID_PASSWORD ? "Wrong password."
      : /signature|central directory|End of central/i.test(e.message || "") ? "This doesn't look like a valid ZIP file."
      : "Decryption failed: " + (e.message || e);
    setMsg($("dec-msg"), m, "err");
  } finally {
    try { await reader?.close(); } catch {}
    prog.hidden = true; validateDec();
  }
});

/* ------------------------------------------------------------ wipe */

// Drops every reference to selected files, results and passwords so the browser can free them.
// (JavaScript can't zero memory directly; the garbage collector reclaims it.)
function wipeAll() {
  encFiles = []; decFile = null;
  for (const url of [...liveUrls]) revokeUrl(url);
  for (const id of ["enc-pw", "enc-pw2", "dec-pw", "enc-name"]) { $(id).value = ""; $(id).type = id === "enc-name" ? "text" : "password"; }
  document.querySelectorAll(".eye").forEach((b) => (b.textContent = "Show"));
  for (const id of ["enc-out", "dec-out"]) { $(id).textContent = ""; $(id).hidden = true; }
  for (const id of ["enc-msg", "dec-msg"]) setMsg($(id), "");
  $("dec-chosen").textContent = "";
  renderEncList(); validateDec();
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
