const nodemailer = require('nodemailer')
const Anthropic = require('@anthropic-ai/sdk')

// ---------------------------------------------------------------------------
// Email. Used to email replies to visitors who left, and as a backup alert to
// you. Sends through Resend's HTTP API when RESEND_API_KEY is set (needed on
// hosts that block SMTP ports, like Sevalla), otherwise SMTP. Everything is
// skipped quietly when neither is configured.
// ---------------------------------------------------------------------------

const RESEND_API_KEY = process.env.RESEND_API_KEY

const transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: Number(process.env.SMTP_PORT) === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      })
    : null

const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER
const emailEnabled = Boolean((RESEND_API_KEY || transport) && MAIL_FROM)

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function sendEmail({ to, subject, text, html, replyTo }) {
    if (!emailEnabled || !to) return false
    try {
        if (RESEND_API_KEY) {
            const res = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html, reply_to: replyTo || undefined }),
                signal: AbortSignal.timeout(15000)
            })
            if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`)
            console.log(`[email] sent via Resend: "${subject}"`)
            return true
        }
        await transport.sendMail({ from: MAIL_FROM, to, subject, text, html, replyTo })
        return true
    } catch (err) {
        console.error('[email] failed:', err.message)
        return false
    }
}

function emailLayout({ heading, bodyHtml, buttonText, buttonUrl, footer }) {
    return `<!doctype html><html><body style="margin:0;background:#f7f8f9;font-family:Arial,Helvetica,sans-serif;color:#1c1f27">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
  <div style="font-weight:800;letter-spacing:.14em;font-size:13px;color:#0e1015;margin-bottom:20px">DORIAN MEDIA</div>
  <div style="background:#ffffff;border:1px solid #ebeced;border-radius:16px;padding:24px">
    <h1 style="margin:0 0 16px;font-size:20px;color:#0e1015">${escapeHtml(heading)}</h1>
    ${bodyHtml}
    ${
        buttonUrl
            ? `<p style="margin:24px 0 0"><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#28b0ff;color:#0e1015;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:999px">${escapeHtml(buttonText)}</a></p>`
            : ''
    }
  </div>
  <p style="font-size:12px;color:#5b6474;margin:16px 4px 0">${footer || ''}</p>
</div></body></html>`
}

function messagesHtml(messages, adminName) {
    return messages
        .map((m) => {
            const who = m.sender === 'admin' ? adminName : 'You'
            const file = m.attachment ? `<br><em>Attachment: ${escapeHtml(m.attachment.name)}</em>` : ''
            return `<p style="margin:0 0 12px;line-height:1.5"><strong>${escapeHtml(who)}:</strong> ${escapeHtml(m.body).replace(/\n/g, '<br>')}${file}</p>`
        })
        .join('')
}

// ---------------------------------------------------------------------------
// MailerLite: add chat contacts to a group.
// ---------------------------------------------------------------------------

const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY
const MAILERLITE_GROUP_ID = process.env.MAILERLITE_GROUP_ID

async function addToMailerLite({ name, email, pageUrl }) {
    if (!MAILERLITE_API_KEY || !email) return { ok: false, skipped: true }
    const [first, ...rest] = (name || '').trim().split(/\s+/)
    const fields = { chat_page: pageUrl || '', chat_date: new Date().toISOString().slice(0, 10) }
    if (first) fields.name = first
    if (rest.length) fields.last_name = rest.join(' ')
    const body = { email, fields }
    if (MAILERLITE_GROUP_ID) body.groups = [MAILERLITE_GROUP_ID]
    try {
        const res = await fetch(process.env.MAILERLITE_API_URL || 'https://connect.mailerlite.com/api/subscribers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${MAILERLITE_API_KEY}` },
            body: JSON.stringify(body)
        })
        if (!res.ok) {
            console.error('[mailerlite] failed:', res.status, await res.text().catch(() => ''))
            return { ok: false }
        }
        return { ok: true }
    } catch (err) {
        console.error('[mailerlite] failed:', err.message)
        return { ok: false }
    }
}

// ---------------------------------------------------------------------------
// AI-suggested replies (Claude). You always review and edit before sending.
// ---------------------------------------------------------------------------

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null
const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5'

const DEFAULT_BUSINESS_CONTEXT = `Dorian Media Group (dorianmediagroup.com) is a creative agency and production company in Newport Beach, CA and Kansas City, founded by Evan Dorian (Founder / Creative Director).
Services: AI consulting (AI systems, automation and workflows), brand development (strategy, identity, messaging, creative direction), website design (high-performing, conversion-focused sites), photography (campaigns, events, products, teams, headshots), video production, and digital marketing (SEO, content, ads).
Process: Discovery, Strategy, Execution.
Book a free discovery call: https://dorianmediagroup.com/book-a-discovery-call/
Portfolio: https://dorianmediagroup.com/recent-work/`

const BUSINESS_CONTEXT = process.env.BUSINESS_CONTEXT || DEFAULT_BUSINESS_CONTEXT

const SUGGEST_SYSTEM = `You draft live-chat replies for Evan Dorian to send to visitors of his agency's website. Evan reviews and edits every draft before sending.

About the business:
${BUSINESS_CONTEXT}

Write two different options for the next message Evan should send, in his voice: warm, confident, concise, first person ("I"), like a text message from the founder. Usually 1-3 short sentences. Answer what the visitor asked, then move the conversation forward with one question or a next step (often booking a discovery call). Never invent prices, timelines, past clients or facts that are not in the business notes; if the visitor asks for something you don't know, say Evan will confirm the details. Make the second option take a different angle from the first (for example, one answers in more detail and one moves straight to a call). Do not use emoji or markdown. Output only the two messages, separated by a line containing only ---`

async function suggestReply(conversation, messages) {
    if (!anthropic) return { error: 'AI suggestions are not set up. Add ANTHROPIC_API_KEY to the server settings.' }
    const transcript = messages
        .slice(-30)
        .map((m) => `${m.sender === 'admin' ? 'Evan' : 'Visitor'}: ${m.body}${m.attachment ? ` [sent a file: ${m.attachment.name}]` : ''}`)
        .join('\n')
    const visitor = [conversation.name && `Name: ${conversation.name}`, conversation.page_url && `Viewing: ${conversation.page_url}`]
        .filter(Boolean)
        .join('\n')
    try {
        const response = await anthropic.beta.messages.create({
            model: AI_MODEL,
            max_tokens: 1024,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'low' },
            system: SUGGEST_SYSTEM,
            messages: [
                {
                    role: 'user',
                    content: `Visitor details:\n${visitor || 'Unknown'}\n\nConversation so far:\n${transcript}\n\nDraft Evan's next message (two options).`
                }
            ]
        })
        if (response.stop_reason === 'refusal') return { error: 'No suggestion for this one. Please write the reply yourself.' }
        const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim()
        const options = text
            .split(/^\s*---+\s*$/m)
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 2)
        return options.length ? { text: options[0], options } : { error: 'No suggestion returned.' }
    } catch (err) {
        if (err instanceof Anthropic.RateLimitError) return { error: 'AI is busy. Try again in a moment.' }
        if (err instanceof Anthropic.AuthenticationError) return { error: 'The ANTHROPIC_API_KEY on the server is invalid.' }
        if (err instanceof Anthropic.APIError) {
            console.error('[ai] error', err.status, err.message)
            return { error: 'Could not get a suggestion right now.' }
        }
        console.error('[ai] error', err)
        return { error: 'Could not get a suggestion right now.' }
    }
}

// ---------------------------------------------------------------------------
// Visitor location (approximate, from their IP address). Uses Cloudflare's
// location headers when present, otherwise a free lookup service.
// Set GEO_LOOKUP=off to turn it off.
// ---------------------------------------------------------------------------

const GEO_ENABLED = process.env.GEO_LOOKUP !== 'off'
const GEO_URL = process.env.GEO_LOOKUP_URL || 'https://ipwho.is/{ip}'
const geoCache = new Map()

function isPrivateIp(ip) {
    return !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fc|fd|fe80:|::ffff:127\.)/i.test(ip)
}

function formatPlace({ city, region, country, countryCode }) {
    // "Kansas City, Missouri" for the US, "Toronto, Ontario, Canada" elsewhere.
    const parts = [city, region !== city ? region : null]
    if (country && countryCode !== 'US') parts.push(country)
    else if (!city && !region && country) parts.push(country)
    return parts.filter(Boolean).join(', ') || null
}

function locationFromHeaders(headers) {
    const decode = (v) => {
        try {
            return v ? decodeURIComponent(String(v)) : null
        } catch {
            return String(v)
        }
    }
    const city = decode(headers['cf-ipcity'])
    const region = decode(headers['cf-region'])
    const countryCode = headers['cf-ipcountry']
    if (!city && !region) return null
    return formatPlace({ city, region, country: countryCode, countryCode })
}

async function lookupLocation(ip) {
    if (!GEO_ENABLED || isPrivateIp(ip)) return null
    if (geoCache.has(ip)) return geoCache.get(ip)
    try {
        const res = await fetch(GEO_URL.replace('{ip}', encodeURIComponent(ip)), { signal: AbortSignal.timeout(4000) })
        if (!res.ok) return null
        const d = await res.json()
        if (d.success === false || d.status === 'fail') return null
        const place = formatPlace({
            city: d.city,
            region: d.region || d.regionName || d.region_name,
            country: d.country || d.country_name,
            countryCode: d.country_code || d.countryCode
        })
        if (geoCache.size > 5000) geoCache.clear()
        geoCache.set(ip, place)
        return place
    } catch (err) {
        console.error('[geo] lookup failed', err.message)
        return null
    }
}

module.exports = {
    emailEnabled,
    sendEmail,
    emailLayout,
    messagesHtml,
    escapeHtml,
    addToMailerLite,
    suggestReply,
    lookupLocation,
    locationFromHeaders,
    aiEnabled: Boolean(anthropic),
    mailerliteEnabled: Boolean(MAILERLITE_API_KEY)
}
