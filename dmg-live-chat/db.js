const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const db = new Database(path.join(DATA_DIR, 'chat.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        name TEXT,
        email TEXT,
        page_url TEXT,
        referrer TEXT,
        user_agent TEXT,
        ip TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        last_message_at INTEGER NOT NULL,
        admin_unread INTEGER NOT NULL DEFAULT 0,
        visitor_unread INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        sender TEXT NOT NULL CHECK (sender IN ('visitor', 'admin', 'system')),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
    CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        subscription TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blocks (
        kind TEXT NOT NULL CHECK (kind IN ('visitor', 'ip')),
        value TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, value)
    );
`)

// Columns added after the first release. SQLite has no "ADD COLUMN IF NOT EXISTS".
function addColumn(table, column, definition) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
addColumn('messages', 'attachment', 'TEXT')
addColumn('messages', 'auto', 'INTEGER NOT NULL DEFAULT 0')
addColumn('conversations', 'mailerlite_status', 'TEXT')
addColumn('conversations', 'auto_replied_at', 'INTEGER')
addColumn('conversations', 'last_emailed_message_id', 'INTEGER NOT NULL DEFAULT 0')
addColumn('conversations', 'admin_alerted_at', 'INTEGER')
addColumn('conversations', 'location', 'TEXT')
addColumn('conversations', 'location_ip', 'TEXT')
addColumn('conversations', 'timezone', 'TEXT')

const stmts = {
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    getConversation: db.prepare('SELECT * FROM conversations WHERE id = ?'),
    insertConversation: db.prepare(`
        INSERT INTO conversations (id, page_url, referrer, user_agent, ip, created_at, last_message_at)
        VALUES (@id, @page_url, @referrer, @user_agent, @ip, @now, @now)
    `),
    touchConversation: db.prepare('UPDATE conversations SET page_url = COALESCE(@page_url, page_url), ip = @ip WHERE id = @id'),
    updateContact: db.prepare('UPDATE conversations SET name = COALESCE(@name, name), email = COALESCE(@email, email) WHERE id = @id'),
    listConversations: db.prepare(`
        SELECT c.*, (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_message,
               (SELECT sender FROM messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c
        WHERE c.status = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
        ORDER BY c.last_message_at DESC
        LIMIT 200
    `),
    insertMessage: db.prepare(
        'INSERT INTO messages (conversation_id, sender, body, created_at, attachment, auto) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    getMessages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500'),
    getMessagesAfter: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC'),
    lastMessageBy: db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND sender = ? ORDER BY id DESC LIMIT 1'),
    bumpVisitorMessage: db.prepare(
        "UPDATE conversations SET last_message_at = ?, admin_unread = admin_unread + 1, status = 'open' WHERE id = ?"
    ),
    bumpAdminMessage: db.prepare('UPDATE conversations SET last_message_at = ?, visitor_unread = visitor_unread + 1 WHERE id = ?'),
    markAdminRead: db.prepare('UPDATE conversations SET admin_unread = 0 WHERE id = ?'),
    markVisitorRead: db.prepare('UPDATE conversations SET visitor_unread = 0 WHERE id = ?'),
    setStatus: db.prepare('UPDATE conversations SET status = ? WHERE id = ?'),
    setField: {
        mailerlite_status: db.prepare('UPDATE conversations SET mailerlite_status = ? WHERE id = ?'),
        auto_replied_at: db.prepare('UPDATE conversations SET auto_replied_at = ? WHERE id = ?'),
        last_emailed_message_id: db.prepare('UPDATE conversations SET last_emailed_message_id = ? WHERE id = ?'),
        admin_alerted_at: db.prepare('UPDATE conversations SET admin_alerted_at = ? WHERE id = ?'),
        location: db.prepare('UPDATE conversations SET location = ? WHERE id = ?'),
        location_ip: db.prepare('UPDATE conversations SET location_ip = ? WHERE id = ?'),
        timezone: db.prepare('UPDATE conversations SET timezone = ? WHERE id = ?')
    },
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
    deleteUploadsFor: db.prepare('DELETE FROM uploads WHERE conversation_id = ? RETURNING id'),
    totalUnread: db.prepare('SELECT COALESCE(SUM(admin_unread), 0) AS n FROM conversations'),
    addPushSubscription: db.prepare(
        'INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription'
    ),
    listPushSubscriptions: db.prepare('SELECT * FROM push_subscriptions'),
    deletePushSubscription: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
    addUpload: db.prepare(
        'INSERT INTO uploads (id, conversation_id, file_name, mime_type, size, created_at) VALUES (@id, @conversation_id, @file_name, @mime_type, @size, @created_at)'
    ),
    getUpload: db.prepare('SELECT * FROM uploads WHERE id = ?'),
    addBlock: db.prepare('INSERT OR IGNORE INTO blocks (kind, value, created_at) VALUES (?, ?, ?)'),
    isBlocked: db.prepare("SELECT 1 FROM blocks WHERE (kind = 'visitor' AND value = ?) OR (kind = 'ip' AND value = ?) LIMIT 1")
}

function parseMessage(row) {
    if (!row) return row
    return { ...row, auto: Boolean(row.auto), attachment: row.attachment ? JSON.parse(row.attachment) : null }
}

module.exports = {
    db,
    DATA_DIR,
    UPLOAD_DIR,

    getSetting(key) {
        const row = stmts.getSetting.get(key)
        return row ? row.value : null
    },

    setSetting(key, value) {
        stmts.setSetting.run(key, value)
    },

    getConversation(id) {
        return stmts.getConversation.get(id)
    },

    ensureConversation({ id, pageUrl, referrer, userAgent, ip }) {
        const existing = stmts.getConversation.get(id)
        if (existing) {
            stmts.touchConversation.run({ id, page_url: pageUrl || null, ip: ip ?? null })
            return stmts.getConversation.get(id)
        }
        stmts.insertConversation.run({
            id,
            page_url: pageUrl ?? null,
            referrer: referrer ?? null,
            user_agent: userAgent ?? null,
            ip: ip ?? null,
            now: Date.now()
        })
        return stmts.getConversation.get(id)
    },

    updateContact(id, { name, email }) {
        stmts.updateContact.run({ id, name: name || null, email: email || null })
        return stmts.getConversation.get(id)
    },

    setField(id, field, value) {
        stmts.setField[field].run(value, id)
    },

    listConversations(status = 'open') {
        return stmts.listConversations.all(status)
    },

    addMessage(conversationId, sender, body, { attachment = null, auto = false } = {}) {
        const now = Date.now()
        const info = stmts.insertMessage.run(
            conversationId,
            sender,
            body,
            now,
            attachment ? JSON.stringify(attachment) : null,
            auto ? 1 : 0
        )
        if (sender === 'visitor') stmts.bumpVisitorMessage.run(now, conversationId)
        if (sender === 'admin') stmts.bumpAdminMessage.run(now, conversationId)
        return { id: Number(info.lastInsertRowid), conversation_id: conversationId, sender, body, created_at: now, attachment, auto }
    },

    getMessages(conversationId) {
        return stmts.getMessages.all(conversationId).map(parseMessage)
    },

    getMessagesAfter(conversationId, afterId) {
        return stmts.getMessagesAfter.all(conversationId, afterId).map(parseMessage)
    },

    lastMessageBy(conversationId, sender) {
        return parseMessage(stmts.lastMessageBy.get(conversationId, sender))
    },

    markAdminRead(id) {
        stmts.markAdminRead.run(id)
    },

    markVisitorRead(id) {
        stmts.markVisitorRead.run(id)
    },

    setStatus(id, status) {
        stmts.setStatus.run(status, id)
    },

    deleteConversation(id) {
        const uploads = stmts.deleteUploadsFor.all(id)
        stmts.deleteConversation.run(id)
        for (const u of uploads) fs.rm(path.join(UPLOAD_DIR, u.id), { force: true }, () => {})
    },

    totalUnread() {
        return stmts.totalUnread.get().n
    },

    addPushSubscription(sub) {
        stmts.addPushSubscription.run(sub.endpoint, JSON.stringify(sub), Date.now())
    },

    listPushSubscriptions() {
        return stmts.listPushSubscriptions.all().map((row) => JSON.parse(row.subscription))
    },

    deletePushSubscription(endpoint) {
        stmts.deletePushSubscription.run(endpoint)
    },

    addUpload(upload) {
        stmts.addUpload.run({ ...upload, created_at: Date.now() })
    },

    getUpload(id) {
        return stmts.getUpload.get(id)
    },

    block(kind, value) {
        if (value) stmts.addBlock.run(kind, value, Date.now())
    },

    isBlocked(visitorId, ip) {
        return Boolean(stmts.isBlocked.get(visitorId || '', ip || ''))
    }
}
