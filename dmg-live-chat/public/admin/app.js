/* DMG Chat inbox: runs in the browser / as an installed app on your phone. */
;(function () {
    const TOKEN_KEY = 'dmg_admin_token'
    const QUICK_KEY = 'dmg_quick_replies'
    const DEFAULT_QUICK = [
        "Hey! Thanks for reaching out, I'm here. What can I help with?",
        "Great question. What's the best email to send details to?",
        'Want to hop on a quick call? Grab a time here: https://dorianmediagroup.com/book-a-discovery-call/',
        "I'm stepping away for a bit but will get back to you shortly!"
    ].join('\n')

    const $ = (id) => document.getElementById(id)
    const state = {
        token: localStorage.getItem(TOKEN_KEY),
        socket: null,
        status: 'open',
        conversations: new Map(),
        currentId: null,
        typing: new Set(),
        suggestions: new Map(), // conversationId -> AI reply options
        suggesting: new Set(), // conversations with suggestions being written
        autoSuggest: false,
        lastStamp: 0
    }

    // ---------------------------------------------------------------- utils

    const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g
    function renderText(el, text) {
        let last = 0
        text.replace(URL_RE, (match, _u, idx) => {
            if (idx > last) el.append(text.slice(last, idx))
            const a = document.createElement('a')
            a.href = match
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
            a.textContent = match
            el.append(a)
            last = idx + match.length
        })
        if (last < text.length) el.append(text.slice(last))
    }

    function relTime(ts) {
        const diff = Date.now() - ts
        if (diff < 60e3) return 'now'
        if (diff < 3600e3) return Math.floor(diff / 60e3) + 'm'
        const d = new Date(ts)
        if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        if (diff < 6 * 86400e3) return d.toLocaleDateString([], { weekday: 'short' })
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
    }

    function fullTime(ts) {
        return new Date(ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    }

    function displayName(c) {
        return c.name || c.email || 'Visitor ' + c.id.slice(0, 4).toUpperCase()
    }

    // The visitor's own clock, e.g. "3:42 PM their time".
    function localTime(timeZone) {
        if (!timeZone) return ''
        try {
            return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone }) + ' their time'
        } catch (e) {
            return ''
        }
    }

    function shortUrl(u) {
        try {
            const url = new URL(u)
            return url.hostname.replace(/^www\./, '') + (url.pathname === '/' ? '' : url.pathname)
        } catch (e) {
            return u
        }
    }

    function api(path, body) {
        return fetch(path, {
            method: body === undefined ? 'GET' : 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.token },
            body: body === undefined ? undefined : JSON.stringify(body)
        }).then((r) => {
            if (r.status === 401) logout()
            return r.json()
        })
    }

    function ping() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)()
            const o = ctx.createOscillator()
            const g = ctx.createGain()
            o.frequency.value = 988
            g.gain.setValueAtTime(0.0001, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02)
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3)
            o.connect(g)
            g.connect(ctx.destination)
            o.start()
            o.stop(ctx.currentTime + 0.35)
        } catch (e) {}
    }

    function updateBadge() {
        let total = 0
        state.conversations.forEach((c) => (total += c.admin_unread || 0))
        document.title = total ? `(${total}) DMG Chat` : 'DMG Chat'
        if ('setAppBadge' in navigator) {
            ;(total ? navigator.setAppBadge(total) : navigator.clearAppBadge()).catch(() => {})
        }
    }

    // ---------------------------------------------------------------- auth

    function showLogin() {
        $('app').hidden = true
        $('login').hidden = false
        $('password').focus()
    }

    function logout() {
        localStorage.removeItem(TOKEN_KEY)
        state.token = null
        if (state.socket) state.socket.disconnect()
        state.socket = null
        $('settings').close()
        showLogin()
    }

    $('login-form').addEventListener('submit', async (e) => {
        e.preventDefault()
        $('login-error').textContent = ''
        const res = await fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: $('password').value })
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
            $('login-error').textContent = data.error || 'Sign in failed'
            return
        }
        state.token = data.token
        localStorage.setItem(TOKEN_KEY, data.token)
        $('password').value = ''
        start()
    })

    // ---------------------------------------------------------------- list

    function renderList() {
        const list = $('list')
        list.innerHTML = ''
        const rows = [...state.conversations.values()]
            .filter((c) => c.status === state.status && c.message_count > 0)
            .sort((a, b) => b.last_message_at - a.last_message_at)
        $('empty').hidden = rows.length > 0
        for (const c of rows) {
            const li = document.createElement('li')
            if (c.admin_unread) li.classList.add('unread')
            if (c.id === state.currentId) li.classList.add('active')
            const name = displayName(c)
            li.innerHTML = `
                <div class="av"></div>
                <div class="li-body">
                    <div class="li-top"><span class="li-name"></span><span class="li-time"></span></div>
                    <div class="li-last"></div>
                </div>`
            li.querySelector('.av').textContent = name.charAt(0).toUpperCase()
            if (c.online) li.querySelector('.av').insertAdjacentHTML('beforeend', '<span class="dot" title="On site now"></span>')
            li.querySelector('.li-name').textContent = name
            if (c.admin_unread) {
                const pill = document.createElement('span')
                pill.className = 'unread-pill'
                pill.textContent = c.admin_unread
                li.querySelector('.li-name').append(pill)
            }
            li.querySelector('.li-time').textContent = relTime(c.last_message_at)
            if (c.location) {
                const loc = document.createElement('div')
                loc.className = 'li-loc'
                loc.textContent = c.location
                li.querySelector('.li-top').after(loc)
            }
            li.querySelector('.li-last').textContent = state.typing.has(c.id)
                ? 'typing…'
                : (c.last_sender === 'admin' ? 'You: ' : '') + (c.last_message || '')
            if (state.typing.has(c.id)) li.querySelector('.li-last').classList.add('is-typing')
            li.addEventListener('click', () => openConversation(c.id))
            list.append(li)
        }
        updateBadge()
    }

    function loadList() {
        state.socket.emit('list', state.status, (rows) => {
            // Keep conversations of the other tab so unread counts stay accurate.
            for (const [id, c] of state.conversations) if (c.status === state.status) state.conversations.delete(id)
            rows.forEach((c) => state.conversations.set(c.id, c))
            renderList()
        })
    }

    document.querySelectorAll('.tabs button').forEach((btn) =>
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn))
            state.status = btn.dataset.status
            loadList()
        })
    )

    // ---------------------------------------------------------------- thread

    // "..." bubble while the visitor is typing. Hides itself if the stop signal is lost.
    const typingTimers = new Map()
    function setVisitorTyping(conversationId, typing) {
        clearTimeout(typingTimers.get(conversationId))
        if (typing) {
            state.typing.add(conversationId)
            typingTimers.set(conversationId, setTimeout(() => setVisitorTyping(conversationId, false), 8000))
        } else state.typing.delete(conversationId)
        if (conversationId === state.currentId) renderTypingBubble()
        renderList()
    }

    function renderTypingBubble() {
        const box = $('messages')
        let bubble = box.querySelector('.typing-bubble')
        const show = state.typing.has(state.currentId)
        if (!show) return bubble && bubble.remove()
        if (!bubble) {
            bubble = document.createElement('div')
            bubble.className = 'msg visitor typing-bubble'
            bubble.setAttribute('aria-label', 'Visitor is typing')
            bubble.innerHTML = '<span></span><span></span><span></span>'
        }
        box.append(bubble) // keep it last
        box.scrollTop = box.scrollHeight
    }

    function addMessage(m) {
        const box = $('messages')
        if (m.created_at - state.lastStamp > 15 * 60e3) {
            const s = document.createElement('div')
            s.className = 'stamp'
            s.textContent = fullTime(m.created_at)
            box.append(s)
        }
        state.lastStamp = m.created_at
        const el = document.createElement('div')
        el.className = 'msg ' + (m.sender === 'admin' ? 'admin' : 'visitor')
        el.title = fullTime(m.created_at)
        if (m.attachment) {
            const a = document.createElement('a')
            a.href = m.attachment.url
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
            if (/^image\//.test(m.attachment.type)) {
                const img = document.createElement('img')
                img.src = m.attachment.url
                img.alt = m.attachment.name
                img.onload = () => (box.scrollTop = box.scrollHeight)
                a.append(img)
            } else {
                a.textContent = 'File: ' + m.attachment.name
            }
            el.append(a)
        }
        if (m.body) renderText(el, m.body)
        if (m.auto) {
            const tag = document.createElement('span')
            tag.className = 'auto'
            tag.textContent = 'Sent automatically'
            el.append(tag)
        }
        box.append(el)
        renderTypingBubble()
        box.scrollTop = box.scrollHeight
    }

    function renderThreadHeader(c) {
        $('t-name').textContent = displayName(c)
        $('t-meta').textContent = c.online ? 'On your site now' : 'Last message ' + relTime(c.last_message_at)
        $('t-status').textContent = c.status === 'open' ? 'Close' : 'Reopen'
        const info = $('t-info')
        info.innerHTML = ''
        const parts = []
        if (c.location || c.timezone) {
            const where = document.createElement('span')
            where.className = 'where'
            where.textContent = [c.location, localTime(c.timezone)].filter(Boolean).join(' · ')
            parts.push(where)
        }
        if (c.email) {
            const a = document.createElement('a')
            a.href = 'mailto:' + c.email
            a.textContent = c.email
            parts.push(a)
        }
        if (c.page_url) {
            const a = document.createElement('a')
            a.href = c.page_url
            a.target = '_blank'
            a.rel = 'noopener'
            a.textContent = shortUrl(c.page_url)
            parts.push(a)
        }
        if (c.referrer) parts.push('from ' + shortUrl(c.referrer))
        parts.forEach((p, i) => {
            if (i) info.append(' · ')
            info.append(p)
        })
        info.hidden = parts.length === 0
        const ml = $('t-ml')
        ml.hidden = !c.mailerlite_status
        ml.className = 'ml ' + (c.mailerlite_status === 'added' ? 'ok' : 'bad')
        ml.textContent =
            c.mailerlite_status === 'added' ? '✓ Added to MailerLite: Website Chat Leads' : 'Could not add to MailerLite. Check the API key in your server settings.'
    }

    function openConversation(id, { fromHash = false } = {}) {
        state.socket.emit('open', id, (res) => {
            if (res.error) return
            state.currentId = id
            if (!fromHash && location.hash !== '#' + id) history.pushState(null, '', '#' + id)
            state.conversations.set(id, res.conversation)
            $('no-thread').hidden = true
            $('thread-view').hidden = false
            $('app').classList.add('in-thread')
            renderThreadHeader(res.conversation)
            $('messages').innerHTML = ''
            state.lastStamp = 0
            res.messages.forEach(addMessage)
            if (res.suggestions && res.suggestions.length) state.suggestions.set(id, res.suggestions)
            else state.suggestions.delete(id)
            renderQuick()
            renderList()
            if (window.innerWidth > 760) $('reply').focus()
        })
    }

    function closeThread() {
        state.currentId = null
        $('app').classList.remove('in-thread')
        $('thread-view').hidden = true
        $('no-thread').hidden = false
        renderList()
    }

    $('back').addEventListener('click', () => {
        if (location.hash) history.pushState(null, '', location.pathname)
        closeThread()
    })

    window.addEventListener('popstate', () => {
        const id = location.hash.slice(1)
        if (id) openConversation(id, { fromHash: true })
        else closeThread()
    })

    $('t-status').addEventListener('click', () => {
        const c = state.conversations.get(state.currentId)
        if (!c) return
        state.socket.emit('set_status', { conversationId: c.id, status: c.status === 'open' ? 'closed' : 'open' }, () => {})
    })

    $('t-delete').addEventListener('click', () => {
        if (!state.currentId || !confirm('Delete this conversation permanently?')) return
        state.socket.emit('delete', state.currentId, () => {})
    })

    $('t-block').addEventListener('click', () => {
        if (!state.currentId || !confirm('Block this visitor? Their messages will be ignored and this chat will be deleted.')) return
        state.socket.emit('block', state.currentId, () => {})
    })

    // ---------------------------------------------------------------- attachments

    $('attach').addEventListener('click', () => $('file').click())
    $('file').addEventListener('change', async () => {
        const file = $('file').files[0]
        $('file').value = ''
        if (!file || !state.currentId) return
        if (file.size > 10 * 1024 * 1024) return alert('Files can be up to 10 MB.')
        const conversationId = state.currentId
        $('attach').disabled = true
        try {
            const res = await fetch('/api/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    Authorization: 'Bearer ' + state.token,
                    'X-Conversation-Id': conversationId,
                    'X-File-Name': encodeURIComponent(file.name)
                },
                body: file
            })
            const up = await res.json()
            if (!res.ok) throw new Error(up.error || 'Upload failed')
            state.socket.emit('send', { conversationId, body: '', attachmentId: up.id }, () => {})
        } catch (err) {
            alert(err.message)
        } finally {
            $('attach').disabled = false
        }
    })

    // ---------------------------------------------------------------- AI suggestions

    $('suggest').addEventListener('click', async () => {
        if (!state.currentId) return
        const btn = $('suggest')
        btn.disabled = true
        const before = reply.placeholder
        reply.placeholder = 'Writing a suggestion…'
        try {
            const data = await api('/api/admin/suggest', { conversationId: state.currentId })
            if (data.error) alert(data.error)
            else {
                reply.value = data.text
                reply.dispatchEvent(new Event('input'))
                reply.focus()
            }
        } finally {
            btn.disabled = false
            reply.placeholder = before
        }
    })

    const reply = $('reply')
    reply.addEventListener('input', () => {
        reply.style.height = 'auto'
        reply.style.height = Math.min(reply.scrollHeight, 140) + 'px'
        sendTyping()
    })
    reply.addEventListener('keydown', (e) => {
        // Enter sends on desktop; on phones Enter inserts a newline and you tap Send.
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(pointer: fine)').matches) {
            e.preventDefault()
            $('composer').requestSubmit()
        }
    })

    let typingTimer = null
    let typingOn = false
    let typingSentAt = 0
    function sendTyping() {
        if (!state.currentId) return
        // Re-send every few seconds so the visitor keeps seeing the bubble during long replies.
        if (!typingOn || Date.now() - typingSentAt > 3000) {
            typingOn = true
            typingSentAt = Date.now()
            state.socket.emit('typing', { conversationId: state.currentId, typing: true })
        }
        clearTimeout(typingTimer)
        typingTimer = setTimeout(stopTyping, 2500)
    }
    function stopTyping() {
        clearTimeout(typingTimer)
        if (typingOn && state.currentId) state.socket.emit('typing', { conversationId: state.currentId, typing: false })
        typingOn = false
    }

    $('composer').addEventListener('submit', (e) => {
        e.preventDefault()
        const body = reply.value.trim()
        if (!body || !state.currentId) return
        stopTyping()
        state.suggestions.delete(state.currentId)
        state.suggesting.delete(state.currentId)
        renderQuick()
        state.socket.timeout(10000).emit('send', { conversationId: state.currentId, body }, (err, res) => {
            if (err || res.error) return alert('Message failed to send. Check your connection.')
        })
        reply.value = ''
        reply.style.height = 'auto'
        reply.focus()
    })

    // ---------------------------------------------------------------- quick replies

    function quickReplies() {
        return (localStorage.getItem(QUICK_KEY) ?? DEFAULT_QUICK)
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
    }

    function renderQuick() {
        const box = $('quick')
        box.innerHTML = ''
        const ai = state.suggestions.get(state.currentId) || []
        if (state.suggesting.has(state.currentId) && !ai.length) {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = 'ai pending'
            b.disabled = true
            b.textContent = '✦ Writing suggestions…'
            box.append(b)
        }
        ai.forEach((text) => {
            const b = document.createElement('button')
            b.type = 'button'
            b.className = 'ai'
            b.title = text
            b.textContent = '✦ ' + text
            // Tap to put it in the reply box so you can edit before sending.
            b.addEventListener('click', () => {
                reply.value = text
                reply.dispatchEvent(new Event('input'))
                reply.focus()
            })
            box.append(b)
        })
        box.scrollLeft = 0
        quickReplies().forEach((text) => {
            const b = document.createElement('button')
            b.type = 'button'
            b.textContent = text
            b.addEventListener('click', () => {
                reply.value = reply.value ? reply.value + ' ' + text : text
                reply.dispatchEvent(new Event('input'))
                reply.focus()
            })
            box.append(b)
        })
    }

    // ---------------------------------------------------------------- push notifications

    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
    const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

    function urlBase64ToUint8Array(base64) {
        const padding = '='.repeat((4 - (base64.length % 4)) % 4)
        const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
        return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
    }

    function sameKey(sub, publicKey) {
        const key = sub.options && sub.options.applicationServerKey
        if (!key) return true // browser doesn't say; assume it matches
        const a = new Uint8Array(key)
        const b = urlBase64ToUint8Array(publicKey)
        return a.length === b.length && a.every((v, i) => v === b[i])
    }

    async function currentSubscription() {
        if (!pushSupported) return null
        const reg = await navigator.serviceWorker.ready
        return reg.pushManager.getSubscription()
    }

    async function enablePush() {
        try {
            const permission = await Notification.requestPermission()
            if (permission !== 'granted') {
                alert('Notifications were blocked. Turn them on for this app in your phone settings.')
                return refreshPushUi()
            }
            const { publicKey } = await api('/api/admin/push/public-key')
            const reg = await navigator.serviceWorker.ready
            let sub = await reg.pushManager.getSubscription()
            // A subscription made for an older server key can never receive pushes: replace it.
            if (sub && !sameKey(sub, publicKey)) {
                await sub.unsubscribe()
                sub = null
            }
            if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
            await api('/api/admin/push/subscribe', sub.toJSON())
        } catch (err) {
            alert('Could not enable notifications: ' + err.message)
        }
        refreshPushUi()
    }

    async function refreshPushUi() {
        const banner = $('notify-banner')
        const stateEl = $('push-state')
        banner.innerHTML = ''
        if (isIos && !isStandalone) {
            banner.hidden = false
            banner.innerHTML =
                '<b>Get notified on your iPhone:</b> tap the Share button in Safari, then <b>Add to Home Screen</b>. Open DMG Chat from your home screen and turn on notifications.'
            stateEl.textContent = 'On iPhone, add this app to your Home Screen first, then open it from there.'
            return
        }
        if (!pushSupported) {
            banner.hidden = true
            stateEl.textContent = 'This browser does not support push notifications.'
            return
        }
        let sub = await currentSubscription()
        if (sub) {
            try {
                const { publicKey } = await api('/api/admin/push/public-key')
                if (!sameKey(sub, publicKey)) {
                    await sub.unsubscribe()
                    sub = null
                }
            } catch (e) {}
        }
        if (sub && Notification.permission === 'granted') {
            // Re-send in case the server lost it (e.g. a fresh database).
            api('/api/admin/push/subscribe', sub.toJSON()).catch(() => {})
            banner.hidden = true
            stateEl.textContent = '✅ This device will get a notification for every new visitor message.'
            return
        }
        banner.hidden = false
        banner.innerHTML = '<b>Turn on notifications</b> so this device pings you when a visitor messages you.<br>'
        const btn = document.createElement('button')
        btn.textContent = 'Enable notifications'
        btn.addEventListener('click', enablePush)
        banner.append(btn)
        stateEl.textContent = 'Notifications are off on this device.'
    }

    $('push-enable').addEventListener('click', enablePush)
    $('push-test').addEventListener('click', async () => {
        await api('/api/admin/push/test', {})
        $('push-test').textContent = 'Sent!'
        setTimeout(() => ($('push-test').textContent = 'Send test'), 2000)
    })

    // ---------------------------------------------------------------- settings

    $('settings-btn').addEventListener('click', () => {
        $('quick-edit').value = quickReplies().join('\n')
        $('embed').textContent = `<script src="${location.origin}/widget.js" defer></script>`
        refreshPushUi()
        $('settings').showModal()
    })
    $('settings-close').addEventListener('click', () => {
        localStorage.setItem(QUICK_KEY, $('quick-edit').value)
        renderQuick()
        $('settings').close()
    })
    $('logout').addEventListener('click', logout)

    // ---------------------------------------------------------------- realtime

    function connect() {
        const socket = io('/admin', { auth: { token: state.token } })
        state.socket = socket

        socket.on('connect', () => {
            $('conn').classList.add('on')
            loadList()
            if (state.currentId) openConversation(state.currentId, { fromHash: true })
        })
        socket.on('disconnect', () => $('conn').classList.remove('on'))
        socket.on('connect_error', (err) => {
            $('conn').classList.remove('on')
            if (err.message === 'unauthorized') logout()
        })

        socket.on('conversation_updated', (c) => {
            if (!c) return
            state.conversations.set(c.id, c)
            if (c.id === state.currentId) renderThreadHeader(c)
            renderList()
        })

        socket.on('conversation_deleted', (id) => {
            state.conversations.delete(id)
            if (id === state.currentId) {
                history.pushState(null, '', location.pathname)
                closeThread()
            } else renderList()
        })

        socket.on('message', (m) => {
            if (m.conversation_id === state.currentId) {
                addMessage(m)
                if (m.sender === 'visitor') {
                    setVisitorTyping(m.conversation_id, false)
                    if (state.autoSuggest) {
                        state.suggestions.delete(m.conversation_id)
                        state.suggesting.add(m.conversation_id)
                        renderQuick()
                        setTimeout(() => state.suggesting.delete(m.conversation_id) && renderQuick(), 30000)
                    }
                    if (!document.hidden) socket.emit('read', m.conversation_id)
                }
            }
            if (m.sender === 'visitor' && !document.hidden) ping()
        })

        socket.on('visitor_typing', ({ conversationId, typing }) => setVisitorTyping(conversationId, typing))

        socket.on('suggestions', ({ conversationId, options }) => {
            state.suggesting.delete(conversationId)
            if (options.length) state.suggestions.set(conversationId, options)
            else state.suggestions.delete(conversationId)
            if (conversationId === state.currentId) renderQuick()
        })
    }

    // Mark the open conversation read when you come back to the app.
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && state.currentId && state.socket) state.socket.emit('read', state.currentId)
    })

    // Notification taps while the app is already open.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data && e.data.type === 'open-conversation' && state.socket) openConversation(e.data.conversationId)
        })
    }

    async function loadConfig() {
        try {
            const cfg = await api('/api/admin/config')
            $('suggest').hidden = !cfg.ai
            state.autoSuggest = Boolean(cfg.autoSuggest)
        } catch (e) {}
    }

    function start() {
        loadConfig()
        $('login').hidden = true
        $('app').hidden = false
        renderQuick()
        connect()
        refreshPushUi()
        const id = location.hash.slice(1)
        if (id) {
            state.currentId = id
            $('app').classList.add('in-thread')
        }
    }

    // iPhone keyboard: iOS doesn't shrink the page when the keyboard opens, it slides
    // the whole page up, pushing the header and messages off screen. Size the app to
    // the visible area instead, so the messages sit right above the reply box.
    const vv = window.visualViewport
    if (vv) {
        const fit = () => {
            const box = $('messages')
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60
            document.documentElement.style.setProperty('--app-h', Math.round(vv.height) + 'px')
            if (window.scrollY || vv.offsetTop) window.scrollTo(0, 0)
            if (atBottom) box.scrollTop = box.scrollHeight
        }
        vv.addEventListener('resize', fit)
        vv.addEventListener('scroll', fit)
        fit()
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch((e) => console.error(e))
    if (state.token) start()
    else showLogin()
})()
