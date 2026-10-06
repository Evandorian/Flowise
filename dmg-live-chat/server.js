const http = require('http')
const path = require('path')
const crypto = require('crypto')
const express = require('express')
const { Server } = require('socket.io')
const store = require('./db')
const { vapidPublicKey, notifyAdmin } = require('./notify')

const PORT = Number(process.env.PORT) || 3000
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
const MAX_MESSAGE_LENGTH = 2000
const ADMIN_SESSION_DAYS = 90

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


// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express()
// Number of reverse proxies in front of the app (Railway/Render/Fly use one).
app.set('trust proxy', Number(process.env.TRUST_PROXY || 1))
app.disable('x-powered-by')
app.use(express.json({ limit: '32kb' }))

app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/', (req, res) => res.redirect('/admin/'))

app.get('/widget.js', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300')
    res.sendFile(path.join(__dirname, 'public', 'widget.js'))
})
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin'), { index: 'index.html' }))
app.get('/demo', (req, res) => res.sendFile(path.join(__dirname, 'public', 'demo.html')))

app.post('/api/admin/login', (req, res) => {
    if (!loginLimiter(req.ip) || !globalLoginLimiter('all')) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
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

function adminOnline() {
    return admins.sockets.size > 0
}

function visitorOnline(conversationId) {
    const r = visitors.adapter.rooms.get(room(conversationId))
    return Boolean(r && r.size > 0)
}

function conversationSummary(id) {
    const c = store.getConversation(id)
    if (!c) return null
    const messages = store.getMessages(id)
    const last = messages[messages.length - 1]
    return { ...c, last_message: last ? last.body : null, message_count: messages.length, online: visitorOnline(id) }
}

function broadcastAdminStatus() {
    visitors.emit('admin_status', { online: adminOnline() })
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
        socket.data.isNew = true
    }
    next()
})

visitors.on('connection', (socket) => {
    const id = socket.data.visitorId
    const auth = socket.handshake.auth || {}
    const meta = {
        pageUrl: cleanText(auth.pageUrl, 500) || null,
        referrer: cleanText(auth.referrer, 500) || null,
        userAgent: cleanText(socket.handshake.headers['user-agent'], 300),
        ip: (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() || socket.handshake.address
    }
    socket.join(room(id))

    let conversation = store.getConversation(id)
    if (conversation) {
        store.ensureConversation({ id, ...meta })
        admins.emit('conversation_updated', conversationSummary(id))
    }

    socket.emit('session', {
        visitorId: id,
        token: createVisitorToken(id),
        messages: conversation ? store.getMessages(id) : [],
        contact: conversation ? { name: conversation.name, email: conversation.email } : {},
        unread: conversation ? conversation.visitor_unread : 0,
        adminOnline: adminOnline()
    })

    socket.on('message', async (payload, ack = () => {}) => {
        const body = cleanText(payload && payload.body)
        if (!body) return ack({ error: 'Empty message' })
        if (!messageLimiter(`v:${id}`)) return ack({ error: 'You are sending messages too quickly.' })

        const isFirst = !store.getConversation(id)
        store.ensureConversation({ id, ...meta, pageUrl: cleanText(payload.pageUrl, 500) || meta.pageUrl })
        const message = store.addMessage(id, 'visitor', body)
        ack({ ok: true, message })

        socket.to(room(id)).emit('message', message) // other tabs of the same visitor
        admins.emit('message', message)
        admins.emit('conversation_updated', conversationSummary(id))

        const c = store.getConversation(id)
        const who = c.name || c.email || 'Website visitor'
        notifyAdmin({
            title: isFirst ? `New chat: ${who}` : who,
            body: body.length > 180 ? `${body.slice(0, 177)}...` : body,
            url: `${PUBLIC_URL}/admin/#${id}`,
            conversationId: id,
            badge: store.totalUnread()
        }).catch((err) => console.error('[notify]', err))
    })

    socket.on('contact', (payload, ack = () => {}) => {
        const name = cleanText(payload && payload.name, 100)
        const email = cleanText(payload && payload.email, 200)
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return ack({ error: 'Please enter a valid email.' })
        store.ensureConversation({ id, ...meta })
        store.updateContact(id, { name, email })
        ack({ ok: true })
        admins.emit('conversation_updated', conversationSummary(id))
    })

    socket.on('typing', (isTyping) => {
        admins.emit('visitor_typing', { conversationId: id, typing: Boolean(isTyping) })
    })

    socket.on('read', () => {
        if (store.getConversation(id)) store.markVisitorRead(id)
    })

    socket.on('disconnect', () => {
        if (store.getConversation(id)) admins.emit('conversation_updated', conversationSummary(id))
    })
})

// --- Admin (you, on your phone or desktop) --------------------------------

admins.use((socket, next) => {
    if (verifyAdminToken(socket.handshake.auth && socket.handshake.auth.token)) return next()
    next(new Error('unauthorized'))
})

admins.on('connection', (socket) => {
    broadcastAdminStatus()

    socket.on('list', (status, ack = () => {}) => {
        const rows = store.listConversations(status === 'closed' ? 'closed' : 'open')
        ack(rows.map((c) => ({ ...c, online: visitorOnline(c.id) })))
    })

    socket.on('open', (conversationId, ack = () => {}) => {
        const c = store.getConversation(conversationId)
        if (!c) return ack({ error: 'Not found' })
        store.markAdminRead(conversationId)
        ack({ conversation: conversationSummary(conversationId), messages: store.getMessages(conversationId) })
        admins.emit('conversation_updated', conversationSummary(conversationId))
    })

    socket.on('send', (payload, ack = () => {}) => {
        const conversationId = payload && payload.conversationId
        const body = cleanText(payload && payload.body)
        if (!body || !store.getConversation(conversationId)) return ack({ error: 'Invalid message' })
        const message = store.addMessage(conversationId, 'admin', body)
        store.markAdminRead(conversationId)
        ack({ ok: true, message })
        visitors.to(room(conversationId)).emit('message', message)
        admins.emit('message', message)
        admins.emit('conversation_updated', conversationSummary(conversationId))
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

    socket.on('delete', (conversationId, ack = () => {}) => {
        store.deleteConversation(conversationId)
        ack({ ok: true })
        admins.emit('conversation_deleted', conversationId)
    })

    socket.on('disconnect', broadcastAdminStatus)
})

server.listen(PORT, () => {
    console.log(`Live chat running on port ${PORT}`)
    console.log(`  Inbox:  ${PUBLIC_URL}/admin/`)
    console.log(`  Embed:  <script src="${PUBLIC_URL}/widget.js" defer></script>`)
})

module.exports = { server }
