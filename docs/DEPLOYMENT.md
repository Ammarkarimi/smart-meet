# Deploying Smart Meet

Smart Meet is a browser extension with no backend, so deploying it means three things:

1. **Publishing the privacy policy** at a public URL (GitHub Pages). Both stores require one.
2. **Building the store package** (`dist/smart-meet-<version>.zip`). A GitHub release is created automatically when you push a version tag.
3. **Submitting that zip** to the Chrome Web Store and Microsoft Edge Add-ons, where it goes through review.

There is no server to host, no database and no secrets to manage. Users bring their own AI API keys.

## Before you start

| You need | Notes |
| --- | --- |
| Node.js 20 or later | Only for running tests and building the zip. The project has no npm dependencies. |
| Chrome Web Store developer account | One-time US$5 registration fee. Two-step verification must be on for the Google account. |
| Microsoft Partner Center account | Free. Needed for the Edge Add-ons store. |
| A contact email | Shown on both store listings and used for review messages. |

## 1. Publish the privacy policy (one time)

1. Open the repository on GitHub, then go to **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**, the branch to **main** and the folder to **/ (root)**. Click **Save**.
3. Wait one or two minutes, then check that these pages load:
   - Home page: `https://ammarkarimi.github.io/smart-meet/`
   - Privacy policy: `https://ammarkarimi.github.io/smart-meet/PRIVACY.html`

`_config.yml` limits the site to the README, privacy policy and changelog. The privacy policy URL goes in both store listings.

## 2. Prepare a release

Run these steps for every release, including the first one.

1. **Set the version.** Put the same version in both `manifest.json` and `package.json`. `npm run check` fails if they differ. Each store upload needs a higher version than the last one.
2. **Update `CHANGELOG.md`** with a `## <version> – <date>` section. The release workflow uses that section as the release notes.
3. **Test and build:**

   ```bash
   npm run verify   # unit tests + manifest/file validation
   npm run build    # writes dist/smart-meet-<version>.zip
   ```

4. **Test by hand.** Load the extension unpacked (`chrome://extensions` → Developer mode → Load unpacked → this folder) and go through the *Manual test checklist* in the [README](../README.md#manual-test-checklist-before-a-release) with a real meeting and a real API key.
5. **Commit, tag and push:**

   ```bash
   git commit -am "Release 1.0.0"
   git tag v1.0.0
   git push origin main v1.0.0
   ```

   The **Release** workflow (`.github/workflows/release.yml`) checks that the tag matches the manifest version, runs the tests, builds the zip and attaches it to a new release under **Releases** on GitHub. Download that zip for the store uploads, or use your local `dist/` copy, which is identical.

## 3. Submit to the Chrome Web Store

The text and images for the listing are in [`STORE_LISTING.md`](STORE_LISTING.md) and [`docs/store/`](store/).

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and sign in.
2. **First time only:** accept the developer agreement, pay the registration fee, and fill in **Account**. That means the publisher name, a verified contact email and, if required in your country, trader details.
3. Click **New item** and upload `smart-meet-<version>.zip`.
4. **Store listing** tab:
   - Description, category and language: copy them from `STORE_LISTING.md`.
   - Store icon (128×128): `assets/icons/icon128.png`.
   - Screenshots (1280×800): `docs/store/screenshot-1-live.png` to `screenshot-5-settings.png`, in that order.
   - Small promo tile (440×280): `docs/store/promo-small-440x280.png`.
   - Homepage URL: `https://github.com/Ammarkarimi/smart-meet`.
   - Support URL: `https://github.com/Ammarkarimi/smart-meet/issues`.
5. **Privacy** tab:
   - Single purpose: copy it from `STORE_LISTING.md`.
   - Permission justifications: one per permission, from the table in `STORE_LISTING.md`.
   - Remote code: **No, I am not using remote code**.
   - Data usage: tick the categories listed under *Data usage disclosures* and the three certifications.
   - Privacy policy URL: `https://ammarkarimi.github.io/smart-meet/PRIVACY.html`.
6. **Distribution** tab: set visibility to **Public** (or **Unlisted** for a soft launch), and choose regions.
7. Click **Submit for review**. You can tick *Publish automatically after review*, or publish manually once it's approved.

Review usually takes from a few days up to a few weeks. Expect it to take longer the first time, because the extension asks for `tabCapture` and access to several hosts. If the extension is rejected, the email names the policy involved. Fix the problem, raise the version, then upload and resubmit.

## 4. Submit to Microsoft Edge Add-ons

The same zip works without changes.

1. Go to [Partner Center → Microsoft Edge](https://partner.microsoft.com/dashboard/microsoftedge/overview). The first time, register as an Edge developer (free).
2. Click **Create new extension** and upload `smart-meet-<version>.zip`.
3. **Availability:** Public, and the markets you want.
4. **Properties:**
   - Category: Productivity.
   - Privacy policy URL: `https://ammarkarimi.github.io/smart-meet/PRIVACY.html`.
   - Website: `https://github.com/Ammarkarimi/smart-meet`.
   - Support contact: `https://github.com/Ammarkarimi/smart-meet/issues`.
5. **Store listings** (English):
   - Description: copy it from `STORE_LISTING.md`.
   - Extension logo: `docs/store/logo-300.png`.
   - Screenshots: the same five images.
   - Small promotional tile: `docs/store/promo-small-440x280.png` (optional).
6. Click **Publish**. In the *Notes for certification* box, tell testers they need their own API key from any listed provider, and that caption mode is free to test on Google Meet with captions turned on.

Edge review usually takes up to 7 business days.

## 5. After approval

- Add the store links to the top of `README.md`. Users can then install with one click.
- Reply to store reviews and GitHub issues. The support URL points to the issues page.

## Shipping an update

1. Raise the version in `manifest.json` and `package.json`, and add a `CHANGELOG.md` entry.
2. Run `npm run verify` and go through the manual checklist.
3. Commit, tag `v<version>` and push. The Release workflow builds the zip.
4. **Chrome:** Developer Dashboard → your item → **Package** → **Upload new package** → **Submit for review**.
5. **Edge:** Partner Center → your extension → **Update** → upload the new package → **Publish**.

Installed copies update automatically within a few hours of approval.

If you add a permission or host permission, Chrome disables the extension for existing users until they accept the new permission. Add permissions only when you have to, and update `PRIVACY.md` and `STORE_LISTING.md` to match.

**Rollback:** the stores never accept a lower version. To undo a bad release, publish a higher version that contains the previous code. In an emergency, you can unpublish the item from the dashboard.

## Installing without a store (testing or internal use)

- Download the zip from GitHub **Releases** and unzip it.
- Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, click **Load unpacked** and select the unzipped folder.

Chrome shows a developer-mode reminder, and installs like this don't update automatically. For company-wide deployment, admins can force-install the store version through Chrome or Edge enterprise policy (`ExtensionInstallForcelist`).
