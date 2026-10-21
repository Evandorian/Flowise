const webpush = require('web-push')
const store = require('./db')

// VAPID keys identify this server to the browser push services. They can be
// supplied via env; otherwise they are generated once and kept in the database
// so existing phone subscriptions stay valid across restarts.
function loadVapidKeys() {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
    }
    const saved = store.getSetting('vapid_keys')
    if (saved) return JSON.parse(saved)
    const keys = webpush.generateVAPIDKeys()
    store.setSetting('vapid_keys', JSON.stringify(keys))
    return keys
}

const vapidKeys = loadVapidKeys()
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey)

async function sendWebPush(payload) {
    const subs = store.listPushSubscriptions()
    await Promise.all(
        subs.map(async (sub) => {
            try {
                await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60, urgency: 'high' })
            } catch (err) {
                // 404/410: the phone unsubscribed or the app was removed. 400/403 with a key
                // mismatch: it was made for an old server key and can never work. The app
                // re-subscribes the next time it opens.
                const stale =
                    err.statusCode === 404 ||
                    err.statusCode === 410 ||
                    ((err.statusCode === 400 || err.statusCode === 403) && /VapidPkHashMismatch/i.test(err.body || ''))
                if (stale) {
                    store.deletePushSubscription(sub.endpoint)
                    console.error('[push] removed a stale subscription:', err.statusCode, err.body || '')
                } else console.error('[push] failed:', err.statusCode || '', err.body || err.message)
            }
        })
    )
}

// Optional backup channel: https://ntfy.sh (free app for iOS/Android).
async function sendNtfy(payload) {
    const topic = process.env.NTFY_TOPIC
    if (!topic) return
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh'
    const headers = { 'Content-Type': 'application/json' }
    if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`
    const body = { topic, title: payload.title, message: payload.body, priority: 4, tags: ['speech_balloon'] }
    if (payload.url) body.click = payload.url
    try {
        await fetch(server.replace(/\/$/, ''), { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (err) {
        console.error('[ntfy] failed:', err.message)
    }
}

async function notifyAdmin(payload) {
    await Promise.all([sendWebPush(payload), sendNtfy(payload)])
}

module.exports = { vapidPublicKey: vapidKeys.publicKey, notifyAdmin }
