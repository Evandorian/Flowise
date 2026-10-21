/* Service worker: shows push notifications for new visitor messages. */

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
    let data = {}
    try {
        data = event.data ? event.data.json() : {}
    } catch (e) {
        data = { title: 'New message', body: event.data ? event.data.text() : '' }
    }
    const tasks = [
        self.registration.showNotification(data.title || 'New chat message', {
            body: data.body || '',
            icon: '/admin/dmg-chat-192.png',
            badge: '/admin/dmg-chat-192.png',
            tag: data.conversationId || 'dmg-chat',
            renotify: true,
            data: { url: data.url || './', conversationId: data.conversationId }
        })
    ]
    if (data.badge && self.navigator.setAppBadge) tasks.push(self.navigator.setAppBadge(data.badge).catch(() => {}))
    event.waitUntil(Promise.all(tasks))
})

self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const { url, conversationId } = event.notification.data || {}
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            const existing = clients.find((c) => c.url.includes('/admin'))
            if (existing) {
                if (conversationId) existing.postMessage({ type: 'open-conversation', conversationId })
                return existing.focus()
            }
            return self.clients.openWindow(url || './')
        })
    )
})
