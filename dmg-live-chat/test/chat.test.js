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

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve))
const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve))

before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmg-chat-'))
    proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT), ADMIN_PASSWORD: PASSWORD, DATA_DIR: dataDir, NTFY_TOPIC: '' },
        stdio: ['ignore', 'pipe', 'inherit']
    })
    await new Promise((resolve) => proc.stdout.on('data', (d) => d.toString().includes('running') && resolve()))
})

after(() => {
    proc.kill()
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
    assert.strictEqual(session.adminOnline, true)

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
