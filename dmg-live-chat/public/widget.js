/*
 * DMG Live Chat widget.
 *
 * Embed on any page:
 *   <script src="https://YOUR-CHAT-SERVER/widget.js" defer></script>
 *
 * Optional attributes on the script tag:
 *   data-title="Chat with Evan"
 *   data-subtitle="Dorian Media Group"
 *   data-greeting="Hey! Have a question? ..."
 *   data-color="#0f172a"
 *   data-position="right" | "left"
 *   data-avatar="https://.../photo.jpg"
 */
;(function () {
    if (window.__dmgLiveChat) return
    window.__dmgLiveChat = true

    var script =
        document.currentScript ||
        (function () {
            var all = document.querySelectorAll('script[src*="widget.js"]')
            return all[all.length - 1]
        })()
    var BASE = new URL(script.src).origin
    var cfg = {
        title: script.getAttribute('data-title') || 'Chat with Evan',
        subtitle: script.getAttribute('data-subtitle') || 'Dorian Media Group',
        greeting:
            script.getAttribute('data-greeting') ||
            "Hey there! 👋 I'm Evan. Got a question about your website, SEO, or marketing? Send me a message and I'll reply right here.",
        color: script.getAttribute('data-color') || '#0f172a',
        position: script.getAttribute('data-position') === 'left' ? 'left' : 'right',
        avatar: script.getAttribute('data-avatar') || ''
    }

    var STORE_KEY = 'dmg_chat_session'
    var OPEN_KEY = 'dmg_chat_open'
    var storage = {
        get: function (k, s) {
            try {
                return JSON.parse((s || localStorage).getItem(k))
            } catch (e) {
                return null
            }
        },
        set: function (k, v, s) {
            try {
                ;(s || localStorage).setItem(k, JSON.stringify(v))
            } catch (e) {}
        }
    }

    function loadSocketIo(cb) {
        if (window.io && window.io.connect) return cb(window.io)
        var s = document.createElement('script')
        s.src = BASE + '/socket.io/socket.io.min.js'
        s.async = true
        s.onload = function () {
            cb(window.io)
        }
        document.head.appendChild(s)
    }

    // ------------------------------------------------------------------ UI

    var host = document.createElement('div')
    host.id = 'dmg-live-chat'
    host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + cfg.position + ':0;'
    var root = host.attachShadow({ mode: 'open' })
    var side = cfg.position

    root.innerHTML =
        '<style>' +
        ':host{all:initial}' +
        '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}' +
        '.launcher{position:fixed;bottom:20px;' + side + ':20px;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;' +
        'background:var(--c);color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .2s}' +
        '.launcher:hover{transform:scale(1.06)}' +
        '.launcher svg{width:28px;height:28px}' +
        '.badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:#ef4444;color:#fff;' +
        'font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid #fff}' +
        '.teaser{position:fixed;bottom:92px;' + side + ':20px;max-width:260px;background:#fff;color:#111827;padding:12px 14px;border-radius:14px;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:14px;line-height:1.4;cursor:pointer;display:none}' +
        '.teaser .x{float:right;margin-left:8px;color:#9ca3af;cursor:pointer;font-size:16px;line-height:1}' +
        '.panel{position:fixed;bottom:92px;' + side + ':20px;width:370px;height:560px;max-height:calc(100vh - 112px);background:#fff;border-radius:16px;' +
        'box-shadow:0 12px 48px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}' +
        '.panel.open{display:flex;animation:pop .18s ease-out}' +
        '@keyframes pop{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
        '.head{background:var(--c);color:#fff;padding:16px;display:flex;align-items:center;gap:12px}' +
        '.avatar{width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;' +
        'font-weight:700;font-size:18px;flex:none;background-size:cover;background-position:center;position:relative}' +
        '.avatar .dot{position:absolute;bottom:0;right:0;width:12px;height:12px;border-radius:50%;background:#9ca3af;border:2px solid var(--c)}' +
        '.avatar .dot.on{background:#22c55e}' +
        '.head .t{font-weight:700;font-size:16px}' +
        '.head .s{font-size:12.5px;opacity:.85;margin-top:2px}' +
        '.head .close{margin-left:auto;background:none;border:none;color:#fff;cursor:pointer;padding:6px;opacity:.85}' +
        '.head .close svg{width:20px;height:20px}' +
        '.msgs{flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:8px}' +
        '.m{max-width:80%;padding:10px 13px;border-radius:16px;font-size:14.5px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
        '.m a{color:inherit;text-decoration:underline}' +
        '.m.visitor{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:4px}' +
        '.m.admin{align-self:flex-start;background:#fff;color:#111827;border:1px solid #e5e7eb;border-bottom-left-radius:4px}' +
        '.m.pending{opacity:.6}' +
        '.time{font-size:11px;color:#9ca3af;align-self:center;margin:6px 0 2px}' +
        '.typing{align-self:flex-start;display:none;background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:10px 14px}' +
        '.typing span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#9ca3af;animation:b 1.2s infinite}' +
        '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
        '@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}' +
        '.card{align-self:stretch;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;font-size:13.5px;color:#374151}' +
        '.card p{margin:0 0 8px}' +
        '.card input{width:100%;padding:9px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;margin-bottom:6px;color:#111827}' +
        '.card .row{display:flex;gap:6px;justify-content:flex-end}' +
        '.card button{border:none;border-radius:8px;padding:8px 12px;font-size:13px;cursor:pointer}' +
        '.card .save{background:var(--c);color:#fff}.card .skip{background:#f3f4f6;color:#374151}' +
        '.card .err{color:#dc2626;font-size:12px;margin-bottom:6px;display:none}' +
        '.compose{display:flex;align-items:flex-end;gap:8px;padding:10px 12px;border-top:1px solid #e5e7eb;background:#fff}' +
        '.compose textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:20px;padding:10px 14px;font-size:15px;max-height:120px;' +
        'outline:none;line-height:1.35;color:#111827;background:#fff}' +
        '.compose textarea:focus{border-color:var(--c)}' +
        '.send{width:40px;height:40px;border-radius:50%;border:none;background:var(--c);color:#fff;cursor:pointer;flex:none;display:flex;align-items:center;justify-content:center}' +
        '.send:disabled{opacity:.4;cursor:default}' +
        '.send svg{width:18px;height:18px}' +
        '.foot{text-align:center;font-size:11px;color:#9ca3af;padding:0 0 8px;background:#fff}' +
        '.err-bar{background:#fef2f2;color:#b91c1c;font-size:12.5px;padding:8px 12px;display:none}' +
        '@media (max-width:480px){.panel{bottom:0;' + side + ':0;width:100vw;height:100%;max-height:100%;border-radius:0}' +
        '.panel.open ~ .launcher{display:none}}' +
        '</style>' +
        '<div class="teaser"><span class="x" aria-label="Dismiss">×</span><span class="tt"></span></div>' +
        '<div class="panel" role="dialog" aria-label="Live chat">' +
        '  <div class="head">' +
        '    <div class="avatar"><span class="ini"></span><span class="dot"></span></div>' +
        '    <div><div class="t"></div><div class="s"></div></div>' +
        '    <button class="close" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' +
        '  </div>' +
        '  <div class="err-bar"></div>' +
        '  <div class="msgs" aria-live="polite"><div class="typing"><span></span><span></span><span></span></div></div>' +
        '  <form class="compose">' +
        '    <textarea rows="1" placeholder="Type your message…" aria-label="Message"></textarea>' +
        '    <button class="send" type="submit" aria-label="Send" disabled><svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.45-7.48a1 1 0 000-1.84L3.4 3.6a.99.99 0 00-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg></button>' +
        '  </form>' +
        '  <div class="foot">Replies go straight to Evan\'s phone</div>' +
        '</div>' +
        '<button class="launcher" aria-label="Open chat">' +
        '  <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.48 3 2 6.94 2 11.8c0 2.4 1.1 4.57 2.88 6.16-.17 1.4-.8 2.67-1.8 3.65a.5.5 0 00.4.86c2.03-.1 3.86-.85 5.2-1.95.98.27 2.1.43 3.32.43 5.52 0 10-3.94 10-8.8S17.52 3 12 3z"/></svg>' +
        '  <span class="badge"></span>' +
        '</button>'

    host.style.setProperty('--c', cfg.color)

    var $ = function (sel) {
        return root.querySelector(sel)
    }
    var panel = $('.panel')
    var launcher = $('.launcher')
    var badge = $('.badge')
    var msgs = $('.msgs')
    var typingEl = $('.typing')
    var form = $('.compose')
    var input = $('textarea')
    var sendBtn = $('.send')
    var teaser = $('.teaser')
    var errBar = $('.err-bar')
    var statusDot = $('.dot')
    var subtitle = $('.head .s')

    $('.head .t').textContent = cfg.title
    subtitle.textContent = cfg.subtitle
    if (cfg.avatar) {
        $('.avatar').style.backgroundImage = 'url("' + cfg.avatar.replace(/"/g, '%22') + '")'
    } else {
        $('.ini').textContent = cfg.title.replace(/^chat with /i, '').charAt(0).toUpperCase() || 'E'
    }
    $('.tt').textContent = cfg.greeting

    // ------------------------------------------------------------ helpers

    var URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g
    function renderText(el, text) {
        var last = 0
        text.replace(URL_RE, function (match, _u, idx) {
            if (idx > last) el.appendChild(document.createTextNode(text.slice(last, idx)))
            var a = document.createElement('a')
            a.href = match
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
            a.textContent = match
            el.appendChild(a)
            last = idx + match.length
        })
        if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)))
    }

    function fmtTime(ts) {
        var d = new Date(ts)
        var today = new Date()
        var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        return d.toDateString() === today.toDateString() ? t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t
    }

    var lastTs = 0
    function addBubble(sender, text, ts, opts) {
        opts = opts || {}
        if (ts && ts - lastTs > 15 * 60 * 1000) {
            var t = document.createElement('div')
            t.className = 'time'
            t.textContent = fmtTime(ts)
            msgs.insertBefore(t, typingEl)
        }
        if (ts) lastTs = ts
        var el = document.createElement('div')
        el.className = 'm ' + (sender === 'visitor' ? 'visitor' : 'admin') + (opts.pending ? ' pending' : '')
        renderText(el, text)
        msgs.insertBefore(el, typingEl)
        scrollDown()
        return el
    }

    function scrollDown() {
        msgs.scrollTop = msgs.scrollHeight
    }

    function showError(text) {
        errBar.textContent = text
        errBar.style.display = text ? 'block' : 'none'
    }

    var unread = 0
    function setUnread(n) {
        unread = n
        badge.textContent = n > 9 ? '9+' : String(n)
        badge.style.display = n > 0 ? 'flex' : 'none'
    }

    function isOpen() {
        return panel.classList.contains('open')
    }

    // A short chime for incoming replies (no audio file needed).
    function chime() {
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext
            var ctx = new Ctx()
            var o = ctx.createOscillator()
            var g = ctx.createGain()
            o.type = 'sine'
            o.frequency.setValueAtTime(880, ctx.currentTime)
            o.frequency.setValueAtTime(1175, ctx.currentTime + 0.09)
            g.gain.setValueAtTime(0.0001, ctx.currentTime)
            g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02)
            g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
            o.connect(g)
            g.connect(ctx.destination)
            o.start()
            o.stop(ctx.currentTime + 0.4)
        } catch (e) {}
    }

    var originalTitle = document.title
    var titleTimer = null
    function flashTitle() {
        if (titleTimer || !document.hidden) return
        var on = false
        titleTimer = setInterval(function () {
            document.title = (on = !on) ? '💬 New message from Evan' : originalTitle
        }, 1200)
    }
    function stopFlash() {
        if (!titleTimer) return
        clearInterval(titleTimer)
        titleTimer = null
        document.title = originalTitle
    }
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) stopFlash()
    })

    // ------------------------------------------------------------ state

    var socket = null
    var contact = {}
    var hasMessages = false
    var contactCardShown = false
    var greetingShown = false

    function showGreeting() {
        if (greetingShown) return
        greetingShown = true
        addBubble('admin', cfg.greeting)
    }

    function maybeAskContact() {
        if (contactCardShown || contact.email) return
        contactCardShown = true
        var card = document.createElement('div')
        card.className = 'card'
        card.innerHTML =
            '<p>Thanks! I\'ll reply here in a moment. In case you step away, where can I follow up?</p>' +
            '<div class="err"></div>' +
            '<input class="n" type="text" placeholder="Your name" autocomplete="name" maxlength="100">' +
            '<input class="e" type="email" placeholder="Email address" autocomplete="email" maxlength="200">' +
            '<div class="row"><button type="button" class="skip">Skip</button><button type="button" class="save">Save</button></div>'
        msgs.insertBefore(card, typingEl)
        scrollDown()
        var err = card.querySelector('.err')
        card.querySelector('.skip').onclick = function () {
            card.remove()
        }
        card.querySelector('.save').onclick = function () {
            var name = card.querySelector('.n').value.trim()
            var email = card.querySelector('.e').value.trim()
            if (!name && !email) return card.remove()
            socket.emit('contact', { name: name, email: email }, function (res) {
                if (res && res.error) {
                    err.textContent = res.error
                    err.style.display = 'block'
                    return
                }
                contact = { name: name || contact.name, email: email || contact.email }
                card.innerHTML = '<p>Got it' + (name ? ', ' : '') + '<span class="nm"></span>! I\'ll be in touch.</p>'
                card.querySelector('.nm').textContent = name
            })
        }
    }

    function setAdminOnline(on) {
        statusDot.classList.toggle('on', on)
        subtitle.textContent = on ? 'Online now' : 'Usually replies within minutes'
    }

    function connect() {
        if (socket) return
        loadSocketIo(function (io) {
            socket = io(BASE + '/visitor', {
                auth: function (cb) {
                    var s = storage.get(STORE_KEY) || {}
                    cb({ visitorId: s.visitorId, token: s.token, pageUrl: location.href, referrer: document.referrer })
                },
                transports: ['websocket', 'polling']
            })

            socket.on('connect_error', function () {
                showError('Reconnecting…')
            })
            socket.on('connect', function () {
                showError('')
            })

            socket.on('session', function (data) {
                storage.set(STORE_KEY, { visitorId: data.visitorId, token: data.token })
                contact = data.contact || {}
                setAdminOnline(data.adminOnline)
                // Rebuild history (also runs after reconnects).
                Array.prototype.slice.call(msgs.querySelectorAll('.m,.time,.card')).forEach(function (n) {
                    n.remove()
                })
                greetingShown = false
                contactCardShown = false
                lastTs = 0
                showGreeting()
                hasMessages = data.messages.length > 0
                data.messages.forEach(function (m) {
                    addBubble(m.sender, m.body, m.created_at)
                })
                if (isOpen()) {
                    socket.emit('read')
                    setUnread(0)
                } else {
                    setUnread(data.unread || 0)
                }
                if (hasMessages && !contact.email) contactCardShown = true // don't nag returning visitors
            })

            socket.on('message', function (m) {
                addBubble(m.sender, m.body, m.created_at)
                if (m.sender === 'admin') {
                    typingEl.style.display = 'none'
                    if (isOpen() && !document.hidden) {
                        socket.emit('read')
                    } else {
                        setUnread(unread + 1)
                        chime()
                        flashTitle()
                    }
                }
            })

            socket.on('admin_typing', function (on) {
                typingEl.style.display = on ? 'block' : 'none'
                if (on) scrollDown()
            })

            socket.on('admin_status', function (d) {
                setAdminOnline(d.online)
            })
        })
    }

    // ------------------------------------------------------------ events

    function open() {
        panel.classList.add('open')
        teaser.style.display = 'none'
        storage.set(OPEN_KEY, true, sessionStorage)
        storage.set('dmg_chat_teased', true, sessionStorage)
        setUnread(0)
        stopFlash()
        connect()
        if (socket && socket.connected) socket.emit('read')
        showGreeting()
        setTimeout(function () {
            if (window.innerWidth > 480) input.focus()
            scrollDown()
        }, 50)
    }

    function close() {
        panel.classList.remove('open')
        storage.set(OPEN_KEY, false, sessionStorage)
    }

    launcher.addEventListener('click', function () {
        isOpen() ? close() : open()
    })
    $('.head .close').addEventListener('click', close)
    teaser.addEventListener('click', function (e) {
        if (e.target.classList.contains('x')) {
            teaser.style.display = 'none'
            storage.set('dmg_chat_teased', true, sessionStorage)
            return
        }
        open()
    })

    input.addEventListener('input', function () {
        input.style.height = 'auto'
        input.style.height = Math.min(input.scrollHeight, 120) + 'px'
        sendBtn.disabled = !input.value.trim()
        notifyTyping()
    })
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            form.requestSubmit ? form.requestSubmit() : submit(e)
        }
    })

    var typingTimer = null
    var typingSent = false
    function notifyTyping() {
        if (!socket) return
        if (!typingSent) {
            typingSent = true
            socket.emit('typing', true)
        }
        clearTimeout(typingTimer)
        typingTimer = setTimeout(function () {
            typingSent = false
            socket.emit('typing', false)
        }, 2500)
    }

    function submit(e) {
        e.preventDefault()
        var body = input.value.trim()
        if (!body || !socket) return
        input.value = ''
        input.style.height = 'auto'
        sendBtn.disabled = true
        clearTimeout(typingTimer)
        typingSent = false
        socket.emit('typing', false)
        var bubble = addBubble('visitor', body, Date.now(), { pending: true })
        socket.timeout(10000).emit('message', { body: body, pageUrl: location.href }, function (err, res) {
            if (err || (res && res.error)) {
                bubble.classList.add('pending')
                showError((res && res.error) || 'Message not sent. Check your connection and try again.')
                return
            }
            bubble.classList.remove('pending')
            showError('')
            hasMessages = true
            maybeAskContact()
        })
    }
    form.addEventListener('submit', submit)

    // ------------------------------------------------------------ boot

    function boot() {
        document.body.appendChild(host)
        var session = storage.get(STORE_KEY)
        // Returning visitors connect right away so they see replies and unread badges.
        if (session && session.visitorId) connect()
        if (storage.get(OPEN_KEY, sessionStorage)) open()
        else if (!storage.get('dmg_chat_teased', sessionStorage)) {
            setTimeout(function () {
                if (!isOpen()) teaser.style.display = 'block'
            }, 8000)
        }
    }

    if (document.body) boot()
    else document.addEventListener('DOMContentLoaded', boot)
})()
