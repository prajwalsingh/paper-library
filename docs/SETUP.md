# Connecting the extension to Google Drive

This is a one-time setup and takes about 10 minutes. You only need a Google account.

## Why is this needed?

Google lets an app read and change your Drive files only after you give it
permission through Google sign-in (OAuth). To do that, Google needs to know
*which app* is asking, so every app has an **OAuth client ID**.

Paper Library is open source and has no company behind it, so each user creates
their own client ID in their own (free) Google Cloud project. The upside is that
the "app" Google sees belongs to you: nobody else's server is involved, and
Google doesn't need to review anything.

> **Which Google account?** Do the Cloud setup with any account you like. You
> sign in to the extension with the account whose **Drive** holds your papers.
> They can be the same account.

## 1. Create a Google Cloud project

1. Open <https://console.cloud.google.com/>.
2. Use the project picker at the top → **New project**. Use any name, e.g. `Paper Library`, then **Create**, and make sure it's selected.

## 2. Enable the Google Drive API

**APIs & Services → Library** → search for **Google Drive API** → **Enable**.

## 3. Configure the consent screen

Open **Google Auth Platform** (older consoles call it **OAuth consent screen**) → **Get started**.

1. **App information:** app name `Paper Library`, and your email as the support email.
2. **Audience:**
   - **Internal**: only available if your account belongs to a Google Workspace organisation (a university or company). This is the best choice there: no test-user list and no "unverified app" warning, but only accounts from that organisation can sign in.
   - **External**: for personal Gmail accounts. Then open **Audience → Test users → Add users** and add every Google account that will sign in to the extension, including your own. Up to 100 test users are allowed.
3. **Contact information:** your email. Agree to the policy and click **Create**.
4. **Data access → Add or remove scopes:** filter for `drive`, tick
   `https://www.googleapis.com/auth/drive` (*See, edit, create and delete all of your Google Drive files*) → **Update** → **Save**.

> Why full Drive access? The extension has to read and overwrite PDFs that it
> didn't create itself, and create the library folders. The narrower `drive.file`
> scope only covers files the app created.

## 4. Create the OAuth client

**Google Auth Platform → Clients → Create client**:

1. **Application type:** **Web application**.
   (Not "Chrome extension". We use Chrome's browser sign-in window, which lets you pick any Google account.)
2. **Name:** anything, e.g. `Chrome extension`.
3. **Authorized redirect URIs → Add URI:** paste the address shown on the
   extension's setup page. For the unpacked extension from this repository, it's always
   ```
   https://hadmfffnocpeglonjioajbpdfbkbjekf.chromiumapp.org/
   ```
   Keep the trailing `/`.
4. Click **Create** and copy the **Client ID**, which ends in `.apps.googleusercontent.com`.
   You don't need the client secret.

It can take a few minutes before a new client works.

## 5. Connect the extension

1. Click the extension's toolbar icon. The setup page opens.
2. Paste the client ID → **Save** → **Sign in with Google**.
3. Pick the account whose Drive has your papers and allow access.
   - For an **External** project, Google first shows *"Google hasn't verified this app"*. Click **Continue**. That's expected, because the app is your own project.

The library opens, and a **Paper Library** folder is created in your My Drive.

## Keep your client ID for next time

**Save the client ID somewhere private**, such as a password manager or a private note.
You need it again whenever you set up Paper Library on another computer or browser profile:

1. Install the extension there ([README → Install](../README.md#install)).
2. Click the toolbar icon, paste **the same client ID**, and sign in.

That's all. The extension ID, and therefore the redirect URI, is identical on every
computer, so the OAuth client you already created works as is. If you sign in with a
*different* Google account and your project is **External**, first add that account as a
**Test user** (step 3).

**Don't publish it.** Keep the client ID out of public repositories, issues,
screenshots and chats. A client ID isn't a password (it can't open your Drive by
itself, and only your test users can sign in), but it identifies *your* Google Cloud
project. Keeping it private stops others from reusing your project or using up its
limits. If it does leak, delete the client in **Google Auth Platform → Clients**,
create a new one (step 4), and paste the new ID into the extension.

## Sharing with friends or lab mates

You can either:
- let everyone create their own client ID by following this guide (most private and independent), **or**
- share **your** client ID with up to 100 people: add each person's Google account as a **Test user** in step 3. They paste your client ID in step 5.
  Their files still go only to their own Drive; your project just identifies the app.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Error 400: redirect_uri_mismatch` | The redirect URI in step 4 doesn't match the one on the setup page exactly. Check the extension ID and the trailing `/`. |
| `Access blocked: … has not completed the Google verification process` | The account isn't a **Test user** (step 3, External). Add it, or use Internal. |
| `Access blocked: … admin` or "This app is blocked" | Your organisation blocks unverified third-party apps. Create the project inside the organisation with **Internal** audience, or ask IT to trust the client ID. |
| `Error 403: access_denied` after sign-in | The Drive scope wasn't granted. Sign in again and tick the Drive permission. |
| Sign-in window closes and nothing happens | The client is still propagating. Wait a few minutes. Also check that the **Drive API** is enabled (step 2). |
| Wrong Google account | Library → ⚙ **Settings** → **Sign out**, then sign in again. |
| Want to use a different client ID | Library → ⚙ **Settings** → **Change OAuth client ID**. |
