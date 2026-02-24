import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WAMessage,
  isJidGroup,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import P from "pino";
import path from "node:path";
import fs from "node:fs";
import open from "open";

import {
  initializeDatabase,
  storeMessage,
  storeChat,
  type Message as DbMessage,
} from "./database.ts";

const AUTH_DIR = path.join(import.meta.dirname, "..", "auth_info");

export type WhatsAppSocket = ReturnType<typeof makeWASocket>;

function parseMessageForDb(msg: WAMessage): DbMessage | null {
  if (!msg.message || !msg.key || !msg.key.remoteJid) {
    return null;
  }

  let content: string | null = null;
  const messageType = Object.keys(msg.message)[0];

  if (msg.message.conversation) {
    content = msg.message.conversation;
  } else if (msg.message.extendedTextMessage?.text) {
    content = msg.message.extendedTextMessage.text;
  } else if (msg.message.imageMessage?.caption) {
    content = `[Image] ${msg.message.imageMessage.caption}`;
  } else if (msg.message.videoMessage?.caption) {
    content = `[Video] ${msg.message.videoMessage.caption}`;
  } else if (msg.message.documentMessage?.caption) {
    content = `[Document] ${
      msg.message.documentMessage.caption ||
      msg.message.documentMessage.fileName ||
      ""
    }`;
  } else if (msg.message.audioMessage) {
    content = `[Audio]`;
  } else if (msg.message.stickerMessage) {
    content = `[Sticker]`;
  } else if (msg.message.locationMessage?.address) {
    content = `[Location] ${msg.message.locationMessage.address}`;
  } else if (msg.message.contactMessage?.displayName) {
    content = `[Contact] ${msg.message.contactMessage.displayName}`;
  } else if (msg.message.pollCreationMessage?.name) {
    content = `[Poll] ${msg.message.pollCreationMessage.name}`;
  }

  if (!content) {
    return null;
  }

  const timestampNum =
    typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp * 1000
      : typeof msg.messageTimestamp === "bigint"
      ? Number(msg.messageTimestamp) * 1000
      : Date.now();

  const timestamp = new Date(timestampNum);

  let senderJid: string | null | undefined = msg.key.participant;
  if (!msg.key.fromMe && !senderJid && !isJidGroup(msg.key.remoteJid)) {
    senderJid = msg.key.remoteJid;
  }
  if (msg.key.fromMe && !isJidGroup(msg.key.remoteJid)) {
    senderJid = null;
  }

  return {
    id: msg.key.id!,
    chat_jid: msg.key.remoteJid,
    sender: senderJid ? jidNormalizedUser(senderJid) : null,
    content: content,
    timestamp: timestamp,
    is_from_me: msg.key.fromMe ?? false,
  };
}

export async function startWhatsAppConnection(
  logger: P.Logger
): Promise<WhatsAppSocket> {
  initializeDatabase();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Using WA v${version.join(".")}, isLatest: ${isLatest}`);

  // In-memory cache for group metadata to avoid redundant server fetches
  const groupMetadataCache = new Map<string, any>();

  const sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: true,
    cachedGroupMetadata: async (jid: string) => groupMetadataCache.get(jid),
  });

  // Populate cache when group metadata is fetched
  sock.ev.on("groups.update", (updates) => {
    for (const update of updates) {
      if (update.id && groupMetadataCache.has(update.id)) {
        groupMetadataCache.set(update.id, { ...groupMetadataCache.get(update.id), ...update });
      }
    }
  });

  // Wait for the connection to be fully open before returning
  await new Promise<void>((resolve, reject) => {
    const onUpdate = (update: any) => {
      const { connection, lastDisconnect } = update;
      if (connection === "open") {
        sock.ev.off("connection.update", onUpdate);
        resolve();
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          sock.ev.off("connection.update", onUpdate);
          reject(new Error("Logged out"));
        }
        // otherwise keep waiting — Baileys will reconnect automatically
      }
    };
    sock.ev.on("connection.update", onUpdate);
  });

  sock.ev.process(async (events) => {
    if (events["connection.update"]) {
      const update = events["connection.update"];
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info(
          { qrCodeData: qr },
          "QR Code Received. Copy the qrCodeData string and use a QR code generator (e.g., online website) to display and scan it with your WhatsApp app."
        );
        // for now we roughly open the QR code in a browser
        await open(`https://quickchart.io/qr?text=${encodeURIComponent(qr)}`);
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        logger.warn(
          `Connection closed. Reason: ${
            DisconnectReason[statusCode as number] || "Unknown"
          }`,
          lastDisconnect?.error
        );
        if (statusCode !== DisconnectReason.loggedOut) {
          logger.info("Reconnecting...");
          startWhatsAppConnection(logger);
        } else {
          logger.error(
            "Connection closed: Logged Out. Please delete auth_info and restart."
          );
          process.exit(1);
        }
      } else if (connection === "open") {
        logger.info(`Connection opened. WA user: ${sock.user?.name}`);
        console.log("Logged as", sock.user?.name);
        // Give Baileys a moment to populate sock.contacts, then sync names to DB
        setTimeout(() => {
          const count = syncContactsFromSock(logger, sock);
          if (count > 0) {
            logger.info(`Auto-synced ${count} contact names on connection open.`);
          }
        }, 3000);
      }
    }

    if (events["creds.update"]) {
      await saveCreds();
      logger.info("Credentials saved.");
    }

    if (events["messaging-history.set"]) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events["messaging-history.set"];

      chats.forEach((chat) =>
        storeChat({
          jid: chat.id ?? '',
          name: chat.name,
          last_message_time: chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : undefined,
        })
      );

      // Sync contact names from history
      let contactCount = 0;
      contacts.forEach((contact) => {
        const name =
          contact.name || contact.notify || contact.verifiedName || null;
        if (contact.id && name) {
          storeChat({ jid: contact.id, name });
          contactCount++;
        }
      });
      if (contactCount > 0) {
        logger.info(`Synced ${contactCount} contact names from history.`);
      }

      let storedCount = 0;
      messages.forEach((msg) => {
        const parsed = parseMessageForDb(msg);
        if (parsed) {
          storeMessage(parsed);
          storedCount++;
        }
      });
      logger.info(`Stored ${storedCount} messages from history sync.`);
    }

    if (events["messages.upsert"]) {
      const { messages, type } = events["messages.upsert"];
      logger.info(
        { type, count: messages.length },
        "Received messages.upsert event"
      );

      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const parsed = parseMessageForDb(msg);
          if (parsed) {
            logger.info(
              {
                msgId: parsed.id,
                chatId: parsed.chat_jid,
                fromMe: parsed.is_from_me,
                sender: parsed.sender,
              },
              `Storing message: ${parsed.content.substring(0, 50)}...`
            );
            storeMessage(parsed);
          } else {
            logger.warn(
              { msgId: msg.key?.id, chatId: msg.key?.remoteJid },
              "Skipped storing message (parsing failed or unsupported type)"
            );
          }
        }
      }
    }

    if (events["chats.update"]) {
      logger.info(
        { count: events["chats.update"].length },
        "Received chats.update event"
      );
      for (const chatUpdate of events["chats.update"]) {
        storeChat({
          jid: chatUpdate.id!,
          name: chatUpdate.name,
          last_message_time: chatUpdate.conversationTimestamp
            ? new Date(Number(chatUpdate.conversationTimestamp) * 1000)
            : undefined,
        });
      }
    }

    if (events["contacts.upsert"]) {
      let synced = 0;
      for (const contact of events["contacts.upsert"]) {
        const name =
          contact.name || contact.notify || contact.verifiedName || null;
        if (contact.id && name) {
          storeChat({ jid: contact.id, name });
          synced++;
        }
      }
      if (synced > 0) {
        logger.info(`Synced ${synced} contacts from contacts.upsert.`);
      }
    }

    if (events["contacts.update"]) {
      let updated = 0;
      for (const contact of events["contacts.update"]) {
        const name =
          contact.name || contact.notify || contact.verifiedName || null;
        if (contact.id && name) {
          storeChat({ jid: contact.id, name });
          updated++;
        }
      }
      if (updated > 0) {
        logger.info(`Updated ${updated} contact names from contacts.update.`);
      }
    }
  });

  return sock;
}

function getMimetype(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimes: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
    ".txt": "text/plain",
  };
  return mimes[ext] || "application/octet-stream";
}

export async function sendWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  text: string
): Promise<WAMessage | void> {
  if (!sock || !sock.user) {
    logger.error(
      "Cannot send message: WhatsApp socket not connected or initialized."
    );
    return;
  }
  if (!recipientJid) {
    logger.error("Cannot send message: Recipient JID is missing.");
    return;
  }
  if (!text) {
    logger.error("Cannot send message: Message text is empty.");
    return;
  }

  // For group JIDs, use as-is; for individual JIDs, normalize
  const normalizedJid = isJidGroup(recipientJid)
    ? recipientJid
    : jidNormalizedUser(recipientJid);

  logger.info(`Sending message to ${normalizedJid}: ${text.substring(0, 50)}...`);

  // Attempt the send; for groups, retry once after a short delay.
  // The first attempt may fail with "not-acceptable" (406) from assertSessions
  // while WhatsApp establishes Signal sessions with participants. A retry
  // typically succeeds because sessions are already cached by then.
  const maxAttempts = isJidGroup(normalizedJid) ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await sock.sendMessage(normalizedJid, { text: text });
      logger.info({ msgId: result?.key.id }, "Message sent successfully");
      return result;
    } catch (error: any) {
      const statusCode = error?.output?.statusCode ?? error?.data;
      const isNotAcceptable = statusCode === 406 || error?.message === "not-acceptable";
      if (isNotAcceptable && attempt < maxAttempts) {
        logger.warn({ attempt }, "Got not-acceptable from assertSessions; retrying after session establishment...");
        await new Promise(res => setTimeout(res, 2000));
        continue;
      }
      logger.error({ err: error, recipientJid: normalizedJid }, "Failed to send message");
      return;
    }
  }
}

export async function sendWhatsAppMedia(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  recipientJid: string,
  mediaType: "image" | "video" | "document" | "audio",
  mediaPath: string,
  caption?: string,
  fileName?: string
): Promise<WAMessage | void> {
  if (!sock || !sock.user) {
    logger.error("Cannot send media: WhatsApp socket not connected or initialized.");
    return;
  }
  try {
    const buffer = fs.readFileSync(mediaPath);
    const mimetype = getMimetype(mediaPath);
    const resolvedFileName = fileName || path.basename(mediaPath);
    const normalizedJid = jidNormalizedUser(recipientJid);
    let messageContent: any;
    switch (mediaType) {
      case "image":
        messageContent = { image: buffer, mimetype, caption };
        break;
      case "video":
        messageContent = { video: buffer, mimetype, caption };
        break;
      case "audio":
        messageContent = { audio: buffer, mimetype, ptt: false };
        break;
      case "document":
        messageContent = { document: buffer, mimetype, fileName: resolvedFileName, caption };
        break;
    }
    const result = await sock.sendMessage(normalizedJid, messageContent);
    logger.info({ msgId: result?.key.id }, "Media sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, recipientJid }, "Failed to send media");
    return;
  }
}

export async function replyToWhatsAppMessage(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  chatJid: string,
  quotedMessageId: string,
  quotedContent: string,
  quotedSenderJid: string | null,
  quotedIsFromMe: boolean,
  replyText: string
): Promise<WAMessage | void> {
  if (!sock || !sock.user) {
    logger.error("Cannot reply: WhatsApp socket not connected or initialized.");
    return;
  }
  try {
    const normalizedJid = jidNormalizedUser(chatJid);
    const quotedMsg = {
      key: {
        id: quotedMessageId,
        remoteJid: normalizedJid,
        fromMe: quotedIsFromMe,
        participant: quotedSenderJid ?? undefined,
      },
      message: { conversation: quotedContent },
    };
    const result = await sock.sendMessage(
      normalizedJid,
      { text: replyText },
      { quoted: quotedMsg as any }
    );
    logger.info({ msgId: result?.key.id }, "Reply sent successfully");
    return result;
  } catch (error) {
    logger.error({ err: error, chatJid }, "Failed to send reply");
    return;
  }
}

export async function sendWhatsAppReaction(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  chatJid: string,
  messageId: string,
  senderJid: string | null,
  isFromMe: boolean,
  emoji: string
): Promise<void> {
  if (!sock || !sock.user) {
    logger.error("Cannot send reaction: WhatsApp socket not connected or initialized.");
    return;
  }
  try {
    const normalizedJid = jidNormalizedUser(chatJid);
    await sock.sendMessage(normalizedJid, {
      react: {
        text: emoji,
        key: {
          remoteJid: normalizedJid,
          id: messageId,
          fromMe: isFromMe,
          participant: senderJid ?? undefined,
        },
      },
    });
    logger.info({ messageId, emoji }, "Reaction sent successfully");
  } catch (error) {
    logger.error({ err: error, chatJid, messageId }, "Failed to send reaction");
  }
}

export async function markWhatsAppChatAsRead(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  chatJid: string,
  lastMessageId: string,
  lastMessageIsFromMe: boolean,
  lastMessageSender: string | null
): Promise<void> {
  if (!sock || !sock.user) {
    logger.error("Cannot mark as read: WhatsApp socket not connected or initialized.");
    return;
  }
  try {
    const normalizedJid = jidNormalizedUser(chatJid);
    await sock.readMessages([{
      remoteJid: normalizedJid,
      id: lastMessageId,
      fromMe: lastMessageIsFromMe,
      participant: lastMessageSender ?? undefined,
    }]);
    logger.info({ chatJid }, "Chat marked as read");
  } catch (error) {
    logger.error({ err: error, chatJid }, "Failed to mark chat as read");
  }
}

/**
 * Reads Baileys' in-memory contacts map (sock.contacts) and persists any display
 * names it finds into our SQLite chats table.  This is the most reliable way to
 * populate human-readable names like "Dady" because WhatsApp delivers address-book
 * names through the contacts map rather than through regular message events.
 *
 * Returns the number of contacts whose names were written to the DB.
 */
export function syncContactsFromSock(
  logger: P.Logger,
  sock: WhatsAppSocket | null
): number {
  if (!sock) return 0;
  try {
    // Baileys stores a contacts dictionary on the socket as a non-typed property
    const contactsMap = (sock as any).contacts as
      | Record<string, { name?: string; notify?: string; verifiedName?: string }>
      | undefined;

    if (!contactsMap || typeof contactsMap !== "object") {
      logger.warn("syncContactsFromSock: sock.contacts is not available yet.");
      return 0;
    }

    let synced = 0;
    for (const [jid, contact] of Object.entries(contactsMap)) {
      const name =
        contact.name || contact.notify || contact.verifiedName || null;
      if (jid && name) {
        storeChat({ jid, name });
        synced++;
      }
    }
    logger.info(`syncContactsFromSock: wrote ${synced} contact names to DB.`);
    return synced;
  } catch (error) {
    logger.error({ err: error }, "syncContactsFromSock failed");
    return 0;
  }
}

export async function getWhatsAppGroupMembers(
  logger: P.Logger,
  sock: WhatsAppSocket | null,
  groupJid: string
): Promise<Array<{ jid: string; phone: string; isAdmin: boolean; isSuperAdmin: boolean }>> {
  if (!sock || !sock.user) {
    logger.error("Cannot get group members: WhatsApp socket not connected or initialized.");
    return [];
  }
  try {
    const metadata = await sock.groupMetadata(groupJid);
    return metadata.participants.map((p) => ({
      jid: p.id,
      phone: p.id.split("@")[0],
      isAdmin: p.admin === "admin" || p.admin === "superadmin",
      isSuperAdmin: p.admin === "superadmin",
    }));
  } catch (error) {
    logger.error({ err: error, groupJid }, "Failed to get group members");
    return [];
  }
}
