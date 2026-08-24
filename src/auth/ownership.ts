import { prisma } from "@/db/client";

/**
 * Maps a Clerk user to our UserAccount, creating it on first sight.
 *
 * Clerk owns identity; this row exists so chats, credits and attachments have a
 * local foreign key. The credit account is created alongside it so a first-time
 * user can immediately start a run.
 */
export async function resolveUserAccount(clerkUserId: string) {
  return prisma.userAccount.upsert({
    where: { clerkUserId },
    update: {},
    create: {
      clerkUserId,
      creditAccount: { create: {} },
    },
  });
}

/**
 * Returns the chat only if this user owns it.
 *
 * A chat that exists but belongs to someone else is indistinguishable from one
 * that does not exist — callers answer 404 for both. Returning 403 would confirm
 * the id is real.
 */
export async function findOwnedChat(userAccountId: string, chatId: string) {
  return prisma.chat.findFirst({
    where: { id: chatId, userId: userAccountId },
  });
}
