const nodemailer = require('nodemailer')
const Anthropic = require('@anthropic-ai/sdk')

// ---------------------------------------------------------------------------
// Email (SMTP). Used to email replies to visitors who left, and as a backup
// alert to you. Everything is skipped quietly when SMTP isn't configured.
// ---------------------------------------------------------------------------

const transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT) || 587,
          secure: Number(process.env.SMTP_PORT) === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
      })
    : null

const MAIL_FROM = process.env.MAIL_FROM || process.env.SMTP_USER
const emailEnabled = Boolean(transport && MAIL_FROM)

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function sendEmail({ to, subject, text, html, replyTo }) {
    if (!emailEnabled || !to) return false
    try {
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

Write the single next message Evan should send, in his voice: warm, confident, concise, first person ("I"), like a text message from the founder. Usually 1-3 short sentences. Answer what the visitor asked, then move the conversation forward with one question or a next step (often booking a discovery call). Never invent prices, timelines, past clients or facts that are not in the business notes; if the visitor asks for something you don't know, say Evan will confirm the details. Do not use emoji or markdown. Output only the message text.`

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
                    content: `Visitor details:\n${visitor || 'Unknown'}\n\nConversation so far:\n${transcript}\n\nDraft Evan's next message.`
                }
            ]
        })
        if (response.stop_reason === 'refusal') return { error: 'No suggestion for this one. Please write the reply yourself.' }
        const text = response.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('')
            .trim()
        return text ? { text } : { error: 'No suggestion returned.' }
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

module.exports = {
    emailEnabled,
    sendEmail,
    emailLayout,
    messagesHtml,
    escapeHtml,
    addToMailerLite,
    suggestReply,
    aiEnabled: Boolean(anthropic),
    mailerliteEnabled: Boolean(MAILERLITE_API_KEY)
}
