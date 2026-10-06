# DMG Live Chat

Your own live chat for **dorianmediagroup.com**. Visitors chat from a bubble on the website, your phone buzzes, and you reply from the **DMG Chat** app. The visitor sees your reply right away.

-   **Website widget**: one `<script>` tag. Works on WordPress or any other site.
-   **Inbox app**: installs on your iPhone or Android home screen and sends push notifications for every new message. Works in a desktop browser too.
-   **Yours**: no monthly per-seat SaaS fees and no third-party branding. Chats are stored in a single SQLite file on your server.

```
 Website visitor                 Chat server (this folder)                 You
┌───────────────┐   websocket   ┌──────────────────────────┐   push    ┌──────────────┐
│ widget.js     │ ────────────▶ │ server.js + chat.db      │ ────────▶ │ DMG Chat app │
│ (chat bubble) │ ◀──────────── │                          │ ◀──────── │ (/admin)     │
└───────────────┘               └──────────────────────────┘ websocket └──────────────┘
```

## Features

-   Real-time messaging with typing indicators and "online now" status
-   Push notifications to your phone (Web Push), with an optional [ntfy](https://ntfy.sh) backup
-   After a visitor's first message, the widget asks for their name and email so you can follow up if they leave
-   Shows which page the visitor is on and where they came from
-   Returning visitors see their chat history, and get an unread badge and a chime when you reply
-   Open/Closed conversations, quick replies, delete
-   Mobile-friendly on both sides, plus dark mode in the inbox

## 1. Deploy the server

The server needs a host that keeps it running all the time and a **persistent disk** for the database. Railway is the easiest:

### Railway (recommended, about $5/month)

1. Push this repo to GitHub (it's already there).
2. At [railway.app](https://railway.app), choose **New Project → Deploy from GitHub repo** and pick this repo.
3. In the service **Settings**, set **Root Directory** to `dmg-live-chat`. Railway detects the `Dockerfile`.
4. Under **Volumes**, add a volume mounted at `/data`.
5. Under **Variables**, add:
    | Variable | Value |
    | ----------------- | ---------------------------------------------------------------------- |
    | `ADMIN_PASSWORD` | a long password you'll use to sign in |
    | `PUBLIC_URL` | `https://chat.dorianmediagroup.com` (or the Railway URL until DNS is set) |
    | `ALLOWED_ORIGINS` | `https://dorianmediagroup.com,https://www.dorianmediagroup.com` |
    | `VAPID_SUBJECT` | `mailto:evan@dorianmediagroup.com` |
6. Under **Networking**, generate a domain, or add the custom domain `chat.dorianmediagroup.com` and create the CNAME record Railway gives you at your DNS provider.

Render, Fly.io, or any VPS work the same way: run the Dockerfile, mount a disk at `/data`, and set the variables above. See `.env.example` for every option.

> Free tiers that sleep when idle (e.g. Render free) aren't suitable. A sleeping server can't receive chats or send notifications.

## 2. Set up your phone

### iPhone (iOS 16.4 or later)

1. Open `https://chat.dorianmediagroup.com/admin/` in **Safari** and sign in.
2. Tap **Share → Add to Home Screen**.
3. Open **DMG Chat** from your home screen, sign in again, and tap **Enable notifications → Allow**.
4. Tap ⚙️ → **Send test** to confirm your phone buzzes.

### Android

Open the same URL in Chrome, sign in, tap **Enable notifications**, then choose **Install app** / **Add to Home screen** from the Chrome menu.

### Desktop

Open the URL in Chrome, Edge or Safari and enable notifications. You can use any number of devices, and all of them get notified.

### Optional: backup notifications through ntfy

For a second, very reliable channel, install the free **ntfy** app (iOS/Android), subscribe to a long random topic name like `dmg-chat-7f3k9q2x`, and set `NTFY_TOPIC` to the same value on the server.

## 3. Add the chat to your website

Paste this just before `</body>` on every page:

```html
<script src="https://chat.dorianmediagroup.com/widget.js" defer></script>
```

**On WordPress:** install the free **WPCode** plugin (or use your theme's "footer scripts" setting), add the snippet to the **Footer**, and save. **Then remove or disable your old chat plugin/script** so you don't get two bubbles.

### Customize it (optional)

```html
<script
    src="https://chat.dorianmediagroup.com/widget.js"
    data-title="Chat with Evan"
    data-subtitle="Dorian Media Group"
    data-greeting="Hey! 👋 Questions about your website or marketing? Message me here."
    data-color="#0f172a"
    data-avatar="https://dorianmediagroup.com/path/to/your-headshot.jpg"
    data-position="right"
    defer
></script>
```

## Run it locally

```bash
cd dmg-live-chat
npm install
ADMIN_PASSWORD=test npm start
```

-   Test website page: http://localhost:3000/demo
-   Inbox: http://localhost:3000/admin/ (password `test`)

`npm test` runs the end-to-end tests.

## How it works

| File                         | What it does                                                               |
| ---------------------------- | -------------------------------------------------------------------------- |
| `server.js`                  | Express + Socket.IO server: login, realtime chat, push endpoints           |
| `db.js`                      | SQLite storage (conversations, messages, push subscriptions)               |
| `notify.js`                  | Sends Web Push notifications (and ntfy, if configured)                     |
| `public/widget.js`           | The chat bubble for your website (self-contained, styles isolated in a shadow DOM) |
| `public/admin/`              | The inbox app (PWA): `app.js`, `sw.js` (notifications), manifest and icons |

**Security notes**

-   The inbox is protected by `ADMIN_PASSWORD`. Sign-ins are rate-limited, and sessions last 90 days per device.
-   Each visitor gets a signed token, so one visitor can never load another visitor's conversation.
-   `ALLOWED_ORIGINS` stops other websites from embedding your widget.
-   Back up `/data/chat.db` if you want to keep chat history long-term.
