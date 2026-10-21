# DMG Live Chat

Your own live chat for **dorianmediagroup.com**. Visitors chat from a button on the website, your phone buzzes, and you reply from the **DMG Chat** app. The visitor sees your reply right away, or gets it by email if they've left.

```
 Website visitor                 Chat server (this folder)                 You
┌───────────────┐   websocket   ┌──────────────────────────┐   push    ┌──────────────┐
│ widget.js     │ ────────────▶ │ server.js + chat.db      │ ────────▶ │ DMG Chat app │
│ (chat button) │ ◀──────────── │ email · MailerLite · AI  │ ◀──────── │ (/admin)     │
└───────────────┘               └──────────────────────────┘ websocket └──────────────┘
```

## What it does

**On your website**

-   A chat button with your photo and an always-on green dot, on every page except blog posts, the blog page and blog archives. A welcome teaser pops up after 8 seconds, once per visit, except on the Contact and Book a Discovery Call pages.
-   On phones, your Google reviews badge hides while the teaser shows and comes back as soon as it's closed.
-   The chat opens as a panel on desktop and a slide-up sheet on phones (swipe down to close).
-   The welcome message has **Book a Discovery Call** and **Send an Email** buttons. Send an Email is a short form inside the chat.
-   After the first message, it asks for a name and email. Visitors can share photos and PDFs.
-   The chat loads only after the page has finished loading, so it doesn't slow your site down.

**Behind the scenes**

-   Push notification to your phone for every message.
-   **Auto-reply** after 3 minutes without an answer ("I'm finishing up with a client…"), at most once per 12 hours per visitor.
-   **Email backup:** if a message stays unread for 5 minutes, you get an email too.
-   **Replies reach people who left:** if the visitor isn't on the site, your reply is emailed to them with a "Continue the chat" link.
-   **MailerLite:** every email collected is added to the **Website Chat Leads** group, with the page they chatted from (`chat_page`) and the date (`chat_date`).
-   **Spam protection:** invisible bot traps, rate limits, and a **Block** button in your app.
-   **Conversion tracking:** events are sent to Google Tag Manager (see below).

**In the DMG Chat app**

-   A list of conversations with unread counts, and a green dot on visitors who are on your site now.
-   The visitor's email, the page they're on, and their MailerLite status.
-   Quick replies, an **AI suggested reply** button (✦), file sharing, Close / Block / Delete.

## 1. Deploy the server on Sevalla

Sign in to [sevalla.com](https://sevalla.com) with your Kinsta login.

1. **Add application**, connect GitHub, choose `Evandorian/Flowise` and this branch.
2. Build settings: **Build path `dmg-live-chat`**, build with the **Dockerfile**.
3. **Disks / Persistent storage:** add a 10 GB volume mounted at **`/data`**.
4. **Environment variables:** copy them from [`.env.example`](.env.example). The minimum to start is `ADMIN_PASSWORD`, `PUBLIC_URL`, `ALLOWED_ORIGINS`, `VAPID_SUBJECT` and `DATA_DIR=/data`. Add the email, MailerLite and Anthropic keys to turn those features on.
5. **Domains:** add `chat.dorianmediagroup.com`, then create the CNAME record Sevalla shows you (in MyKinsta DNS if your DNS is there).

> Hosts that put apps to sleep when idle won't work: a sleeping server can't receive chats.

The server prints which features are on when it starts, for example `Email: on · MailerLite: on · AI: on`.

## 2. Set up your phone

**iPhone (iOS 16.4+):** open `https://chat.dorianmediagroup.com/admin/` in Safari, sign in, then tap **Share → Add to Home Screen**. Open **DMG Chat** from the home screen, sign in, and tap **Enable notifications**. Use ⚙️ → **Send test** to check.

**Android:** open the same link in Chrome, sign in, tap **Enable notifications**, then **Install app** from the menu.

## 3. Add the chat to your website

In WordPress, go to **Code Snippets → Header & Footer** (WPCode) and paste this in the **Footer**:

```html
<script src="https://chat.dorianmediagroup.com/widget.js" defer></script>
```

**Then remove your old chat** so you don't get two buttons.

Everything has a sensible default. Each of these can be changed with an attribute on the script tag:

| Attribute             | Default                                                         |
| --------------------- | --------------------------------------------------------------- |
| `data-name`           | Evan Dorian                                                     |
| `data-role`           | Founder / Creative Director                                     |
| `data-photo`          | `…/uploads/2026/10/Evan-Dorian.webp`                            |
| `data-greeting`       | Hi, thanks for stopping by! …                                   |
| `data-teaser`         | Have a project in mind? I'm here if you have any questions.     |
| `data-teaser-delay`   | `8` (seconds; `0` turns the teaser off)                         |
| `data-teaser-exclude` | `/contact,/book-a-discovery-call`                               |
| `data-booking-url`    | `https://dorianmediagroup.com/book-a-discovery-call/`           |
| `data-hide-on-teaser` | selectors for the Google reviews badge (only floating elements) |
| `data-hide-on`        | `single-post,blog,archive,category,tag,author,date,search` (no chat on blog posts, the blog page or blog archives) |
| `data-color`          | `#28b0ff`                                                       |

## 4. Conversion tracking (Google Tag Manager)

The widget pushes these events to `dataLayer`, each with `chat_page` (the page path):

| Event                        | When                                                  |
| ---------------------------- | ----------------------------------------------------- |
| `dmg_chat_teaser_shown`      | The welcome teaser appears                            |
| `dmg_chat_teaser_dismissed`  | The visitor closes the teaser                         |
| `dmg_chat_open`              | The chat opens (`chat_open_source`: button / teaser / email_link) |
| `dmg_chat_message_sent`      | A message is sent (`chat_first_message`: true/false)  |
| `dmg_chat_email_captured`    | The visitor leaves their email                        |
| `dmg_chat_book_call_click`   | Book a Discovery Call is clicked                      |
| `dmg_chat_email_click`       | Send an Email is clicked                              |
| `dmg_chat_file_sent`         | A photo or PDF is shared                              |

In GTM, create a **Custom Event** trigger for each event you care about (start with `dmg_chat_email_captured` and `dmg_chat_book_call_click`), attach a **GA4 Event** tag, then mark those as key events in GA4 and import them into Google Ads as conversions.

## Run it locally

```bash
cd dmg-live-chat
npm install
ADMIN_PASSWORD=test npm start
```

-   Test page (with a stand-in reviews badge): http://localhost:3000/demo
-   Inbox: http://localhost:3000/admin/ (password `test`)

`npm test` runs the end-to-end tests.

## Files

| File                | What it does                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `server.js`         | Chat server: realtime messaging, auto-reply, follow-up emails, uploads, spam rules |
| `integrations.js`   | Email (SMTP), MailerLite and AI suggested replies (Claude)                       |
| `notify.js`         | Push notifications (and ntfy, if configured)                                     |
| `db.js`             | SQLite storage                                                                   |
| `public/widget.js`  | The website chat (self-contained; styles isolated from your theme)               |
| `public/admin/`     | The DMG Chat app (installable web app)                                           |

## Security and privacy

-   The app is protected by `ADMIN_PASSWORD`. Sign-ins are rate-limited and sessions last 90 days per device.
-   Each visitor gets a signed token, so nobody can read another visitor's chat. "Continue the chat" links carry that token, so only the person you emailed can reopen the chat.
-   `ALLOWED_ORIGINS` stops other sites from embedding your chat.
-   Only images and PDFs can be shared (10 MB max). They're served from unguessable links with strict security headers.
-   Blocking a visitor blocks their browser and IP address. Use it for spam only: people sharing an office network share an IP.
-   Back up `/data` (the database and shared files) if you want to keep chat history long-term.
