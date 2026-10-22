const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const { Server } = require('socket.io')
const store = require('./db')
const { vapidPublicKey, notifyAdmin } = require('./notify')
const integrations = require('./integrations')

const PORT = Number(process.env.PORT) || 3000
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
const SITE_URL = (process.env.SITE_URL || 'https://dorianmediagroup.com').replace(/\/$/, '')
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || ''
const ADMIN_NAME = process.env.ADMIN_NAME || 'Evan Dorian'
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
const MAX_MESSAGE_LENGTH = 2000
const ADMIN_SESSION_DAYS = 90
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024
const UPLOAD_TYPES = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'application/pdf': 'pdf'
}

// Timings, overridable for testing.
const seconds = (name, fallback) => (process.env[name] !== undefined ? Number(process.env[name]) : fallback) * 1000
const AUTO_REPLY_DELAY = seconds('AUTO_REPLY_SECONDS', 180) // 0 turns it off
const ADMIN_ALERT_DELAY = seconds('ADMIN_ALERT_SECONDS', 300)
const VISITOR_EMAIL_DELAY = seconds('VISITOR_EMAIL_SECONDS', 120)
const MIN_FIRST_MESSAGE_DELAY = seconds('SPAM_MIN_SECONDS', 1.5) // bots send instantly
const AUTO_REPLY_TEXT =
    process.env.AUTO_REPLY_TEXT ||
    "Thanks for your message! I'm finishing up with a client and will reply shortly. If you need to step away, leave your email and I'll follow up there."

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD is not set. Set it in the environment before starting the server.')
    process.exit(1)
}

// Secret used to sign admin and visitor tokens. Persisted so tokens survive restarts.
const SECRET =
    process.env.SESSION_SECRET ||
    store.getSetting('session_secret') ||
    (() => {
        const s = crypto.randomBytes(32).toString('hex')
        store.setSetting('session_secret', s)
        return s
    })()

// When this database was first created, to spot a data folder that resets on deploy.
const DB_CREATED_AT =
    Number(store.getSetting('created_at')) ||
    (() => {
        const now = Date.now()
        store.setSetting('created_at', String(now))
        return now
    })()

const sign = (value) => crypto.createHmac('sha256', SECRET).update(value).digest('base64url')

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest()
    const hb = crypto.createHash('sha256').update(String(b)).digest()
    return crypto.timingSafeEqual(ha, hb)
}

function createAdminToken() {
    const expires = Date.now() + ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000
    return `${expires}.${sign(`admin.${expires}`)}`
}

function verifyAdminToken(token) {
    if (typeof token !== 'string') return false
    const [expires, sig] = token.split('.')
    if (!expires || !sig || Number(expires) < Date.now()) return false
    return safeEqual(sig, sign(`admin.${expires}`))
}

const createVisitorToken = (visitorId) => sign(`visitor.${visitorId}`)
const verifyVisitorToken = (visitorId, token) =>
    typeof visitorId === 'string' && typeof token === 'string' && safeEqual(token, createVisitorToken(visitorId))

function cleanText(value, max = MAX_MESSAGE_LENGTH) {
    if (typeof value !== 'string') return ''
    return value.replace(/\r\n/g, '\n').trim().slice(0, max)
}

const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

function originAllowed(origin) {
    if (!origin || ALLOWED_ORIGINS.length === 0) return true
    return ALLOWED_ORIGINS.includes(origin.replace(/\/$/, '')) || origin === PUBLIC_URL
}

// Simple fixed-window rate limiter keyed by an arbitrary string.
function rateLimiter(limit, windowMs) {
    const hits = new Map()
    setInterval(() => hits.clear(), windowMs).unref()
    return (key) => {
        const n = (hits.get(key) || 0) + 1
        hits.set(key, n)
        return n <= limit
    }
}
const loginLimiter = rateLimiter(10, 15 * 60 * 1000)
const globalLoginLimiter = rateLimiter(100, 15 * 60 * 1000)
const messageLimiter = rateLimiter(20, 60 * 1000)
const newChatLimiter = rateLimiter(5, 60 * 60 * 1000) // new conversations per IP per hour
const uploadLimiter = rateLimiter(10, 60 * 60 * 1000)

// Link that reopens a visitor's chat on the website (used in follow-up emails).
function continueUrl(conversation) {
    let base = SITE_URL
    try {
        const page = new URL(conversation.page_url)
        if (originAllowed(page.origin) && /^https?:$/.test(page.protocol)) base = page.origin + page.pathname
    } catch (e) {}
    return `${base}#dmgchat=${conversation.id}.${createVisitorToken(conversation.id)}`
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express()
// Number of reverse proxies in front of the app (Sevalla/Railway/Render use one).
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1))
app.disable('x-powered-by')

app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/', (req, res) => res.redirect('/admin/'))

app.get('/widget.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.sendFile(path.join(__dirname, 'public', 'widget.js'))
})
// iPhones look for the home-screen icon at the top of the domain too.
const iconFile = path.join(__dirname, 'public', 'admin', 'dmg-chat-180.png')
for (const route of ['/apple-touch-icon.png', '/apple-touch-icon-precomposed.png', '/admin/apple-touch-icon.png', '/admin/apple-touch-icon-precomposed.png']) {
    app.get(route, (req, res) => res.sendFile(iconFile))
}
app.get(['/favicon.ico', '/admin/favicon.ico'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dmg-chat-192.png')))
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), { index: 'index.html' }))
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')))

// Uploaded files. Ids are random and unguessable; only images and PDFs are accepted.
app.get('/files/:id', (req, res) => {
    const upload = /^[a-f0-9]{32}$/.test(req.params.id) && store.getUpload(req.params.id)
    if (!upload) return res.status(404).end()
    res.set({
        'Content-Type': upload.mime_type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Disposition': `${upload.mime_type.startsWith('image/') ? 'inline' : 'attachment'}; filename="${upload.file_name.replace(/[^\w.\- ]/g, '_')}"`
    })
    res.sendFile(path.join(store.UPLOAD_DIR, upload.id))
})

// The widget uploads from your website's origin, so this route needs CORS.
function uploadCors(req, res, next) {
    const origin = req.headers.origin
    if (origin && originAllowed(origin)) {
        res.set({
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type, X-Visitor-Id, X-Visitor-Token, X-File-Name, X-Conversation-Id, Authorization',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin'
        })
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    next()
}
app.options('/api/upload', uploadCors)

app.post('/api/upload', uploadCors, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (!UPLOAD_TYPES[mime]) return res.status(415).json({ error: 'Only images and PDFs can be shared.' })
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty file' })

    let conversationId = null
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '')
    if (verifyAdminToken(bearer)) {
        conversationId = req.headers['x-conversation-id']
    } else if (verifyVisitorToken(req.headers['x-visitor-id'], req.headers['x-visitor-token'])) {
        conversationId = req.headers['x-visitor-id']
        if (store.isBlocked(conversationId, req.ip)) return res.status(403).json({ error: 'Not allowed' })
    } else {
        return res.status(401).json({ error: 'Unauthorized' })
    }
    if (!uploadLimiter(`u:${conversationId}`)) return res.status(429).json({ error: 'Too many uploads. Try again later.' })
    if (!store.getConversation(conversationId)) {
        store.ensureConversation({ id: conversationId, ip: req.ip, userAgent: cleanText(req.headers['user-agent'], 300) })
    }

    const id = crypto.randomBytes(16).toString('hex')
    const fileName = cleanText(decodeURIComponent(String(req.headers['x-file-name'] || 'file')), 120) || 'file'
    fs.writeFileSync(path.join(store.UPLOAD_DIR, id), req.body)
    store.addUpload({ id, conversation_id: conversationId, file_name: fileName, mime_type: mime, size: req.body.length })
    res.json({ id, name: fileName, type: mime, size: req.body.length, url: `${PUBLIC_URL}/files/${id}` })
})

app.use(express.json({ limit: '32kb' }))

app.post('/api/admin/login', (req, res) => {
    if (!loginLimiter(req.ip) || !globalLoginLimiter('all')) {
        return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
    }
    const password = req.body && req.body.password
    if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'Wrong password' })
    }
    res.json({ token: createAdminToken() })
})

function requireAdmin(req, res, next) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '')
    if (!verifyAdminToken(token)) return res.status(401).json({ error: 'Unauthorized' })
    next()
}

app.get('/api/admin/config', requireAdmin, (req, res) =>
    res.json({ ai: integrations.aiEnabled, autoSuggest: AUTO_SUGGEST, email: integrations.emailEnabled, mailerlite: integrations.mailerliteEnabled })
)

app.get('/api/admin/push/public-key', requireAdmin, (req, res) => res.json({ publicKey: vapidPublicKey }))

app.post('/api/admin/push/subscribe', requireAdmin, (req, res) => {
    const sub = req.body
    if (!sub || typeof sub.endpoint !== 'string' || !sub.keys) return res.status(400).json({ error: 'Invalid subscription' })
    store.addPushSubscription(sub)
    res.json({ ok: true })
})

app.post('/api/admin/push/test', requireAdmin, async (req, res) => {
    await notifyAdmin({ title: 'Test notification', body: 'Live chat notifications are working.', url: `${PUBLIC_URL}/admin/` })
    res.json({ ok: true })
})

app.post('/api/admin/suggest', requireAdmin, async (req, res) => {
    const conversation = store.getConversation(req.body && req.body.conversationId)
    if (!conversation) return res.status(404).json({ error: 'Not found' })
    res.json(await integrations.suggestReply(conversation, store.getMessages(conversation.id)))
})

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

const server = http.createServer(app)
const io = new Server(server, {
    cors: {
        origin: (origin, cb) => cb(null, originAllowed(origin)),
        credentials: false
    },
    maxHttpBufferSize: 64 * 1024
})

const admins = io.of('/admin')
const visitors = io.of('/visitor')
const room = (conversationId) => `conv:${conversationId}`

function visitorOnline(conversationId) {
    const r = visitors.adapter.rooms.get(room(conversationId))
    return Boolean(r && r.size > 0)
}

function conversationSummary(id) {
    const c = store.getConversation(id)
    if (!c) return null
    const messages = store.getMessages(id)
    const last = messages[messages.length - 1]
    return {
        ...c,
        last_message: last ? last.body || (last.attachment ? `Sent a file: ${last.attachment.name}` : '') : null,
        last_sender: last ? last.sender : null,
        message_count: messages.length,
        online: visitorOnline(id)
    }
}

function publishMessage(message) {
    visitors.to(room(message.conversation_id)).emit('message', message)
    admins.emit('message', message)
    admins.emit('conversation_updated', conversationSummary(message.conversation_id))
}

// --- Follow-up timers ------------------------------------------------------
// In-memory: a restart drops pending timers, which only means one auto-reply
// or follow-up email might be skipped.

// --- Visitor location ------------------------------------------------------

async function locateVisitor(id, meta) {
    const c = store.getConversation(id)
    if (!c) return
    if (meta.timezone && meta.timezone !== c.timezone) store.setField(id, 'timezone', meta.timezone)
    if (c.location && c.location_ip === meta.ip) return
    const place = meta.headerLocation || (await integrations.lookupLocation(meta.ip))
    if (!place || !store.getConversation(id)) return
    store.setField(id, 'location', place)
    store.setField(id, 'location_ip', meta.ip)
    admins.emit('conversation_updated', conversationSummary(id))
}

// --- AI reply suggestions, refreshed after each visitor message ------------

const AUTO_SUGGEST = integrations.aiEnabled && process.env.AI_AUTO_SUGGEST !== 'off'
const suggestions = new Map() // conversationId -> [option, option]

function setSuggestions(id, options) {
    if (options.length) suggestions.set(id, options)
    else if (!suggestions.delete(id)) return
    admins.emit('suggestions', { conversationId: id, options })
}

function scheduleSuggestions(id) {
    if (!AUTO_SUGGEST) return
    // Short wait so a visitor sending several messages in a row gets one suggestion.
    schedule(`suggest:${id}`, 1500, async () => {
        const c = store.getConversation(id)
        const messages = c ? store.getMessages(id) : []
        const last = messages[messages.length - 1]
        if (!last || last.sender !== 'visitor') return
        const result = await integrations.suggestReply(c, messages)
        if (!result.options) return
        // Drop it if you replied (or they wrote again) while it was being written.
        const latest = store.lastMessageBy(id, 'visitor')
        const lastAdmin = store.lastMessageBy(id, 'admin')
        if (!latest || latest.id !== last.id || (lastAdmin && !lastAdmin.auto && lastAdmin.id > last.id)) return
        setSuggestions(id, result.options)
    })
}

const timers = new Map()
function schedule(key, delay, fn) {
    clearTimeout(timers.get(key))
    if (delay <= 0) return
    const t = setTimeout(() => {
        timers.delete(key)
        Promise.resolve(fn()).catch((err) => console.error(`[timer ${key}]`, err))
    }, delay)
    t.unref()
    timers.set(key, t)
}
const cancel = (key) => {
    clearTimeout(timers.get(key))
    timers.delete(key)
}

// 2. Auto-reply when you haven't answered within a few minutes (once per 12h).
function scheduleAutoReply(id) {
    schedule(`auto:${id}`, AUTO_REPLY_DELAY, () => {
        const c = store.getConversation(id)
        if (!c) return
        const lastVisitor = store.lastMessageBy(id, 'visitor')
        const lastAdmin = store.lastMessageBy(id, 'admin')
        if (!lastVisitor || (lastAdmin && lastAdmin.id > lastVisitor.id)) return
        if (c.auto_replied_at && Date.now() - c.auto_replied_at < 12 * 60 * 60 * 1000) return
        store.setField(id, 'auto_replied_at', Date.now())
        publishMessage(store.addMessage(id, 'admin', AUTO_REPLY_TEXT, { auto: true }))
        scheduleVisitorEmail(id)
    })
}

// 3. Email you if a message is still unread a few minutes after the push.
function scheduleAdminAlert(id) {
    if (!ADMIN_EMAIL) return
    schedule(`alert:${id}`, ADMIN_ALERT_DELAY, async () => {
        const c = store.getConversation(id)
        if (!c || c.admin_unread === 0) return
        if (c.admin_alerted_at && Date.now() - c.admin_alerted_at < 30 * 60 * 1000) return
        const unread = store.getMessages(id).filter((m) => m.sender === 'visitor').slice(-c.admin_unread)
        const who = c.name || c.email || 'A website visitor'
        const sent = await integrations.sendEmail({
            to: ADMIN_EMAIL,
            replyTo: c.email || undefined,
            subject: `Unanswered chat from ${who}`,
            text: `${who} is waiting for a reply on your website chat:\n\n${unread.map((m) => m.body).join('\n')}\n\nReply: ${PUBLIC_URL}/admin/#${id}`,
            html: integrations.emailLayout({
                heading: `${who} is waiting for a reply`,
                bodyHtml:
                    integrations.messagesHtml(unread, ADMIN_NAME).replace(/<strong>You:<\/strong>/g, `<strong>${integrations.escapeHtml(who)}:</strong>`) +
                    (c.page_url ? `<p style="font-size:13px;color:#5b6474">Page: ${integrations.escapeHtml(c.page_url)}</p>` : ''),
                buttonText: 'Reply in DMG Chat',
                buttonUrl: `${PUBLIC_URL}/admin/#${id}`,
                footer: 'You get this when a chat message stays unread for a few minutes.'
            })
        })
        if (sent) store.setField(id, 'admin_alerted_at', Date.now())
    })
}

// 1. Email your replies to visitors who left (or haven't read them).
function scheduleVisitorEmail(id) {
    schedule(`visitor:${id}`, VISITOR_EMAIL_DELAY, async () => {
        const c = store.getConversation(id)
        if (!c || !c.email || c.visitor_unread === 0) return
        const pending = store.getMessagesAfter(id, c.last_emailed_message_id).filter((m) => m.sender === 'admin')
        if (!pending.length) return
        const link = continueUrl(c)
        const firstName = (c.name || '').split(/\s+/)[0]
        const sent = await integrations.sendEmail({
            to: c.email,
            replyTo: ADMIN_EMAIL || undefined,
            subject: `${ADMIN_NAME} replied to your message`,
            text: `${firstName ? `Hi ${firstName},\n\n` : ''}${pending.map((m) => m.body).join('\n\n')}\n\nContinue the chat: ${link}\nOr just reply to this email.\n\n${ADMIN_NAME}\nDorian Media Group`,
            html: integrations.emailLayout({
                heading: `${firstName ? `Hi ${firstName}, ` : ''}${ADMIN_NAME} replied to your message`,
                bodyHtml: integrations.messagesHtml(pending, ADMIN_NAME),
                buttonText: 'Continue the chat',
                buttonUrl: link,
                footer: 'You can also just reply to this email. Dorian Media Group, Newport Beach &amp; Kansas City.'
            })
        })
        if (sent) store.setField(id, 'last_emailed_message_id', pending[pending.length - 1].id)
    })
}

// 8. Add contacts to MailerLite with the page they chatted from.
async function syncMailerLite(id) {
    const c = store.getConversation(id)
    if (!c || !c.email) return
    const result = await integrations.addToMailerLite({ name: c.name, email: c.email, pageUrl: c.page_url })
    if (result.skipped) return
    store.setField(id, 'mailerlite_status', result.ok ? 'added' : 'failed')
    admins.emit('conversation_updated', conversationSummary(id))
}

// --- Visitors (the widget on the website) ---------------------------------

visitors.use((socket, next) => {
    const origin = socket.handshake.headers.origin
    if (!originAllowed(origin)) return next(new Error('origin not allowed'))
    const { visitorId, token } = socket.handshake.auth || {}
    if (visitorId && verifyVisitorToken(visitorId, token)) {
        socket.data.visitorId = visitorId
    } else {
        socket.data.visitorId = crypto.randomUUID()
    }
    socket.data.connectedAt = Date.now()
    next()
})

visitors.on('connection', (socket) => {
    const id = socket.data.visitorId
    const auth = socket.handshake.auth || {}
    const meta = {
        pageUrl: cleanText(auth.pageUrl, 500) || null,
        referrer: cleanText(auth.referrer, 500) || null,
        userAgent: cleanText(socket.handshake.headers['user-agent'], 300),
        ip: (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address,
        timezone: cleanText(auth.timeZone, 60) || null,
        headerLocation: integrations.locationFromHeaders(socket.handshake.headers)
    }
    const blocked = () => store.isBlocked(id, meta.ip)
    socket.join(room(id))

    const conversation = store.getConversation(id)
    if (conversation) {
        store.ensureConversation({ id, ...meta })
        admins.emit('conversation_updated', conversationSummary(id))
    }

    socket.emit('session', {
        visitorId: id,
        token: createVisitorToken(id),
        messages: conversation ? store.getMessages(id) : [],
        contact: conversation ? { name: conversation.name, email: conversation.email } : {},
        unread: conversation ? conversation.visitor_unread : 0
    })

    socket.on('message', async (payload, ack = () => {}) => {
        payload = payload || {}
        const body = cleanText(payload.body)
        const attachment = payload.attachmentId ? store.getUpload(String(payload.attachmentId)) : null
        if (!body && !attachment) return ack({ error: 'Empty message' })
        if (attachment && attachment.conversation_id !== id) return ack({ error: 'Invalid attachment' })

        // 4. Spam: a filled-in honeypot, a blocked sender, or a bot that types instantly
        // gets a normal-looking reply so it doesn't retry, but nothing is stored.
        const isFirst = !store.getConversation(id) || !store.lastMessageBy(id, 'visitor')
        const tooFast = isFirst && Date.now() - socket.data.connectedAt < MIN_FIRST_MESSAGE_DELAY
        if (payload.hp || blocked() || tooFast) return ack({ ok: true, message: { id: 0, body, sender: 'visitor', created_at: Date.now() } })
        if (!messageLimiter(`v:${id}`)) return ack({ error: 'You are sending messages too quickly.' })
        if (isFirst && !newChatLimiter(`ip:${meta.ip}`)) return ack({ error: 'Please try again a little later.' })

        store.ensureConversation({ id, ...meta, pageUrl: cleanText(payload.pageUrl, 500) || meta.pageUrl })
        const message = store.addMessage(id, 'visitor', body, {
            attachment: attachment ? { id: attachment.id, name: attachment.file_name, type: attachment.mime_type, size: attachment.size, url: `${PUBLIC_URL}/files/${attachment.id}` } : null
        })
        ack({ ok: true, message })

        socket.to(room(id)).emit('message', message) // other tabs of the same visitor
        admins.emit('message', message)
        admins.emit('conversation_updated', conversationSummary(id))

        const c = store.getConversation(id)
        const who = c.name || c.email || 'Website visitor'
        const preview = body || `Sent a file: ${attachment.file_name}`
        notifyAdmin({
            title: isFirst ? `New chat: ${who}` : who,
            body: preview.length > 180 ? `${preview.slice(0, 177)}...` : preview,
            url: `${PUBLIC_URL}/admin/#${id}`,
            conversationId: id,
            badge: store.totalUnread()
        }).catch((err) => console.error('[notify]', err))
        scheduleAutoReply(id)
        scheduleAdminAlert(id)
        scheduleSuggestions(id)
        locateVisitor(id, meta).catch((err) => console.error('[geo]', err))
    })

    socket.on('contact', (payload, ack = () => {}) => {
        const name = cleanText(payload && payload.name, 100)
        const email = cleanText(payload && payload.email, 200)
        if (email && !isEmail(email)) return ack({ error: 'Please enter a valid email.' })
        if ((payload && payload.hp) || blocked()) return ack({ ok: true })
        store.ensureConversation({ id, ...meta })
        const before = store.getConversation(id)
        store.updateContact(id, { name, email })
        ack({ ok: true })
        admins.emit('conversation_updated', conversationSummary(id))
        if (email && email !== before.email) syncMailerLite(id).catch((err) => console.error('[mailerlite]', err))
        if (email) scheduleVisitorEmail(id)
    })

    socket.on('typing', (isTyping) => {
        if (store.getConversation(id)) admins.emit('visitor_typing', { conversationId: id, typing: Boolean(isTyping) })
    })

    socket.on('read', () => {
        if (store.getConversation(id)) store.markVisitorRead(id)
    })

    socket.on('disconnect', () => {
        if (!store.getConversation(id)) return
        admins.emit('conversation_updated', conversationSummary(id))
        if (!visitorOnline(id)) scheduleVisitorEmail(id)
    })
})

// --- Admin (you, on your phone or desktop) --------------------------------

admins.use((socket, next) => {
    if (verifyAdminToken(socket.handshake.auth && socket.handshake.auth.token)) return next()
    next(new Error('unauthorized'))
})

admins.on('connection', (socket) => {
    socket.on('list', (status, ack = () => {}) => {
        const rows = store.listConversations(status === 'closed' ? 'closed' : 'open')
        ack(rows.map((c) => ({ ...c, online: visitorOnline(c.id) })))
    })

    socket.on('open', (conversationId, ack = () => {}) => {
        const c = store.getConversation(conversationId)
        if (!c) return ack({ error: 'Not found' })
        store.markAdminRead(conversationId)
        ack({ conversation: conversationSummary(conversationId), messages: store.getMessages(conversationId), suggestions: suggestions.get(conversationId) || [] })
        admins.emit('conversation_updated', conversationSummary(conversationId))
    })

    socket.on('send', (payload, ack = () => {}) => {
        payload = payload || {}
        const conversationId = payload.conversationId
        const body = cleanText(payload.body)
        const upload = payload.attachmentId ? store.getUpload(String(payload.attachmentId)) : null
        if ((!body && !upload) || !store.getConversation(conversationId)) return ack({ error: 'Invalid message' })
        if (upload && upload.conversation_id !== conversationId) return ack({ error: 'Invalid attachment' })
        const message = store.addMessage(conversationId, 'admin', body, {
            attachment: upload ? { id: upload.id, name: upload.file_name, type: upload.mime_type, size: upload.size, url: `${PUBLIC_URL}/files/${upload.id}` } : null
        })
        store.markAdminRead(conversationId)
        cancel(`auto:${conversationId}`)
        cancel(`alert:${conversationId}`)
        cancel(`suggest:${conversationId}`)
        setSuggestions(conversationId, [])
        ack({ ok: true, message })
        publishMessage(message)
        scheduleVisitorEmail(conversationId)
    })

    socket.on('typing', (payload) => {
        if (payload && payload.conversationId) {
            visitors.to(room(payload.conversationId)).emit('admin_typing', Boolean(payload.typing))
        }
    })

    socket.on('read', (conversationId) => {
        if (!store.getConversation(conversationId)) return
        store.markAdminRead(conversationId)
        admins.emit('conversation_updated', conversationSummary(conversationId))
    })

    socket.on('set_status', (payload, ack = () => {}) => {
        const { conversationId, status } = payload || {}
        if (!store.getConversation(conversationId) || !['open', 'closed'].includes(status)) return ack({ error: 'Invalid' })
        store.setStatus(conversationId, status)
        ack({ ok: true })
        admins.emit('conversation_updated', conversationSummary(conversationId))
    })

    // 4. Block a spammer: their visitor id and IP can no longer send messages.
    socket.on('block', (conversationId, ack = () => {}) => {
        const c = store.getConversation(conversationId)
        if (!c) return ack({ error: 'Not found' })
        store.block('visitor', c.id)
        store.block('ip', c.ip)
        store.deleteConversation(c.id)
        suggestions.delete(c.id)
        ack({ ok: true })
        admins.emit('conversation_deleted', c.id)
    })

    socket.on('delete', (conversationId, ack = () => {}) => {
        store.deleteConversation(conversationId)
        suggestions.delete(conversationId)
        ack({ ok: true })
        admins.emit('conversation_deleted', conversationId)
    })
})

server.listen(PORT, () => {
    console.log(`Live chat running on port ${PORT}`)
    console.log(`  Inbox:  ${PUBLIC_URL}/admin/`)
    console.log(`  Embed:  <script src="${PUBLIC_URL}/widget.js" defer></script>`)
    console.log(
        `  Email: ${integrations.emailEnabled ? 'on' : 'off'} · MailerLite: ${integrations.mailerliteEnabled ? 'on' : 'off'} · AI: ${integrations.aiEnabled ? 'on' : 'off'}`
    )
    // If "created" changes on every deploy, the data folder isn't on a persistent disk:
    // chats, your sign-in and phone notifications would all reset on each deploy.
    let mounted = false
    try {
        mounted = fs
            .readFileSync('/proc/mounts', 'utf8')
            .split('\n')
            .some((line) => line.split(' ')[1] === path.resolve(store.DATA_DIR))
    } catch {}
    console.log(
        `  Data:   ${store.DATA_DIR} (${mounted ? 'persistent disk' : 'NOT a mounted disk'}, created ${new Date(DB_CREATED_AT).toISOString()}, ${store.listConversations('open').length + store.listConversations('closed').length} chats)`
    )
})

module.exports = { server }
