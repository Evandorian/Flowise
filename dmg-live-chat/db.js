const path = require('path')
const fs = require('fs')
const Database = require('better-sqlite3')

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })

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
`)

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
               (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
        FROM conversations c
        WHERE c.status = ? AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
        ORDER BY c.last_message_at DESC
        LIMIT 200
    `),
    insertMessage: db.prepare('INSERT INTO messages (conversation_id, sender, body, created_at) VALUES (?, ?, ?, ?)'),
    getMessages: db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500'),
    bumpVisitorMessage: db.prepare(
        "UPDATE conversations SET last_message_at = ?, admin_unread = admin_unread + 1, status = 'open' WHERE id = ?"
    ),
    bumpAdminMessage: db.prepare('UPDATE conversations SET last_message_at = ?, visitor_unread = visitor_unread + 1 WHERE id = ?'),
    markAdminRead: db.prepare('UPDATE conversations SET admin_unread = 0 WHERE id = ?'),
    markVisitorRead: db.prepare('UPDATE conversations SET visitor_unread = 0 WHERE id = ?'),
    setStatus: db.prepare('UPDATE conversations SET status = ? WHERE id = ?'),
    deleteConversation: db.prepare('DELETE FROM conversations WHERE id = ?'),
    totalUnread: db.prepare('SELECT COALESCE(SUM(admin_unread), 0) AS n FROM conversations'),
    addPushSubscription: db.prepare(
        'INSERT INTO push_subscriptions (endpoint, subscription, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription'
    ),
    listPushSubscriptions: db.prepare('SELECT * FROM push_subscriptions'),
    deletePushSubscription: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')
}

module.exports = {
    db,

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
            stmts.touchConversation.run({ id, page_url: pageUrl || null, ip })
            return stmts.getConversation.get(id)
        }
        stmts.insertConversation.run({ id, page_url: pageUrl, referrer, user_agent: userAgent, ip, now: Date.now() })
        return stmts.getConversation.get(id)
    },

    updateContact(id, { name, email }) {
        stmts.updateContact.run({ id, name: name || null, email: email || null })
        return stmts.getConversation.get(id)
    },

    listConversations(status = 'open') {
        return stmts.listConversations.all(status)
    },

    addMessage(conversationId, sender, body) {
        const now = Date.now()
        const info = stmts.insertMessage.run(conversationId, sender, body, now)
        if (sender === 'visitor') stmts.bumpVisitorMessage.run(now, conversationId)
        if (sender === 'admin') stmts.bumpAdminMessage.run(now, conversationId)
        return { id: Number(info.lastInsertRowid), conversation_id: conversationId, sender, body, created_at: now }
    },

    getMessages(conversationId) {
        return stmts.getMessages.all(conversationId)
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
        stmts.deleteConversation.run(id)
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
    }
}
