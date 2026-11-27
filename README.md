# L7zip

A client-side web app that encrypts and decrypts **AES-256 ZIP** files (the standard WinZip AE-2 format). It runs entirely in the browser and can be added to the iPhone home screen. The server only hosts static files; it never receives your files or your password.

Files made with L7zip open without this site in:
- **Mac:** built in: double-click the file and enter the password (Archive Utility, macOS 11 Big Sur or later). Keka, BetterZip, The Unarchiver and `7zz x file.zip` also work.
- **Windows:** 7-Zip, WinZip, WinRAR
- **iPhone/iPad:** this site, or apps like Zip Opener or iZip
- **Linux:** `7z x file.zip`

**Hide file names** (on by default): standard AES ZIPs encrypt file contents but not file names. With this option, your files go into a plain inner `archive.zip`, which is then encrypted, so the names are hidden too. In other tools you enter the password, get `archive.zip`, and open that.

**Open an unencrypted ZIP inside** (decrypt, on by default): if the decrypted result is a single ZIP with nothing password-protected in it, such as the hide-names wrapper, L7zip shows the files inside it. It opens only that one extra level and never tries the password on it, so an encrypted ZIP inside is given to you as it is. Turn it off to always get just the outer layer.

To make one from the Mac command line (equivalent, without hidden names):
```bash
7zz a -tzip -mem=AES256 -p secret.zip files/
```

## Deploy to Azure Web App (Linux, custom container)

```bash
# 1. Build and push (replace <acr> with your Azure Container Registry name)
az acr build -r <acr> -t l7zip:1 .

# 2. Create the web app on a Linux App Service plan
az webapp create -g <resource-group> -p <plan-name> -n <app-name> \
  --deployment-container-image-name <acr>.azurecr.io/l7zip:1
az webapp config appsettings set -g <resource-group> -n <app-name> --settings WEBSITES_PORT=80
az webapp update -g <resource-group> -n <app-name> --https-only true
```
(If the app can't pull from ACR, enable managed identity with AcrPull, or use `az webapp config container set` with registry credentials.) If you use Docker Hub or GHCR instead, just `docker build` and `docker push`, and point the web app at that image.

### Custom domain (optional)
1. At your DNS provider, add:
   - `CNAME  <subdomain>        →  <app-name>.azurewebsites.net`
   - `TXT    asuid.<subdomain>  →  <verification id>` (get it with `az webapp show -g <resource-group> -n <app-name> --query customDomainVerificationId -o tsv`)
2. Bind the domain and a free App Service managed certificate:
   ```bash
   az webapp config hostname add -g <resource-group> --webapp-name <app-name> --hostname <your-domain>
   az webapp config ssl create -g <resource-group> -n <app-name> --hostname <your-domain>
   az webapp config ssl bind -g <resource-group> -n <app-name> --ssl-type SNI \
     --certificate-thumbprint $(az webapp config ssl show -g <resource-group> --certificate-name <your-domain> --query thumbprint -o tsv)
   ```

Then open your site:
- **iPhone:** in Safari, tap Share → **Add to Home Screen**.
- **Mac:** in Safari, choose File → **Add to Dock**, or just bookmark it.

After the first visit, the app works offline.

## Updating
Rebuild and redeploy. Nothing needs bumping: when a device is online, the app always loads the latest files from the server, and it only uses its saved offline copy when the server can't be reached.

## Tests
GitHub Actions (`.github/workflows/ci.yml`) runs on every pull request and push to `main`. It builds the image, checks the nginx config, checks status codes, content types and security headers (`tests/check-server.sh`), runs browser tests of encrypt/decrypt in Chromium (`tests/e2e.cjs`), and confirms 7-Zip opens the ZIPs the app makes and that the app opens ZIPs 7-Zip makes.

Run them locally against a running container:
```
docker build -t l7zip . && docker run -d --rm -p 8080:80 l7zip
bash tests/check-server.sh
npm install --no-save --no-package-lock playwright && npx playwright install chromium
node tests/e2e.cjs
```

## Security notes
- The crypto is AES-256 (WinZip AE-2) with HMAC-SHA1 authentication, using the browser's Web Crypto API through zip.js (bundled in `site/vendor/`, no CDN).
- **Use ASCII-only passwords** (A–Z, a–z, 0–9, standard symbols). 7-Zip can read ZIPs with accented or emoji passwords but refuses to create them, and some other tools encode such passwords differently. The app warns you if you type one.
- The ZIP AES format fixes its key derivation at PBKDF2-SHA1 with 1,000 iterations, which is weak against password guessing. The password is what protects you: use **5–6 random words** or 14+ random characters.
- A strict Content-Security-Policy is set both in nginx and in the page itself. The page can't load scripts from anywhere else or send data out.
- Trust boundary: whoever controls the server could ship altered JavaScript. Keep the Azure account secured with MFA.
- Large files: everything is processed in memory. A few hundred MB is fine on iPhone; multi-GB files may run out of memory in Safari.

## Files
```
Dockerfile              nginx:alpine image, serves site/ on port 80
nginx.conf              static hosting, per-location CSP
security-headers.conf   shared security headers
site/index.html         UI
site/app.js             encrypt/decrypt logic
site/sw.js              offline cache
site/vendor/            zip.js 2.25.0 (BSD-3-Clause)
tests/                  server checks and browser end-to-end tests (CI)
```
