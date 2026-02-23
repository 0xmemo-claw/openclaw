import type { PollInput } from "../polls.js";
import type { StoredMessage, ChatSummary } from "./whatsapp-message-store.js";
import { formatCliCommand } from "../cli/command-format.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
  fetchMessageHistory?: (chatJid: string, count: number) => Promise<void>;
  getMessages?: (chatJid: string, limit?: number) => Promise<StoredMessage[]>;
  searchMessages?: (query: string, chatJid?: string, limit?: number) => Promise<StoredMessage[]>;
  listChats?: () => Promise<ChatSummary[]>;
  fetchAllGroups?: () => Promise<Array<{ jid: string; subject: string; participants?: number }>>;
  getContactName?: (jid: string) => string | undefined;
  setContactName?: (jid: string, name: string) => void;
  resolveContactByName?: (query: string) => Array<{ jid: string; name: string }>;
};

let _currentListener: ActiveWebListener | null = null;

// Use globalThis to ensure singleton state across code-split chunks.
// Without this, each bundled chunk gets its own Map instance, so
// setActiveWebListener (in the monitor chunk) and requireActiveWebListener
// (in the reply/tool chunk) operate on different Maps.
const GLOBAL_KEY = "__openclaw_web_listeners__";
const listeners: Map<string, ActiveWebListener> =
  ((globalThis as Record<string, unknown>)[GLOBAL_KEY] as Map<string, ActiveWebListener>) ??
  (() => {
    const m = new Map<string, ActiveWebListener>();
    (globalThis as Record<string, unknown>)[GLOBAL_KEY] = m;
    return m;
  })();

export function resolveWebAccountId(accountId?: string | null): string {
  return (accountId ?? "").trim() || DEFAULT_ACCOUNT_ID;
}

export function requireActiveWebListener(accountId?: string | null): {
  accountId: string;
  listener: ActiveWebListener;
} {
  const id = resolveWebAccountId(accountId);
  const listener = listeners.get(id) ?? null;
  if (!listener) {
    throw new Error(
      `No active WhatsApp Web listener (account: ${id}). Start the gateway, then link WhatsApp with: ${formatCliCommand(`openclaw channels login --channel whatsapp --account ${id}`)}.`,
    );
  }
  return { accountId: id, listener };
}

export function setActiveWebListener(listener: ActiveWebListener | null): void;
export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void;
export function setActiveWebListener(
  accountIdOrListener: string | ActiveWebListener | null | undefined,
  maybeListener?: ActiveWebListener | null,
): void {
  const { accountId, listener } =
    typeof accountIdOrListener === "string"
      ? { accountId: accountIdOrListener, listener: maybeListener ?? null }
      : {
          accountId: DEFAULT_ACCOUNT_ID,
          listener: accountIdOrListener ?? null,
        };

  const id = resolveWebAccountId(accountId);
  if (!listener) {
    listeners.delete(id);
  } else {
    listeners.set(id, listener);
  }
  if (id === DEFAULT_ACCOUNT_ID) {
    _currentListener = listener;
  }
}

export function getActiveWebListener(accountId?: string | null): ActiveWebListener | null {
  const id = resolveWebAccountId(accountId);
  return listeners.get(id) ?? null;
}
