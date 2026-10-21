const { test, before, after } = require('node:test')
const assert = require('node:assert')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { io } = require('socket.io-client')

const PORT = 3900 + Math.floor(Math.random() * 90)
const BASE = `http://localhost:${PORT}`
const PASSWORD = 'test-password'
let proc
let dataDir
let geoServer
const sentEmails = []

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve))
const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve))

before(async () => {
    // Stand-in for the IP location service and Resend's email API.
    geoServer = require('http').createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.method === 'POST' && req.url === '/emails') {
            let body = ''
            req.on('data', (d) => (body += d))
            req.on('end', () => {
                sentEmails.push({ auth: req.headers.authorization, ...JSON.parse(body) })
                res.end('{"id":"test"}')
            })
            return
        }
        res.end(JSON.stringify({ success: true, city: 'Kansas City', region: 'Missouri', country: 'United States', country_code: 'US', ip: req.url.slice(1) }))
    })
    await new Promise((resolve) => geoServer.listen(0, resolve))
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-chat-'))
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(PORT),
            ADMIN_PASSWORD: PASSWORD,
            DATA_DIR: dataDir,
            NTFY_TOPIC: '',
            SPAM_MIN_SECONDS: '0',
            AUTO_REPLY_SECONDS: '1',
            GEO_LOOKUP_URL: `http://localhost:${geoServer.address().port}/{ip}`,
            RESEND_API_KEY: 're_test',
            RESEND_API_URL: `http://localhost:${geoServer.address().port}/emails`,
            MAIL_FROM: 'Evan <chat@example.com>',
            ADMIN_EMAIL: 'owner@example.com',
            ADMIN_ALERT_SECONDS: '1',
            SMTP_HOST: ''
        },
        stdio: ['ignore', 'pipe', 'inherit']
    })
    await new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve()))
})

after(() => {
    proc.kill()
    geoServer.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
})

async function login(password) {
    const res = await fetch(`${BASE}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    })
    return { status: res.status, body: await res.json() }
}

test('rejects a wrong password', async () => {
    const res = await login('nope')
    assert.strictEqual(res.status, 401)
})

test('rejects admin sockets without a valid token', async () => {
    const socket = io(`${BASE}/admin`, { auth: { token: '123.bad' }, reconnection: false })
    const err = await once(socket, 'connect_error')
    assert.strictEqual(err.message, 'unauthorized')
    socket.close()
})

test('visitor and admin can chat in real time', async () => {
    const { body } = await login(PASSWORD)
    assert.ok(body.token)

    const admin = io(`${BASE}/admin`, { auth: { token: body.token } })
    await once(admin, 'connect')

    const visitor = io(`${BASE}/visitor`, { auth: { pageUrl: 'https://dorianmediagroup.com/seo' } })
    const session = await once(visitor, 'session')
    assert.ok(session.visitorId && session.token)
    assert.strictEqual(session.messages.length, 0)

    // Visitor -> admin
    const adminGotMessage = once(admin, 'message')
    const ack = await emit(visitor, 'message', { body: 'Hi, do you do SEO?' })
    assert.ok(ack.ok)
    const incoming = await adminGotMessage
    assert.strictEqual(incoming.body, 'Hi, do you do SEO?')
    assert.strictEqual(incoming.conversation_id, session.visitorId)

    // Contact details
    assert.deepStrictEqual(await emit(visitor, 'contact', { name: 'Sam', email: 'bad' }), { error: 'Please enter a valid email.' })
    assert.ok((await emit(visitor, 'contact', { name: 'Sam', email: 'sam@example.com' })).ok)

    const list = await emit(admin, 'list', 'open')
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0].name, 'Sam')
    assert.strictEqual(list[0].admin_unread, 1)
    assert.strictEqual(list[0].page_url, 'https://dorianmediagroup.com/seo')

    // Admin -> visitor
    const opened = await emit(admin, 'open', session.visitorId)
    assert.strictEqual(opened.messages.length, 1)
    const visitorGotReply = once(visitor, 'message')
    assert.ok((await emit(admin, 'send', { conversationId: session.visitorId, body: 'Yes! What site is it for?' })).ok)
    const reply = await visitorGotReply
    assert.strictEqual(reply.sender, 'admin')
    assert.strictEqual(reply.body, 'Yes! What site is it for?')
    visitor.close()

    // Returning visitor (same browser) gets their history back
    const returning = io(`${BASE}/visitor`, { auth: { visitorId: session.visitorId, token: session.token } })
    const resumed = await once(returning, 'session')
    assert.strictEqual(resumed.visitorId, session.visitorId)
    assert.strictEqual(resumed.messages.length, 2)
    assert.strictEqual(resumed.contact.email, 'sam@example.com')
    returning.close()

    // A forged visitor id does not get someone else's conversation
    const forged = io(`${BASE}/visitor`, { auth: { visitorId: session.visitorId, token: 'forged' } })
    const fresh = await once(forged, 'session')
    assert.notStrictEqual(fresh.visitorId, session.visitorId)
    assert.strictEqual(fresh.messages.length, 0)
    forged.close()

    // Visitors who never send anything do not clutter the inbox
    assert.strictEqual((await emit(admin, 'list', 'open')).length, 1)

    // Close and delete
    assert.ok((await emit(admin, 'set_status', { conversationId: session.visitorId, status: 'closed' })).ok)
    assert.strictEqual((await emit(admin, 'list', 'open')).length, 0)
    assert.strictEqual((await emit(admin, 'list', 'closed')).length, 1)
    assert.ok((await emit(admin, 'delete', session.visitorId)).ok)
    assert.strictEqual((await emit(admin, 'list', 'closed')).length, 0)
    admin.close()
})

test('serves the widget, inbox app and push key', async () => {
    const widget = await fetch(`${BASE}/widget.js`)
    assert.strictEqual(widget.status, 200)
    const inbox = await fetch(`${BASE}/admin/`)
    assert.match(await inbox.text(), /DMG Chat/)
    const unauth = await fetch(`${BASE}/api/admin/push/public-key`)
    assert.strictEqual(unauth.status, 401)
    const { body } = await login(PASSWORD)
    const key = await fetch(`${BASE}/api/admin/push/public-key`, { headers: { Authorization: `Bearer ${body.token}` } })
    assert.ok((await key.json()).publicKey)
})

test('auto-reply is sent when nobody answers, only once', async () => {
    const visitor = io(`${BASE}/visitor`, { auth: { pageUrl: 'http://localhost/x' } })
    await once(visitor, 'session')
    await emit(visitor, 'message', { body: 'Anyone there?' })
    const auto = await once(visitor, 'message')
    assert.strictEqual(auto.sender, 'admin')
    assert.strictEqual(auto.auto, true)
    await emit(visitor, 'message', { body: 'Hello?' })
    const extra = await Promise.race([once(visitor, 'message').then(() => 'got'), new Promise((r) => setTimeout(() => r('none'), 1500))])
    assert.strictEqual(extra, 'none')
    visitor.close()
})

test('visitors and admin can share files', async () => {
    const visitor = io(`${BASE}/visitor`)
    const s = await once(visitor, 'session')
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ab0000000049454e44ae426082', 'hex')

    const bad = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })
    assert.strictEqual(bad.status, 401)
    const svg = await fetch(`${BASE}/api/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/svg+xml', 'X-Visitor-Id': s.visitorId, 'X-Visitor-Token': s.token },
        body: '<svg></svg>'
    })
    assert.strictEqual(svg.status, 415)

    const res = await fetch(`${BASE}/api/upload`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Visitor-Id': s.visitorId, 'X-Visitor-Token': s.token, 'X-File-Name': 'logo.png' },
        body: png
    })
    assert.strictEqual(res.status, 200)
    const up = await res.json()
    const ack = await emit(visitor, 'message', { body: '', attachmentId: up.id })
    assert.strictEqual(ack.message.attachment.name, 'logo.png')
    const file = await fetch(`${BASE}/files/${up.id}`)
    assert.strictEqual(file.headers.get('content-type'), 'image/png')
    assert.strictEqual(Buffer.from(await file.arrayBuffer()).length, png.length)
    visitor.close()
})

test("shows the visitor's location and time zone", async () => {
    const { body } = await login(PASSWORD)
    const admin = io(`${BASE}/admin`, { auth: { token: body.token } })
    await once(admin, 'connect')
    const visitor = io(`${BASE}/visitor`, {
        auth: { pageUrl: 'https://dorianmediagroup.com/', timeZone: 'America/Chicago' },
        extraHeaders: { 'x-forwarded-for': '203.0.113.7' }
    })
    const session = await once(visitor, 'session')
    const located = new Promise((resolve) =>
        admin.on('conversation_updated', (c) => c && c.id === session.visitorId && c.location && resolve(c))
    )
    assert.ok((await emit(visitor, 'message', { body: 'Hello from KC' })).ok)
    const c = await located
    assert.strictEqual(c.location, 'Kansas City, Missouri')
    assert.strictEqual(c.timezone, 'America/Chicago')
    visitor.close()
    admin.close()
})

test('emails you through Resend when a chat goes unanswered', async () => {
    const visitor = io(`${BASE}/visitor`, { auth: {}, extraHeaders: { 'x-forwarded-for': '198.51.100.9' } })
    const session = await once(visitor, 'session')
    assert.ok((await emit(visitor, 'message', { body: 'Anyone there?' })).ok)
    let mail
    for (let i = 0; i < 40 && !mail; i++) {
        await new Promise((r) => setTimeout(r, 100))
        mail = sentEmails.find((m) => m.to[0] === 'owner@example.com' && m.text.includes(session.visitorId))
    }
    assert.ok(mail, 'alert email was sent')
    assert.strictEqual(mail.auth, 'Bearer re_test')
    assert.strictEqual(mail.from, 'Evan <chat@example.com>')
    assert.match(mail.text, /Anyone there\?/)
    visitor.close()
})

test('spam: honeypot and blocked visitors are ignored', async () => {
    const { body } = await login(PASSWORD)
    const admin = io(`${BASE}/admin`, { auth: { token: body.token } })
    await once(admin, 'connect')
    const before = (await emit(admin, 'list', 'open')).length

    const bot = io(`${BASE}/visitor`)
    await once(bot, 'session')
    assert.ok((await emit(bot, 'message', { body: 'buy cheap pills', hp: 'http://spam' })).ok)
    assert.strictEqual((await emit(admin, 'list', 'open')).length, before)
    bot.close()

    const spammer = io(`${BASE}/visitor`)
    const s = await once(spammer, 'session')
    await emit(spammer, 'message', { body: 'spam 1' })
    assert.strictEqual((await emit(admin, 'list', 'open')).length, before + 1)
    assert.ok((await emit(admin, 'block', s.visitorId)).ok)
    assert.ok((await emit(spammer, 'message', { body: 'spam 2' })).ok)
    assert.strictEqual((await emit(admin, 'list', 'open')).length, before)
    spammer.close()
    admin.close()
})
