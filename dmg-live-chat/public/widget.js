/*
 * DMG Live Chat widget.
 *
 * Embed on every page (WordPress: WPCode > Footer):
 *   <script src="https://YOUR-CHAT-SERVER/widget.js" defer></script>
 *
 * Optional attributes on the script tag:
 *   data-name="Evan Dorian"
 *   data-role="Founder / Creative Director"
 *   data-photo="https://.../photo.webp"
 *   data-greeting="Hi, thanks for stopping by! ..."
 *   data-teaser="Have a project in mind? ..."
 *   data-teaser-delay="8"                 seconds before the welcome teaser appears (0 = never)
 *   data-teaser-exclude="/contact,/book-a-discovery-call"   paths where the teaser stays hidden
 *   data-booking-url="https://.../book-a-discovery-call/"
 *   data-hide-on-teaser="CSS selector"    on phones, hidden while the teaser shows (your reviews badge)
 *   data-hide-on="single-post,blog,..."  WordPress body classes where the chat doesn't appear at all
 *   data-hide-paths="/book-a-discovery-call,..."  pages where the chat doesn't appear at all
 *   data-color="#28b0ff"
 *   data-position="right" | "left"
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
    var attr = function (name, fallback) {
        var v = script.getAttribute('data-' + name)
        return v === null || v === '' ? fallback : v
    }
    var cfg = {
        name: attr('name', 'Evan Dorian'),
        role: attr('role', 'Founder / Creative Director'),
        photo: attr('photo', 'https://dorianmediagroup.com/wp-content/uploads/2026/10/Evan-Dorian.webp'),
        greeting: attr(
            'greeting',
            "Hi, thanks for stopping by! Take a look around, and if you have a project in mind, I'd love to hear about it. Send me a message here, or choose an option below."
        ),
        teaser: attr('teaser', "Have a project in mind? I'm here if you have any questions."),
        teaserDelay: Number(attr('teaser-delay', '8')),
        teaserExclude: attr('teaser-exclude', '/contact,/book-a-discovery-call')
            .split(',')
            .map(function (p) {
                return p.trim().replace(/\/$/, '')
            })
            .filter(Boolean),
        bookingUrl: attr('booking-url', 'https://dorianmediagroup.com/book-a-discovery-call/'),
        hideOnTeaser: attr(
            'hide-on-teaser',
            '[class*="reviews-badge"],[id*="reviews-badge"],[class*="google-reviews"],[id*="google-reviews"],[class*="dmg-grb"],[id*="dmg-grb"]'
        ),
        // Blog posts, the blog page and blog archives (WordPress adds these classes to <body>).
        // Booking pages: the visitor is already booking, so the chat stays out of the way.
        hidePaths: attr('hide-paths', '/book-a-discovery-call,/schedule-ai-audit,/booking-confirmed')
            .split(',')
            .map(function (p) {
                return p.trim().replace(/\/$/, '')
            })
            .filter(Boolean),
        hideOn: attr('hide-on', 'single-post,blog,archive,category,tag,author,date,search')
            .split(',')
            .map(function (c) {
                return c.trim()
            })
            .filter(Boolean),
        color: attr('color', '#28b0ff'),
        position: attr('position', 'right') === 'left' ? 'left' : 'right'
    }
    var firstName = cfg.name.split(' ')[0]

    var STORE_KEY = 'dmg_chat_session'
    var OPEN_KEY = 'dmg_chat_open'
    var TEASED_KEY = 'dmg_chat_teased'
    function getStore(k, s) {
        try {
            return JSON.parse((s || localStorage).getItem(k))
        } catch (e) {
            return null
        }
    }
    function setStore(k, v, s) {
        try {
            ;(s || localStorage).setItem(k, JSON.stringify(v))
        } catch (e) {}
    }

    // 7. Conversion tracking for Google Tag Manager / GA4.
    function track(event, params) {
        try {
            window.dataLayer = window.dataLayer || []
            var data = { event: event, chat_page: location.pathname }
            for (var k in params || {}) data[k] = params[k]
            window.dataLayer.push(data)
        } catch (e) {}
    }

    function loadSocketIo(cb) {
        if (window.io && window.io.connect) return cb(window.io)
        var existing = document.getElementById('dmg-chat-sio')
        if (existing) return existing.addEventListener('load', function () {
            cb(window.io)
        })
        var s = document.createElement('script')
        s.id = 'dmg-chat-sio'
        s.src = BASE + '/socket.io/socket.io.min.js'
        s.async = true
        s.onload = function () {
            cb(window.io)
        }
        document.head.appendChild(s)
    }

    // ------------------------------------------------------------------ UI

    var side = cfg.position
    var ICON = {
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
        down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
        clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 01-7.8-7.8l8.6-8.6a3.7 3.7 0 015.2 5.2l-8.6 8.6a1.8 1.8 0 01-2.6-2.6l8-8"/></svg>',
        cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
        mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
        file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5"/></svg>'
    }

    var host = document.createElement('div')
    host.id = 'dmg-live-chat'
    host.style.cssText = 'position:fixed;z-index:2147483000;bottom:0;' + side + ':0;width:0;height:0;'
    var root = host.attachShadow({ mode: 'open' })

    root.innerHTML =
        '<style>' +
        ':host{all:initial;--c:' + cfg.color + ';--ink:#0e1015;--text:#1c1f27;--muted:#5b6474;--line:#ebeced;--field:#d9dce1;--soft:#f7f8f9;--ok:#22c55e}' +
        '*{box-sizing:border-box;font-family:Arial,Helvetica,sans-serif}' +
        'button{font:inherit;cursor:pointer}' +
        '.disp{font-family:Montserrat,Arial,sans-serif}' +
        '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
        'svg{display:block}' +
        // avatar
        '.av{position:relative;flex:none;border-radius:50%}' +
        '.av img{width:100%;height:100%;border-radius:50%;object-fit:cover;object-position:50% 0;display:block;background:#e3f4ff}' +
        '.av .dot{position:absolute;right:0;bottom:0;width:28%;height:28%;min-width:10px;min-height:10px;border-radius:50%;background:var(--ok);border:2px solid #fff}' +
        // launcher
        '.launcher{position:fixed;bottom:20px;' + side + ':20px;width:62px;height:62px;padding:0;border-radius:50%;border:3px solid #fff;background:#fff;' +
        'box-shadow:0 10px 30px rgba(0,0,0,.35);transition:transform .2s cubic-bezier(.22,1,.36,1)}' +
        '.launcher:hover{transform:scale(1.05)}' +
        '.launcher .av{width:100%;height:100%}' +
        '.launcher .av .dot{border:3px solid #fff;right:-2px;bottom:0}' +
        '.launcher .x{display:none;width:100%;height:100%;align-items:center;justify-content:center;color:var(--ink)}' +
        '.launcher .x svg{width:22px;height:22px}' +
        '.launcher.open .av{display:none}.launcher.open .x{display:flex}' +
        '.badge{position:absolute;top:-4px;' + (side === 'right' ? 'left' : 'right') + ':-4px;min-width:22px;height:22px;padding:0 6px;border-radius:11px;background:#ef4444;color:#fff;' +
        'font-size:12px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid #fff}' +
        // teaser
        '.teaser{position:fixed;bottom:96px;' + side + ':20px;width:320px;background:#fff;color:var(--ink);border-radius:18px;padding:14px 10px 14px 16px;' +
        'box-shadow:0 18px 50px rgba(0,0,0,.35);display:none;flex-direction:column;gap:8px;animation:pop .25s cubic-bezier(.22,1,.36,1)}' +
        '.teaser.show{display:flex}' +
        '.trow{display:flex;align-items:center;gap:10px}' +
        '.trow .av{width:36px;height:36px}' +
        '.who{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}' +
        '.who .n{font-weight:700;font-size:14px;color:var(--ink)}.who .r{font-size:12px;color:var(--muted)}' +
        '.tclose{width:40px;height:40px;margin:-8px -4px -8px 0;border:none;background:transparent;color:var(--muted);border-radius:10px;display:flex;align-items:center;justify-content:center}' +
        '.tclose svg{width:16px;height:16px}' +
        '.ttext{border:none;background:none;padding:0;text-align:left;font-size:14.5px;line-height:1.45;color:var(--text)}' +
        // panel
        '.backdrop{display:none}' +
        '.panel{position:fixed;bottom:96px;' + side + ':20px;width:384px;max-height:min(640px,calc(100vh - 120px));background:#fff;color:var(--ink);border-radius:20px;' +
        'overflow:hidden;display:none;flex-direction:column;box-shadow:0 24px 70px rgba(0,0,0,.4),0 0 0 1px rgba(14,16,21,.06)}' +
        '.panel.open{display:flex;animation:pop .22s cubic-bezier(.22,1,.36,1)}' +
        '@keyframes pop{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}' +
        '.handle{display:none}' +
        '.head{display:flex;align-items:center;gap:14px;padding:18px 14px 18px 20px;border-bottom:1px solid var(--line);flex:none}' +
        '.head .av{width:52px;height:52px}.head .av .dot{border-width:2.5px}' +
        '.head .who .n{font-size:17px}.head .who .r{font-size:13px}' +
        '.iconbtn{width:44px;height:44px;border:none;background:transparent;color:var(--muted);border-radius:12px;display:flex;align-items:center;justify-content:center}' +
        '.iconbtn svg{width:20px;height:20px}' +
        '.iconbtn:hover{background:var(--soft)}' +
        '.err{display:none;background:#fef2f2;color:#b91c1c;font-size:12.5px;padding:8px 14px;flex:none}' +
        '.msgs{flex:1 1 auto;min-height:0;overflow-y:auto;background:var(--soft);padding:18px;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}' +
        '.stamp{align-self:center;font-size:12px;color:var(--muted);margin:4px 0 0}' +
        '.m{max-width:85%;padding:12px 15px;font-size:15px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
        '.m a{color:inherit;text-decoration:underline}' +
        '.m.admin{align-self:flex-start;background:#fff;border:1px solid var(--line);border-radius:18px 18px 18px 6px;color:var(--text)}' +
        '.m.visitor{align-self:flex-end;background:var(--ink);color:#fff;border-radius:18px 18px 6px 18px}' +
        '.m.pending{opacity:.55}' +
        '.m img{display:block;max-width:100%;max-height:220px;border-radius:10px;margin:2px 0}' +
        '.m .filechip{display:flex;align-items:center;gap:8px;text-decoration:none}.m .filechip svg{width:18px;height:18px;flex:none}' +
        '.actions{display:flex;flex-direction:column;gap:8px;max-width:85%}' +
        '.act{display:flex;align-items:center;gap:10px;min-height:46px;padding:0 16px;border-radius:14px;font-weight:700;font-size:14.5px;text-decoration:none;border:1px solid var(--field);background:#fff;color:var(--ink);text-align:left}' +
        '.act svg{width:18px;height:18px;flex:none}' +
        '.act.primary{background:var(--c);border-color:var(--c)}' +
        '.typing{align-self:flex-start;display:none;align-items:flex-end;gap:8px}' +
        '.typing.on{display:flex;animation:pop .2s cubic-bezier(.22,1,.36,1)}' +
        '.typing .av{width:28px;height:28px}' +
        '.typing .dots{background:#fff;border:1px solid var(--line);border-radius:18px 18px 18px 6px;padding:13px 15px;display:flex;gap:4px}' +
        '.typing span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:#9aa3b2;animation:b 1.2s infinite}' +
        '.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}' +
        '@keyframes b{0%,60%,100%{transform:none;opacity:.5}30%{transform:translateY(-4px);opacity:1}}' +
        '.card{align-self:stretch;background:#fff;border:1px solid var(--line);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px}' +
        '.card p{margin:0;font-size:14px;line-height:1.45;color:var(--text)}' +
        '.card label{font-size:12.5px;font-weight:700;color:#3b4250;display:flex;flex-direction:column;gap:4px}' +
        '.card input,.card textarea{height:44px;border:1px solid var(--field);border-radius:10px;padding:0 12px;font:inherit;font-size:16px;color:var(--ink);background:#fff;width:100%}' +
        '.card textarea{height:88px;padding:10px 12px;resize:none}' +
        '.card .note{font-size:12px;line-height:1.4;color:var(--muted)}' +
        '.card .cerr{display:none;color:#b91c1c;font-size:12.5px}' +
        '.row{display:flex;gap:8px;justify-content:flex-end}' +
        '.btn{height:44px;padding:0 18px;border:none;border-radius:12px;font-size:14px;font-weight:700}' +
        '.btn.ghost{background:#f1f2f4;color:#3b4250}.btn.main{background:var(--c);color:var(--ink)}' +
        '.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}' +
        '.compose{display:flex;align-items:flex-end;gap:6px;padding:12px 12px 10px;border-top:1px solid var(--line);background:#fff;flex:none}' +
        '.compose textarea{flex:1;resize:none;border:1px solid var(--field);border-radius:22px;padding:12px 16px;font:inherit;font-size:15px;max-height:120px;' +
        'outline:none;line-height:1.35;color:var(--ink);background:#fff;min-width:0}' +
        '.compose textarea:focus{border-color:var(--c)}' +
        '.compose .iconbtn{width:42px;height:46px}' +
        '.send{width:46px;height:46px;flex:none;border:none;border-radius:50%;background:var(--c);color:var(--ink);display:flex;align-items:center;justify-content:center}' +
        '.send svg{width:20px;height:20px}.send:disabled{opacity:.45;cursor:default}' +
        '.foot{text-align:center;font-size:11.5px;color:var(--muted);padding:0 0 10px;background:#fff;flex:none}' +
        // phones: slide-up sheet
        '@media (max-width:480px){' +
        '.launcher{bottom:16px;' + side + ':16px;width:58px;height:58px}' +
        '.teaser{bottom:88px;' + side + ':16px;width:min(300px,calc(100vw - 32px));border-radius:18px 18px 6px 18px}' +
        '.teaser .ttext{font-size:15px}' +
        '.backdrop.open{display:block;position:fixed;inset:0;background:rgba(14,16,21,.55);border:none;padding:0;width:100%;height:100%}' +
        '.panel{left:0;right:0;bottom:0;width:100%;max-height:none;height:90vh;height:90dvh;border-radius:22px 22px 0 0;transition:height .2s,border-radius .2s,transform .2s}' +
        '.panel.full{height:100vh;height:100dvh;border-radius:0}' +
        '.panel.open ~ .launcher{display:none}' +
        '.handle{display:block;align-self:center;width:40px;height:5px;border-radius:3px;background:var(--field);margin:8px 0 0;flex:none}' +
        '.head{padding:10px 10px 14px 18px}.head .av{width:48px;height:48px}' +
        '.m{font-size:16px}.compose textarea{font-size:16px}.act{min-height:50px;font-size:15px}' +
        '.foot{padding-bottom:max(10px,env(safe-area-inset-bottom))}' +
        '}' +
        '@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}' +
        '</style>' +
        '<div class="teaser" role="dialog" aria-label="Message from ' + firstName + '">' +
        '  <div class="trow"><div class="av"><img alt=""><span class="dot"></span></div>' +
        '    <div class="who"><div class="n disp"></div><div class="r"></div></div>' +
        '    <button type="button" class="tclose" aria-label="Dismiss">' + ICON.close + '</button></div>' +
        '  <button type="button" class="ttext"></button>' +
        '</div>' +
        '<button type="button" class="backdrop" aria-label="Close chat"></button>' +
        '<section class="panel" role="dialog" aria-label="Chat">' +
        '  <div class="handle" aria-hidden="true"></div>' +
        '  <header class="head"><div class="av"><img alt=""><span class="dot"></span></div>' +
        '    <div class="who"><div class="n disp"></div><div class="r"></div></div>' +
        '    <button type="button" class="iconbtn min" aria-label="Minimize chat">' + ICON.down + '</button></header>' +
        '  <div class="err" role="alert"></div>' +
        '  <div class="msgs" aria-live="polite"><div class="typing" role="status"><div class="av"><img alt=""></div><div class="dots" aria-label="' + firstName + ' is typing"><span></span><span></span><span></span></div></div></div>' +
        '  <form class="compose">' +
        '    <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">' +
        '    <input type="file" class="file sr" accept="image/*,application/pdf" tabindex="-1" aria-hidden="true">' +
        '    <button type="button" class="iconbtn attach" aria-label="Attach a photo or PDF">' + ICON.clip + '</button>' +
        '    <label class="sr" for="dmg-msg">Message</label>' +
        '    <textarea id="dmg-msg" rows="1" placeholder="Write a message…"></textarea>' +
        '    <button class="send" type="submit" aria-label="Send message" disabled>' + ICON.send + '</button>' +
        '  </form>' +
        '  <div class="foot">Messages go straight to ' + firstName + '</div>' +
        '</section>' +
        '<button type="button" class="launcher" aria-label="Open chat with ' + firstName + '">' +
        '  <div class="av"><img alt=""><span class="dot"></span></div><span class="x">' + ICON.close + '</span>' +
        '  <span class="badge"></span>' +
        '</button>'

    var $ = function (sel) {
        return root.querySelector(sel)
    }
    var panel = $('.panel')
    var launcher = $('.launcher')
    var backdrop = $('.backdrop')
    var badge = $('.badge')
    var msgs = $('.msgs')
    var typingEl = $('.typing')
    var form = $('.compose')
    var input = $('textarea')
    var sendBtn = $('.send')
    var teaser = $('.teaser')
    var errBar = $('.err')
    var fileInput = $('.file')
    var honeypot = $('.hp')

    root.querySelectorAll('.av img').forEach(function (img) {
        img.src = cfg.photo
        img.alt = cfg.name
    })
    root.querySelectorAll('.who .n').forEach(function (el) {
        el.textContent = cfg.name
    })
    root.querySelectorAll('.who .r').forEach(function (el) {
        el.textContent = cfg.role
    })
    $('.ttext').textContent = cfg.teaser
    panel.setAttribute('aria-label', 'Chat with ' + cfg.name)

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
        var t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        return d.toDateString() === new Date().toDateString() ? 'Today ' + t : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + t
    }

    function insert(el) {
        msgs.insertBefore(el, typingEl)
        scrollDown()
        return el
    }

    var lastTs = 0
    function addBubble(m, opts) {
        opts = opts || {}
        if (m.created_at && m.created_at - lastTs > 15 * 60 * 1000) {
            var t = document.createElement('div')
            t.className = 'stamp'
            t.textContent = fmtTime(m.created_at)
            insert(t)
        }
        if (m.created_at) lastTs = m.created_at
        var el = document.createElement('div')
        el.className = 'm ' + (m.sender === 'visitor' ? 'visitor' : 'admin') + (opts.pending ? ' pending' : '')
        if (m.attachment) {
            var a = document.createElement('a')
            a.href = m.attachment.url
            a.target = '_blank'
            a.rel = 'noopener noreferrer'
            if (/^image\//.test(m.attachment.type)) {
                var img = document.createElement('img')
                img.src = m.attachment.url
                img.alt = m.attachment.name
                img.loading = 'lazy'
                img.onload = scrollDown
                a.appendChild(img)
            } else {
                a.className = 'filechip'
                a.innerHTML = ICON.file
                a.appendChild(document.createTextNode(m.attachment.name))
            }
            el.appendChild(a)
            if (m.body) el.appendChild(document.createElement('br'))
        }
        if (m.body) renderText(el, m.body)
        return insert(el)
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
    var isPhone = function () {
        return window.matchMedia('(max-width: 480px)').matches
    }

    // A short chime for incoming replies (no audio file needed).
    function chime() {
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext
            var ctx = new Ctx()
            var o = ctx.createOscillator()
            var g = ctx.createGain()
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
            document.title = (on = !on) ? 'New message from ' + firstName : originalTitle
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

    // ------------------------------------------------------------ teaser + reviews badge

    var hiddenForTeaser = []
    function hideBadgeForTeaser() {
        if (!isPhone() || !cfg.hideOnTeaser) return
        try {
            document.querySelectorAll(cfg.hideOnTeaser).forEach(function (el) {
                // Only floating elements, never page content that happens to match.
                if (host.contains(el) || getComputedStyle(el).position !== 'fixed') return
                hiddenForTeaser.push({ el: el, v: el.style.visibility, o: el.style.opacity, t: el.style.transition })
                el.style.transition = 'opacity .2s'
                el.style.opacity = '0'
                el.style.visibility = 'hidden'
            })
        } catch (e) {}
    }
    function restoreBadge() {
        hiddenForTeaser.forEach(function (h) {
            h.el.style.visibility = h.v
            h.el.style.opacity = h.o
            setTimeout(function () {
                h.el.style.transition = h.t
            }, 250)
        })
        hiddenForTeaser = []
    }
    function showTeaser() {
        if (isOpen() || getStore(TEASED_KEY, sessionStorage)) return
        setStore(TEASED_KEY, true, sessionStorage)
        hideBadgeForTeaser()
        teaser.classList.add('show')
        track('dmg_chat_teaser_shown')
    }
    function hideTeaser() {
        if (!teaser.classList.contains('show')) return
        teaser.classList.remove('show')
        restoreBadge()
    }
    function teaserAllowedHere() {
        return cfg.teaserDelay > 0 && !onPaths(cfg.teaserExclude)
    }

    function onPaths(list) {
        var p = location.pathname.replace(/\/$/, '')
        return list.some(function (x) {
            return p === x || p.indexOf(x + '/') === 0
        })
    }

    // ------------------------------------------------------------ state

    var socket = null
    var session = getStore(STORE_KEY) || {}
    var contact = {}
    var hasMessages = false
    var contactAsked = false

    function renderIntro() {
        var g = document.createElement('div')
        g.className = 'm admin'
        g.textContent = cfg.greeting
        insert(g)
        var actions = document.createElement('div')
        actions.className = 'actions'
        actions.innerHTML =
            '<a class="act primary book" target="_blank" rel="noopener">' + ICON.cal + 'Book a Discovery Call</a>' +
            '<button type="button" class="act emailbtn">' + ICON.mail + 'Send an Email</button>'
        var book = actions.querySelector('.book')
        book.href = cfg.bookingUrl
        book.addEventListener('click', function () {
            track('dmg_chat_book_call_click')
        })
        actions.querySelector('.emailbtn').addEventListener('click', function () {
            track('dmg_chat_email_click')
            showEmailForm()
        })
        insert(actions)
    }

    function cardError(card, text) {
        var e = card.querySelector('.cerr')
        e.textContent = text
        e.style.display = text ? 'block' : 'none'
    }

    function saveContact(name, email, done) {
        withSocket(function () {
            socket.emit('contact', { name: name, email: email, hp: honeypot.value }, function (res) {
                if (res && res.error) return done(res.error)
                contact = { name: name || contact.name, email: email || contact.email }
                if (email) track('dmg_chat_email_captured')
                done()
            })
        })
    }

    // Asked after the first message, and again after the auto-reply if we still have no email.
    function askContact(text) {
        if (contact.email || root.querySelector('.card.contact')) return
        contactAsked = true
        var card = document.createElement('div')
        card.className = 'card contact'
        card.innerHTML =
            '<p></p><div class="cerr" role="alert"></div>' +
            '<label>Name<input class="n" type="text" autocomplete="name" maxlength="100"></label>' +
            '<label>Email<input class="e" type="email" autocomplete="email" placeholder="you@company.com" maxlength="200"></label>' +
            '<div class="note">You&#39;ll also get occasional updates from Dorian Media. Unsubscribe anytime.</div>' +
            '<div class="row"><button type="button" class="btn ghost skip">Skip</button><button type="button" class="btn main save">Save</button></div>'
        card.querySelector('p').textContent = text || 'Thanks! In case you step away, where can I follow up with you?'
        if (contact.name) card.querySelector('.n').value = contact.name
        insert(card)
        card.querySelector('.skip').onclick = function () {
            card.remove()
        }
        card.querySelector('.save').onclick = function () {
            var name = card.querySelector('.n').value.trim()
            var email = card.querySelector('.e').value.trim()
            if (!email) return cardError(card, 'Please add your email so ' + firstName + ' can reply.')
            saveContact(name, email, function (err) {
                if (err) return cardError(card, err)
                card.innerHTML = '<p></p>'
                card.querySelector('p').textContent =
                    'Got it' + (name ? ', ' + name.split(' ')[0] : '') + '! If you leave, ' + firstName + "'s reply will go to " + email + '.'
            })
        }
    }

    // "Send an Email": a short form right in the chat. It becomes a normal chat
    // message, and the reply is emailed if they've left.
    function showEmailForm() {
        if (root.querySelector('.card.emailform')) return root.querySelector('.card.emailform input').focus()
        var card = document.createElement('div')
        card.className = 'card emailform'
        card.innerHTML =
            '<p>Leave your details and message, and ' + firstName + ' will reply by email.</p><div class="cerr" role="alert"></div>' +
            '<label>Name<input class="n" type="text" autocomplete="name" maxlength="100"></label>' +
            '<label>Email<input class="e" type="email" autocomplete="email" placeholder="you@company.com" maxlength="200"></label>' +
            '<label>Message<textarea class="b" maxlength="2000"></textarea></label>' +
            '<div class="note">You&#39;ll also get occasional updates from Dorian Media. Unsubscribe anytime.</div>' +
            '<div class="row"><button type="button" class="btn ghost skip">Cancel</button><button type="button" class="btn main save">Send</button></div>'
        if (contact.name) card.querySelector('.n').value = contact.name
        if (contact.email) card.querySelector('.e').value = contact.email
        insert(card)
        card.querySelector('.n').focus()
        card.querySelector('.skip').onclick = function () {
            card.remove()
        }
        card.querySelector('.save').onclick = function () {
            var name = card.querySelector('.n').value.trim()
            var email = card.querySelector('.e').value.trim()
            var body = card.querySelector('.b').value.trim()
            if (!email || !body) return cardError(card, 'Please add your email and a message.')
            saveContact(name, email, function (err) {
                if (err) return cardError(card, err)
                card.remove()
                sendMessage(body)
            })
        }
    }

    function withSocket(cb) {
        if (socket && socket.connected) return cb()
        connect()
        var tries = 0
        ;(function wait() {
            if (socket && socket.connected) return cb()
            if (++tries > 100) return showError('Could not connect. Please try again.')
            setTimeout(wait, 100)
        })()
    }

    // "..." bubble with Evan's photo while he types. Hides itself if the stop signal is lost.
    var adminTypingTimer = null
    function setAdminTyping(on) {
        clearTimeout(adminTypingTimer)
        typingEl.classList.toggle('on', Boolean(on))
        if (on) {
            msgs.appendChild(typingEl) // keep it below the newest message
            scrollDown()
            adminTypingTimer = setTimeout(function () {
                setAdminTyping(false)
            }, 8000)
        }
    }

    function connect() {
        if (socket) return
        socket = { connected: false, emit: function () {} } // placeholder while socket.io loads
        loadSocketIo(function (io) {
            socket = io(BASE + '/visitor', {
                auth: function (cb) {
                    var s = getStore(STORE_KEY) || {}
                    var tz = ''
                    try {
                        tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
                    } catch (e) {}
                    cb({ visitorId: s.visitorId, token: s.token, pageUrl: location.href, referrer: document.referrer, timeZone: tz })
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
                session = { visitorId: data.visitorId, token: data.token }
                setStore(STORE_KEY, session)
                contact = data.contact || {}
                Array.prototype.slice.call(msgs.querySelectorAll('.m,.stamp,.card,.actions')).forEach(function (n) {
                    n.remove()
                })
                lastTs = 0
                renderIntro()
                hasMessages = data.messages.length > 0
                data.messages.forEach(function (m) {
                    addBubble(m)
                })
                if (hasMessages) contactAsked = true // don't nag returning visitors
                if (isOpen()) {
                    socket.emit('read')
                    setUnread(0)
                } else {
                    setUnread(data.unread || 0)
                }
            })
            socket.on('message', function (m) {
                addBubble(m)
                if (m.sender !== 'admin') return
                setAdminTyping(false)
                if (isOpen() && !document.hidden) socket.emit('read')
                else {
                    setUnread(unread + 1)
                    chime()
                    flashTitle()
                }
                if (m.auto && !contact.email) askContact("Leave your email and I'll follow up there if you need to go.")
            })
            socket.on('admin_typing', setAdminTyping)
        })
    }

    // ------------------------------------------------------------ open / close

    function open(source) {
        hideTeaser()
        panel.classList.add('open')
        launcher.classList.add('open')
        launcher.setAttribute('aria-label', 'Close chat')
        if (isPhone()) {
            backdrop.classList.add('open')
            document.documentElement.style.overflow = 'hidden'
        }
        setStore(OPEN_KEY, true, sessionStorage)
        setStore(TEASED_KEY, true, sessionStorage)
        setUnread(0)
        stopFlash()
        track('dmg_chat_open', { chat_open_source: source || 'button' })
        if (!socket) {
            renderIntroOnce()
            connect()
        } else if (socket.connected) socket.emit('read')
        setTimeout(function () {
            if (!isPhone()) input.focus()
            scrollDown()
        }, 50)
    }

    var introShown = false
    function renderIntroOnce() {
        if (introShown || msgs.querySelector('.actions')) return
        introShown = true
        renderIntro()
    }

    function close() {
        panel.classList.remove('open', 'full')
        panel.style.transform = ''
        launcher.classList.remove('open')
        launcher.setAttribute('aria-label', 'Open chat with ' + firstName)
        backdrop.classList.remove('open')
        document.documentElement.style.overflow = ''
        setStore(OPEN_KEY, false, sessionStorage)
    }

    launcher.addEventListener('click', function () {
        isOpen() ? close() : open('button')
    })
    backdrop.addEventListener('click', close)
    $('.min').addEventListener('click', close)
    $('.tclose').addEventListener('click', function () {
        hideTeaser()
        track('dmg_chat_teaser_dismissed')
    })
    $('.ttext').addEventListener('click', function () {
        open('teaser')
    })

    // Phones: swipe the sheet down to close; grow to full height while typing.
    var dragY = null
    function dragStart(e) {
        if (!isPhone()) return
        dragY = e.touches[0].clientY
    }
    function dragMove(e) {
        if (dragY === null) return
        var dy = Math.max(0, e.touches[0].clientY - dragY)
        panel.style.transform = 'translateY(' + dy + 'px)'
    }
    function dragEnd(e) {
        if (dragY === null) return
        var dy = e.changedTouches[0].clientY - dragY
        dragY = null
        panel.style.transform = ''
        if (dy > 90) close()
    }
    ;[$('.handle'), $('.head')].forEach(function (el) {
        el.addEventListener('touchstart', dragStart, { passive: true })
        el.addEventListener('touchmove', dragMove, { passive: true })
        el.addEventListener('touchend', dragEnd)
    })
    input.addEventListener('focus', function () {
        if (isPhone()) panel.classList.add('full')
    })
    input.addEventListener('blur', function () {
        setTimeout(function () {
            if (root.activeElement !== input) panel.classList.remove('full')
        }, 150)
    })

    // ------------------------------------------------------------ composing

    input.addEventListener('input', function () {
        input.style.height = 'auto'
        input.style.height = Math.min(input.scrollHeight, 120) + 'px'
        sendBtn.disabled = !input.value.trim()
        notifyTyping()
    })
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isPhone()) {
            e.preventDefault()
            submit(e)
        }
    })

    var typingTimer = null
    var typingSent = false
    var typingSentAt = 0
    function notifyTyping() {
        if (!socket || !socket.connected) return
        // Re-send every few seconds so a long message keeps the bubble showing on Evan's side.
        if (!typingSent || Date.now() - typingSentAt > 3000) {
            typingSent = true
            typingSentAt = Date.now()
            socket.emit('typing', true)
        }
        clearTimeout(typingTimer)
        typingTimer = setTimeout(stopTyping, 2500)
    }
    function stopTyping() {
        clearTimeout(typingTimer)
        if (typingSent && socket && socket.connected) socket.emit('typing', false)
        typingSent = false
    }

    function sendMessage(body, attachment) {
        var bubble = addBubble({ sender: 'visitor', body: body, attachment: attachment, created_at: Date.now() }, { pending: true })
        withSocket(function () {
            socket.timeout(10000).emit(
                'message',
                { body: body, attachmentId: attachment && attachment.id, pageUrl: location.href, hp: honeypot.value },
                function (err, res) {
                    if (err || (res && res.error)) {
                        showError((res && res.error) || 'Message not sent. Check your connection and try again.')
                        return
                    }
                    bubble.classList.remove('pending')
                    showError('')
                    track('dmg_chat_message_sent', { chat_first_message: !hasMessages })
                    var first = !hasMessages
                    hasMessages = true
                    if (first && !contactAsked) askContact()
                }
            )
        })
    }

    function submit(e) {
        e.preventDefault()
        var body = input.value.trim()
        if (!body) return
        input.value = ''
        input.style.height = 'auto'
        sendBtn.disabled = true
        stopTyping()
        sendMessage(body)
    }
    form.addEventListener('submit', submit)

    // 11. Photo / PDF sharing.
    $('.attach').addEventListener('click', function () {
        fileInput.click()
    })
    fileInput.addEventListener('change', function () {
        var file = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!file) return
        if (file.size > 10 * 1024 * 1024) return showError('Files can be up to 10 MB.')
        showError('Uploading ' + file.name + '…')
        withSocket(function () {
            var s = getStore(STORE_KEY) || {}
            fetch(BASE + '/api/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Visitor-Id': s.visitorId,
                    'X-Visitor-Token': s.token,
                    'X-File-Name': encodeURIComponent(file.name)
                },
                body: file
            })
                .then(function (r) {
                    return r.json().then(function (j) {
                        if (!r.ok) throw new Error(j.error || 'Upload failed')
                        return j
                    })
                })
                .then(function (up) {
                    showError('')
                    sendMessage('', up)
                    track('dmg_chat_file_sent')
                })
                .catch(function (err) {
                    showError(err.message || 'Upload failed')
                })
        })
    })

    // ------------------------------------------------------------ boot

    function boot() {
        var hidden =
            onPaths(cfg.hidePaths) ||
            cfg.hideOn.some(function (c) {
                return document.body.classList.contains(c)
            })
        if (hidden && !/dmgchat=/.test(location.hash)) return
        document.body.appendChild(host)

        // Link from a follow-up email: "#dmgchat=<id>.<token>" restores the conversation.
        var m = location.hash.match(/dmgchat=([0-9a-f-]{36})\.([\w-]+)/)
        if (m) {
            setStore(STORE_KEY, { visitorId: m[1], token: m[2] })
            try {
                history.replaceState(null, '', location.pathname + location.search)
            } catch (e) {}
            return open('email_link')
        }
        if (getStore(OPEN_KEY, sessionStorage) && !isPhone()) return open('restore')
        // Returning visitors connect quietly so they see replies and unread badges.
        if (session.visitorId) connect()
        if (teaserAllowedHere() && !session.visitorId) {
            setTimeout(showTeaser, cfg.teaserDelay * 1000)
        }
    }

    // 5. Keep the site fast: wait until the page has finished loading and the browser is idle.
    function whenIdle() {
        ;(window.requestIdleCallback || function (fn) {
            setTimeout(fn, 1)
        })(boot, { timeout: 3000 })
    }
    if (document.readyState === 'complete') whenIdle()
    else window.addEventListener('load', whenIdle)
})()
