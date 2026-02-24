import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { jidNormalizedUser, isJidGroup } from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";

import {
  type Message as DbMessage,
  type Chat as DbChat,
  getMessages,
  getChats,
  getChat,
  getMessagesAround,
  searchDbForContacts,
  searchMessages,
} from "./database.ts";

import {
  sendWhatsAppMessage,
  sendWhatsAppMedia,
  replyToWhatsAppMessage,
  sendWhatsAppReaction,
  markWhatsAppChatAsRead,
  getWhatsAppGroupMembers,
  syncContactsFromSock,
  type WhatsAppSocket,
} from "./whatsapp.ts";
import { type P } from "pino";

// Load contacts.json once at startup for case-insensitive name fallback
const CONTACTS_JSON_PATH = path.join(import.meta.dirname, "..", "contacts.json");
type ContactEntry = { "Display Name"?: string; "Mobile Phone"?: string; "First Name"?: string; "Last Name"?: string };
let contactsJsonCache: ContactEntry[] | null = null;
function getContactsJson(): ContactEntry[] {
  if (!contactsJsonCache) {
    try {
      contactsJsonCache = JSON.parse(fs.readFileSync(CONTACTS_JSON_PATH, "utf8")) as ContactEntry[];
    } catch {
      contactsJsonCache = [];
    }
  }
  return contactsJsonCache;
}

/** Case-insensitive search in contacts.json. Returns a phone-based JID or null. */
function searchContactsJson(query: string): string | null {
  const lower = query.toLowerCase();
  const contacts = getContactsJson();
  const match = contacts.find((c) => {
    const name = (c["Display Name"] || `${c["First Name"] || ""} ${c["Last Name"] || ""}`.trim()).toLowerCase();
    return name.includes(lower);
  });
  if (!match?.["Mobile Phone"]) return null;
  const digits = match["Mobile Phone"].replace(/\D/g, "");
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

// Load groups.json once at startup for case-insensitive group name lookup
const GROUPS_JSON_PATH = path.join(import.meta.dirname, "..", "groups.json");
type GroupEntry = { name: string; jid: string };
let groupsJsonCache: GroupEntry[] | null = null;
function getGroupsJson(): GroupEntry[] {
  if (!groupsJsonCache) {
    try {
      groupsJsonCache = JSON.parse(fs.readFileSync(GROUPS_JSON_PATH, "utf8")) as GroupEntry[];
    } catch {
      groupsJsonCache = [];
    }
  }
  return groupsJsonCache;
}

/** Case-insensitive search in groups.json. Returns the group JID or null. */
function searchGroupsJson(query: string): { jid: string; name: string }[] {
  const lower = query.toLowerCase();
  return getGroupsJson().filter((g) => g.name.toLowerCase().includes(lower));
}

/**
 * Resolves a recipient string (name or JID) to a normalized JID.
 * - If it already contains "@", treat as JID directly.
 * - Otherwise, search contacts DB by name/phone and resolve.
 * - Falls back to contacts.json (case-insensitive) for individual contacts.
 * - Falls back to groups.json (case-insensitive) for group names.
 * Returns { jid } on success, or { error } on failure.
 */
function resolveRecipient(
  recipient: string
): { jid: string; error?: never } | { error: string; jid?: never } {
  // Already looks like a JID
  if (recipient.includes("@")) {
    try {
      // Group JIDs (@g.us) must NOT be passed through jidNormalizedUser — pass them as-is
      if (isJidGroup(recipient)) {
        return { jid: recipient };
      }
      const jid = jidNormalizedUser(recipient);
      return { jid };
    } catch {
      return { error: `Invalid JID format: "${recipient}"` };
    }
  }

  // Could be a plain phone number — try appending @s.whatsapp.net
  if (/^\+?\d[\d\s\-]{6,}$/.test(recipient)) {
    const digits = recipient.replace(/\D/g, "");
    return { jid: `${digits}@s.whatsapp.net` };
  }

  // Treat as a contact name — search the DB (already case-insensitive via LOWER())
  const matches = searchDbForContacts(recipient, 10);
  if (matches.length === 0) {
    // DB had no match — try contacts.json (case-insensitive) for individual contacts
    const jidFromJson = searchContactsJson(recipient);
    if (jidFromJson) {
      return { jid: jidFromJson };
    }
    // Try groups.json (case-insensitive) for group names
    const groupMatches = searchGroupsJson(recipient);
    if (groupMatches.length === 1) {
      return { jid: groupMatches[0].jid };
    }
    if (groupMatches.length > 1) {
      const list = groupMatches.map((g) => `• ${g.name} → ${g.jid}`).join("\n");
      return { error: `Multiple groups match "${recipient}". Please be more specific:\n${list}` };
    }
    return {
      error: `No contact or group found with name "${recipient}". Try using a phone number or full JID instead.`,
    };
  }
  if (matches.length === 1) {
    return { jid: matches[0].jid };
  }
  // Multiple matches — list them for the user
  const list = matches
    .map((c) => `• ${c.name ?? "Unknown"} → ${c.jid}`)
    .join("\n");
  return {
    error: `Multiple contacts match "${recipient}". Please be more specific or use a JID directly:\n${list}`,
  };
}

function formatDbMessageForJson(msg: DbMessage) {
  return {
    id: msg.id,
    chat_jid: msg.chat_jid,
    chat_name: msg.chat_name ?? "Unknown Chat",
    sender_jid: msg.sender ?? null,
    sender_display: msg.sender
      ? msg.sender.split("@")[0]
      : msg.is_from_me
        ? "Me"
        : "Unknown",
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    is_from_me: msg.is_from_me,
  };
}

function formatDbChatForJson(chat: DbChat) {
  return {
    jid: chat.jid,
    name: chat.name ?? chat.jid.split("@")[0] ?? "Unknown Chat",
    is_group: chat.jid.endsWith("@g.us"),
    last_message_time: chat.last_message_time?.toISOString() ?? null,
    last_message_preview: chat.last_message ?? null,
    last_sender_jid: chat.last_sender ?? null,
    last_sender_display: chat.last_sender
      ? chat.last_sender.split("@")[0]
      : chat.last_is_from_me
        ? "Me"
        : null,
    last_is_from_me: chat.last_is_from_me ?? null,
  };
}

export async function startMcpServer(
  sock: WhatsAppSocket | null,
  mcpLogger: P.Logger,
  waLogger: P.Logger,
): Promise<void> {
  mcpLogger.info("Initializing MCP server...");

  const server = new McpServer({
    name: "whatsapp-baileys-ts",
    version: "0.1.0",
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  server.tool(
    "search_contacts",
    {
      query: z
        .string()
        .min(1)
        .describe("Search term for contact name or phone number part of JID"),
    },
    async ({ query }) => {
      mcpLogger.info(
        `[MCP Tool] Executing search_contacts with query: "${query}"`,
      );
      try {
        const contacts = searchDbForContacts(query, 20);
        const formattedContacts = contacts.map((c) => ({
          jid: c.jid,
          name: c.name ?? c.jid.split("@")[0],
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContacts, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_contacts failed: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching contacts: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_messages",
    {
      chat_jid: z
        .string()
        .describe(
          "The JID of the chat (e.g., '123456@s.whatsapp.net' or 'group@g.us')",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max messages per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, limit, page }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_messages for chat ${chat_jid}, limit=${limit}, page=${page}`,
      );
      try {
        const messages = getMessages(chat_jid, limit, page);
        if (!messages.length && page === 0) {
          return {
            content: [
              { type: "text", text: `No messages found for chat ${chat_jid}.` },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }
        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] list_messages failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error listing messages for ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_chats",
    {
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(20)
        .describe("Max chats per page (default 20)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
      sort_by: z
        .enum(["last_active", "name"])
        .optional()
        .default("last_active")
        .describe("Sort order: 'last_active' (default) or 'name'"),
      query: z
        .string()
        .optional()
        .describe("Optional filter by chat name or JID"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ limit, page, sort_by, query, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing list_chats: limit=${limit}, page=${page}, sort=${sort_by}, query=${query}, lastMsg=${include_last_message}`,
      );
      try {
        const chats = getChats(
          limit,
          page,
          sort_by,
          query ?? null,
          include_last_message,
        );
        if (!chats.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No chats found${query ? ` matching "${query}"` : ""}.`,
              },
            ],
          };
        } else if (!chats.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more chats found on page ${page}${
                  query ? ` matching "${query}"` : ""
                }.`,
              },
            ],
          };
        }
        const formattedChats = chats.map(formatDbChatForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChats, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] list_chats failed: ${error.message}`);
        return {
          isError: true,
          content: [
            { type: "text", text: `Error listing chats: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "get_chat",
    {
      chat_jid: z.string().describe("The JID of the chat to retrieve"),
      include_last_message: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include last message details (default true)"),
    },
    async ({ chat_jid, include_last_message }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_chat for ${chat_jid}, lastMsg=${include_last_message}`,
      );
      try {
        const chat = getChat(chat_jid, include_last_message);
        if (!chat) {
          return {
            isError: true,
            content: [
              { type: "text", text: `Chat with JID ${chat_jid} not found.` },
            ],
          };
        }
        const formattedChat = formatDbChatForJson(chat);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedChat, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_chat failed for ${chat_jid}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get_message_context",
    {
      message_id: z
        .string()
        .describe("The ID of the target message to get context around"),
      before: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages before (default 5)"),
      after: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(5)
        .describe("Number of messages after (default 5)"),
    },
    async ({ message_id, before, after }) => {
      mcpLogger.info(
        `[MCP Tool] Executing get_message_context for msg ${message_id}, before=${before}, after=${after}`,
      );
      try {
        const context = getMessagesAround(message_id, before, after);
        if (!context.target) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Message with ID ${message_id} not found.`,
              },
            ],
          };
        }
        const formattedContext = {
          target: formatDbMessageForJson(context.target),
          before: context.before.map(formatDbMessageForJson),
          after: context.after.map(formatDbMessageForJson),
        };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedContext, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] get_message_context failed for ${message_id}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error retrieving context for message ${message_id}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "send_message",
    {
      recipient: z
        .string()
        .describe(
          "Recipient: contact name (e.g., 'Rahul'), phone number (e.g., '919919003141'), or JID (e.g., '919919003141@s.whatsapp.net')",
        ),
      message: z.string().min(1).describe("The text message to send"),
    },
    async ({ recipient, message }) => {
      mcpLogger.info(`[MCP Tool] Executing send_message to ${recipient}`);
      if (!sock) {
        mcpLogger.error(
          "[MCP Tool Error] send_message failed: WhatsApp socket is not available.",
        );
        return {
          isError: true,
          content: [
            { type: "text", text: "Error: WhatsApp connection is not active." },
          ],
        };
      }

      const resolved = resolveRecipient(recipient);
      if (resolved.error) {
        mcpLogger.error(`[MCP Tool Error] send_message resolve failed: ${resolved.error}`);
        return {
          isError: true,
          content: [{ type: "text", text: resolved.error }],
        };
      }
      const normalizedRecipient = resolved.jid!;

      try {
        const result = await sendWhatsAppMessage(
          waLogger,
          sock,
          normalizedRecipient,
          message,
        );

        if (result && result.key && result.key.id) {
          return {
            content: [
              {
                type: "text",
                text: `Message sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).`,
              },
            ],
          };
        } else {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Failed to send message to ${normalizedRecipient}. See server logs for details.`,
              },
            ],
          };
        }
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] send_message failed for ${recipient}: ${error.message}`,
        );
        return {
          isError: true,
          content: [
            { type: "text", text: `Error sending message: ${error.message}` },
          ],
        };
      }
    },
  );

  server.tool(
    "search_messages",
    {
      query: z
        .string()
        .min(1)
        .describe("The text content to search for within messages"),
      chat_jid: z
        .string()
        .optional()
        .describe(
          "Optional: The JID of a specific chat to search within (e.g., '123...net' or 'group@g.us'). If omitted, searches all chats.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("Max messages per page (default 10)"),
      page: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .default(0)
        .describe("Page number (0-indexed, default 0)"),
    },
    async ({ chat_jid, query, limit, page }) => {
      const searchScope = chat_jid ? `in chat ${chat_jid}` : "across all chats";
      mcpLogger.info(
        `[MCP Tool] Executing search_messages ${searchScope}, query="${query}", limit=${limit}, page=${page}`,
      );
      try {
        const messages = searchMessages(query, chat_jid, limit, page);

        if (!messages.length && page === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No messages found containing "${query}" in chat ${chat_jid}.`,
              },
            ],
          };
        } else if (!messages.length) {
          return {
            content: [
              {
                type: "text",
                text: `No more messages found containing "${query}" on page ${page} for chat ${chat_jid}.`,
              },
            ],
          };
        }

        const formattedMessages = messages.map(formatDbMessageForJson);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formattedMessages, null, 2),
            },
          ],
        };
      } catch (error: any) {
        mcpLogger.error(
          `[MCP Tool Error] search_messages_in_chat failed for ${chat_jid} / "${query}": ${error.message}`,
        );
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Error searching messages in chat ${chat_jid}: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "send_media",
    {
      recipient: z
        .string()
        .describe("Recipient: contact name (e.g., 'Rahul'), phone number, or JID (e.g., '12345@s.whatsapp.net')"),
      media_type: z
        .enum(["image", "video", "document", "audio"])
        .describe("Type of media to send"),
      media_path: z
        .string()
        .describe("Absolute local file path to the media file (e.g., 'C:/Users/you/image.png')"),
      caption: z
        .string()
        .optional()
        .describe("Optional caption for image, video, or document"),
      file_name: z
        .string()
        .optional()
        .describe("Optional filename override (used for documents)"),
    },
    async ({ recipient, media_type, media_path, caption, file_name }) => {
      mcpLogger.info(`[MCP Tool] Executing send_media to ${recipient}, type=${media_type}`);
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      const resolved = resolveRecipient(recipient);
      if (resolved.error) {
        return {
          isError: true,
          content: [{ type: "text", text: resolved.error }],
        };
      }
      const normalizedRecipient = resolved.jid!;
      try {
        const result = await sendWhatsAppMedia(
          waLogger, sock, normalizedRecipient, media_type, media_path, caption, file_name
        );
        if (result?.key?.id) {
          return {
            content: [{ type: "text", text: `Media sent successfully to ${normalizedRecipient} (ID: ${result.key.id}).` }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: `Failed to send media to ${normalizedRecipient}.` }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] send_media failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error sending media: ${error.message}` }],
        };
      }
    },
  );

  server.tool(
    "reply_to_message",
    {
      message_id: z
        .string()
        .describe("The ID of the message to reply to"),
      reply_text: z
        .string()
        .min(1)
        .describe("The reply text to send"),
    },
    async ({ message_id, reply_text }) => {
      mcpLogger.info(`[MCP Tool] Executing reply_to_message for msg ${message_id}`);
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      const context = getMessagesAround(message_id, 0, 0);
      if (!context.target) {
        return {
          isError: true,
          content: [{ type: "text", text: `Message with ID ${message_id} not found in local database.` }],
        };
      }
      const { target } = context;
      try {
        const result = await replyToWhatsAppMessage(
          waLogger,
          sock,
          target.chat_jid,
          target.id,
          target.content,
          target.sender ?? null,
          target.is_from_me,
          reply_text
        );
        if (result?.key?.id) {
          return {
            content: [{ type: "text", text: `Reply sent successfully (ID: ${result.key.id}).` }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: "Failed to send reply." }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] reply_to_message failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error sending reply: ${error.message}` }],
        };
      }
    },
  );

  server.tool(
    "send_reaction",
    {
      message_id: z
        .string()
        .describe("The ID of the message to react to"),
      emoji: z
        .string()
        .describe("The emoji to react with (e.g., '👍', '❤️'). Use empty string '' to remove reaction."),
    },
    async ({ message_id, emoji }) => {
      mcpLogger.info(`[MCP Tool] Executing send_reaction for msg ${message_id}, emoji=${emoji}`);
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      const context = getMessagesAround(message_id, 0, 0);
      if (!context.target) {
        return {
          isError: true,
          content: [{ type: "text", text: `Message with ID ${message_id} not found in local database.` }],
        };
      }
      const { target } = context;
      try {
        await sendWhatsAppReaction(
          waLogger,
          sock,
          target.chat_jid,
          target.id,
          target.sender ?? null,
          target.is_from_me,
          emoji
        );
        return {
          content: [{ type: "text", text: `Reaction "${emoji}" sent successfully on message ${message_id}.` }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] send_reaction failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error sending reaction: ${error.message}` }],
        };
      }
    },
  );

  server.tool(
    "mark_as_read",
    {
      chat_jid: z
        .string()
        .describe("The JID of the chat to mark as read (e.g., '12345@s.whatsapp.net' or 'group@g.us')"),
    },
    async ({ chat_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing mark_as_read for chat ${chat_jid}`);
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      const messages = getMessages(chat_jid, 1, 0);
      if (!messages.length) {
        return {
          isError: true,
          content: [{ type: "text", text: `No messages found for chat ${chat_jid}.` }],
        };
      }
      const lastMsg = messages[0];
      try {
        await markWhatsAppChatAsRead(
          waLogger,
          sock,
          chat_jid,
          lastMsg.id,
          lastMsg.is_from_me,
          lastMsg.sender ?? null
        );
        return {
          content: [{ type: "text", text: `Chat ${chat_jid} marked as read.` }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] mark_as_read failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error marking chat as read: ${error.message}` }],
        };
      }
    },
  );

  server.tool(
    "get_group_members",
    {
      group_jid: z
        .string()
        .describe("The JID of the WhatsApp group (e.g., '1234567890-1234567890@g.us')"),
    },
    async ({ group_jid }) => {
      mcpLogger.info(`[MCP Tool] Executing get_group_members for group ${group_jid}`);
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      if (!group_jid.endsWith("@g.us")) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid group JID: "${group_jid}". Group JIDs must end with "@g.us".` }],
        };
      }
      try {
        const members = await getWhatsAppGroupMembers(waLogger, sock, group_jid);
        if (!members.length) {
          return {
            content: [{ type: "text", text: `No members found for group ${group_jid} (or group does not exist).` }],
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(members, null, 2) }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] get_group_members failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error getting group members: ${error.message}` }],
        };
      }
    },
  );

  server.tool(
    "sync_contacts",
    {},
    async () => {
      mcpLogger.info("[MCP Tool] Executing sync_contacts");
      if (!sock) {
        return {
          isError: true,
          content: [{ type: "text", text: "Error: WhatsApp connection is not active." }],
        };
      }
      try {
        const count = syncContactsFromSock(waLogger, sock);
        return {
          content: [{
            type: "text",
            text: count > 0
              ? `Synced ${count} contact names from WhatsApp into the local database. You can now search contacts by name.`
              : "No contact names were found to sync. The contacts map may not be populated yet — try again in a few seconds after the connection has fully loaded.",
          }],
        };
      } catch (error: any) {
        mcpLogger.error(`[MCP Tool Error] sync_contacts failed: ${error.message}`);
        return {
          isError: true,
          content: [{ type: "text", text: `Error syncing contacts: ${error.message}` }],
        };
      }
    },
  );

  server.resource("db_schema", "schema://whatsapp/main", async (uri) => {
    mcpLogger.info(`[MCP Resource] Request for ${uri.href}`);
    const schemaText = `
TABLE chats (jid TEXT PK, name TEXT, last_message_time TIMESTAMP)
TABLE messages (id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TIMESTAMP, is_from_me BOOLEAN, PK(id, chat_jid), FK(chat_jid) REFERENCES chats(jid))
            `.trim();
    return {
      contents: [
        {
          uri: uri.href,
          text: schemaText,
        },
      ],
    };
  });

  const transport = new StdioServerTransport();
  mcpLogger.info("MCP server configured. Connecting stdio transport...");

  try {
    await server.connect(transport);
    mcpLogger.info(
      "MCP transport connected. Server is ready and listening via stdio.",
    );
  } catch (error: any) {
    mcpLogger.error(
      `[FATAL] Failed to connect MCP transport: ${error.message}`,
      error,
    );
    process.exit(1);
  }

  mcpLogger.info(
    "MCP Server setup complete. Waiting for requests from client...",
  );
}
