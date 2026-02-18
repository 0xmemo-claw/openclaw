import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { logVerbose } from "../globals.js";

export type StoredMessage = {
  id?: string;
  chatJid: string;
  senderJid?: string;
  text: string;
  timestamp: number;
  fromMe: boolean;
  pushName?: string;
  type: "text" | "media" | "location" | "other";
};

export type ChatSummary = {
  chatJid: string;
  lastMessage?: StoredMessage;
  messageCount: number;
  groupSubject?: string;
  participants?: number;
  contactName?: string;
};

const PERSIST_INTERVAL_MS = 30000; // 30 seconds
const DEFAULT_MAX_MESSAGES_PER_CHAT = 500;

/**
 * WhatsApp message store - in-memory + periodic JSON persistence
 */
export class WhatsAppMessageStore {
  private messageStore = new Map<string, StoredMessage[]>();
  private contactNames = new Map<string, string>(); // JID → display name
  private jidMappings = new Map<string, string>(); // LID/phoneJid → regular JID
  private persistTimer: NodeJS.Timeout | null = null;
  private isDirty = false;
  private readonly storePath: string;
  private readonly maxMessagesPerChat: number;

  constructor(options: { accountId: string; maxMessagesPerChat?: number }) {
    const dataDir = path.join(STATE_DIR, "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    this.storePath = path.join(dataDir, `whatsapp-messages-${options.accountId}.json`);
    this.maxMessagesPerChat = options.maxMessagesPerChat ?? DEFAULT_MAX_MESSAGES_PER_CHAT;
  }

  /**
   * Load messages from disk on startup
   */
  async load(): Promise<void> {
    if (!existsSync(this.storePath)) {
      logVerbose(`No existing message store found at ${this.storePath}, starting fresh`);
      return;
    }
    try {
      const data = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(data);

      // Handle backwards compatibility: old format is just Record<string, StoredMessage[]>
      // New format has { messages: {...}, contacts: {...} }
      let messagesData: Record<string, StoredMessage[]>;
      let contactsData: Record<string, string> = {};
      let mappingsData: Record<string, string> = {};

      if (parsed.messages && typeof parsed.messages === "object") {
        // New format
        messagesData = parsed.messages;
        contactsData = parsed.contacts ?? {};
        mappingsData = parsed.jidMappings ?? {};
      } else {
        // Old format - migrate it
        messagesData = parsed;
      }

      // Load messages
      for (const [chatJid, messages] of Object.entries(messagesData)) {
        this.messageStore.set(chatJid, messages);
      }

      // Load contacts
      for (const [jid, name] of Object.entries(contactsData)) {
        this.contactNames.set(jid, name);
      }

      // Load JID mappings (LID → regular JID)
      for (const [altJid, regularJid] of Object.entries(mappingsData)) {
        this.jidMappings.set(altJid, regularJid);
      }

      // Build contactNames from pushName fields if not already present
      for (const [chatJid, messages] of this.messageStore.entries()) {
        for (const msg of messages) {
          if (msg.pushName && !this.contactNames.has(chatJid)) {
            this.contactNames.set(chatJid, msg.pushName);
          }
          // Also track sender names in group chats
          if (msg.senderJid && msg.pushName && !this.contactNames.has(msg.senderJid)) {
            this.contactNames.set(msg.senderJid, msg.pushName);
          }
        }
      }

      logVerbose(
        `Loaded message store with ${this.messageStore.size} chats and ${this.contactNames.size} contacts from ${this.storePath}`,
      );
    } catch (err) {
      logVerbose(`Failed to load message store: ${String(err)}`);
    }
  }

  /**
   * Persist messages to disk
   */
  async persist(): Promise<void> {
    if (!this.isDirty) {
      return;
    }
    try {
      const messages: Record<string, StoredMessage[]> = {};
      for (const [chatJid, msgs] of Array.from(this.messageStore.entries())) {
        messages[chatJid] = msgs;
      }

      const contacts: Record<string, string> = {};
      for (const [jid, name] of Array.from(this.contactNames.entries())) {
        contacts[jid] = name;
      }

      const jidMappings: Record<string, string> = {};
      for (const [altJid, regularJid] of Array.from(this.jidMappings.entries())) {
        jidMappings[altJid] = regularJid;
      }

      const payload = { messages, contacts, jidMappings };
      await fs.writeFile(this.storePath, JSON.stringify(payload, null, 2), "utf8");
      this.isDirty = false;
      logVerbose(`Persisted message store to ${this.storePath}`);
    } catch (err) {
      logVerbose(`Failed to persist message store: ${String(err)}`);
    }
  }

  /**
   * Start periodic persistence
   */
  startPersistence(): void {
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setInterval(() => {
      void this.persist();
    }, PERSIST_INTERVAL_MS);
  }

  /**
   * Stop periodic persistence and do final save
   */
  async stopPersistence(): Promise<void> {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  /**
   * Store a message
   */
  storeMessage(msg: StoredMessage): void {
    const chatJid = msg.chatJid;
    let messages = this.messageStore.get(chatJid);
    if (!messages) {
      messages = [];
      this.messageStore.set(chatJid, messages);
    }

    // Deduplicate by message ID
    if (msg.id && messages.some((m) => m.id === msg.id)) {
      return;
    }

    // Track contact names from pushName
    if (msg.pushName) {
      if (!this.contactNames.has(chatJid)) {
        this.contactNames.set(chatJid, msg.pushName);
      }
      // Also track sender names in group chats
      if (msg.senderJid && !this.contactNames.has(msg.senderJid)) {
        this.contactNames.set(msg.senderJid, msg.pushName);
      }
    }

    // Add the message
    messages.push(msg);

    // Keep only last maxMessagesPerChat
    if (messages.length > this.maxMessagesPerChat) {
      messages.splice(0, messages.length - this.maxMessagesPerChat);
    }

    this.isDirty = true;
  }

  /**
   * Resolve a chatJid key — handles both JID format (123@s.whatsapp.net)
   * and E.164 format (+123 or 123). Tries exact match first, then
   * attempts to match by stripping suffixes/prefixes.
   */
  private resolveStoreKey(chatJid: string): string | undefined {
    // Exact match
    if (this.messageStore.has(chatJid)) {
      return chatJid;
    }
    // If it looks like E.164, try appending @s.whatsapp.net
    const stripped = chatJid.replace(/^\+/, "");
    if (/^\d+$/.test(stripped)) {
      const jidKey = `${stripped}@s.whatsapp.net`;
      if (this.messageStore.has(jidKey)) {
        return jidKey;
      }
    }
    // If it looks like a JID, try stripping to E.164
    if (chatJid.endsWith("@s.whatsapp.net")) {
      const phone = chatJid.replace("@s.whatsapp.net", "");
      const e164Key = `+${phone}`;
      if (this.messageStore.has(e164Key)) {
        return e164Key;
      }
      if (this.messageStore.has(phone)) {
        return phone;
      }
    }
    return undefined;
  }

  /**
   * Get messages for a chat
   */
  getMessages(chatJid: string, limit?: number): StoredMessage[] {
    const key = this.resolveStoreKey(chatJid);
    const messages = key ? (this.messageStore.get(key) ?? []) : [];
    if (limit && limit > 0) {
      return messages.slice(-limit);
    }
    return messages;
  }

  /**
   * Search messages across all chats or within a specific chat
   */
  searchMessages(query: string, chatJid?: string, limit = 100): StoredMessage[] {
    const lowerQuery = query.toLowerCase();
    const results: StoredMessage[] = [];

    const source = chatJid
      ? [this.resolveStoreKey(chatJid)].filter(Boolean).map((k) => this.messageStore.get(k!) ?? [])
      : Array.from(this.messageStore.values());

    for (const messages of source) {
      for (const msg of messages) {
        if (msg.text.toLowerCase().includes(lowerQuery)) {
          results.push(msg);
          if (results.length >= limit) {
            return results;
          }
        }
      }
    }

    return results;
  }

  /**
   * List all chats with their last message
   */
  listChats(): ChatSummary[] {
    const chats: ChatSummary[] = [];
    for (const [chatJid, messages] of Array.from(this.messageStore.entries())) {
      chats.push({
        chatJid,
        lastMessage: messages.length > 0 ? messages[messages.length - 1] : undefined,
        messageCount: messages.length,
        contactName: this.contactNames.get(chatJid),
      });
    }
    // Sort by last message timestamp (most recent first)
    chats.sort((a, b) => {
      const aTime = a.lastMessage?.timestamp ?? 0;
      const bTime = b.lastMessage?.timestamp ?? 0;
      return bTime - aTime;
    });
    return chats;
  }

  /**
   * Get contact name for a JID
   */
  getContactName(jid: string): string | undefined {
    return this.contactNames.get(jid);
  }

  /**
   * Manually set a contact name for a JID.
   * Useful for contacts who haven't messaged yet (no pushName captured).
   */
  setContactName(jid: string, name: string): void {
    this.contactNames.set(jid, name);
    this.isDirty = true;
  }

  /**
   * Resolve contact by name (case-insensitive partial match)
   * Returns regular JIDs (not LIDs) when possible by cross-referencing with chat history
   */
  resolveContactByName(query: string): Array<{ jid: string; name: string }> {
    const lowerQuery = query.toLowerCase();
    const results: Array<{ jid: string; name: string }> = [];
    const seen = new Set<string>();

    // First pass: search contact names
    for (const [jid, name] of this.contactNames.entries()) {
      if (name.toLowerCase().includes(lowerQuery)) {
        // If this is a LID, try to find the corresponding regular JID from chat history
        const resolvedJid = jid.endsWith("@lid")
          ? (this.jidMappings.get(jid) ?? this.findChatJidForContact(name, jid) ?? jid)
          : jid;
        if (!seen.has(resolvedJid)) {
          results.push({ jid: resolvedJid, name });
          seen.add(resolvedJid);
        }
      }
    }

    // Second pass: also search group subjects
    for (const [chatJid, messages] of this.messageStore.entries()) {
      if (seen.has(chatJid)) {
        continue;
      }
      // Check if any message sender's pushName matches
      for (const msg of messages) {
        if (msg.pushName && msg.pushName.toLowerCase().includes(lowerQuery) && !msg.fromMe) {
          const contactJid = msg.senderJid ?? chatJid;
          if (!seen.has(contactJid)) {
            results.push({ jid: contactJid, name: msg.pushName });
            seen.add(contactJid);
          }
          break;
        }
      }
    }

    // Sort by exact match first, then by name length (shorter = better match)
    results.sort((a, b) => {
      const aExact = a.name.toLowerCase() === lowerQuery ? 1 : 0;
      const bExact = b.name.toLowerCase() === lowerQuery ? 1 : 0;
      if (aExact !== bExact) {
        return bExact - aExact;
      }
      return a.name.length - b.name.length;
    });

    return results;
  }

  /**
   * Try to find a regular chat JID for a LID by multiple strategies:
   * 1. Check if any regular JID chat has messages from someone with that name
   * 2. Cross-reference message content between LID and regular JID chats
   * 3. Match by overlapping message IDs or timestamps
   */
  private findChatJidForContact(contactName: string, lidJid?: string): string | undefined {
    const lowerName = contactName.toLowerCase();

    // Strategy 1: Check pushNames in regular JID chats
    for (const [chatJid, messages] of this.messageStore.entries()) {
      if (chatJid.endsWith("@lid") || chatJid.endsWith("@g.us")) {
        continue;
      }
      for (const msg of messages) {
        if (msg.pushName && msg.pushName.toLowerCase().includes(lowerName) && !msg.fromMe) {
          return chatJid;
        }
      }
    }

    // Strategy 2: If we have a LID, find a regular JID chat with overlapping messages
    if (lidJid) {
      const lidMessages = this.messageStore.get(lidJid) ?? [];
      if (lidMessages.length > 0) {
        // Get message IDs and texts from the LID chat
        const lidMsgIds = new Set(lidMessages.filter((m) => m.id).map((m) => m.id));
        const lidMsgTexts = new Set(
          lidMessages.map((m) => `${m.text}|${Math.floor(m.timestamp / 1000)}`),
        );

        for (const [chatJid, messages] of this.messageStore.entries()) {
          if (chatJid.endsWith("@lid") || chatJid.endsWith("@g.us") || chatJid === lidJid) {
            continue;
          }
          // Check for overlapping message IDs
          for (const msg of messages) {
            if (msg.id && lidMsgIds.has(msg.id)) {
              return chatJid;
            }
            // Check for same text + similar timestamp (within 2 seconds)
            if (lidMsgTexts.has(`${msg.text}|${Math.floor(msg.timestamp / 1000)}`)) {
              return chatJid;
            }
          }
        }
      }
    }

    return undefined;
  }

  /**
   * Update or add a contact name
   */
  updateContactName(jid: string, name: string): void {
    if (!name) {
      return;
    }
    this.contactNames.set(jid, name);
    this.isDirty = true;
  }

  /**
   * Add a JID mapping (e.g., LID → regular JID, or phoneJid → regular JID)
   * Used to cross-reference contacts that WhatsApp identifies by different IDs
   */
  addJidMapping(altJid: string, regularJid: string): void {
    if (!altJid || !regularJid || altJid === regularJid) {
      return;
    }
    this.jidMappings.set(altJid, regularJid);
    this.isDirty = true;
  }

  /**
   * Resolve an alternative JID (LID, phoneJid) to a regular JID
   */
  resolveJid(jid: string): string {
    return this.jidMappings.get(jid) ?? jid;
  }
}
