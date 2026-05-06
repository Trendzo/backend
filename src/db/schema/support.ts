import { relations, sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { actorType, supportSenderType, supportTicketStatus } from './enums.js';
import { adminAccounts } from './identity.js';
import { orders } from './orders.js';

/**
 * Support ticket. Opener is polymorphic via actorType + actorId — same shape used elsewhere.
 * Optional orderId links the ticket to a specific order for context (delivery issue,
 * return question, etc.).
 */
export const supportTickets = pgTable(
  'support_tickets',
  {
    id: text('id').primaryKey(),
    openedByActorType: actorType('opened_by_actor_type').notNull(),
    openedByActorId: text('opened_by_actor_id').notNull(),
    orderId: text('order_id').references(() => orders.id),
    subject: text('subject').notNull(),
    status: supportTicketStatus('status').notNull().default('open'),
    assignedAdminId: text('assigned_admin_id').references(() => adminAccounts.id),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    statusIdx: index('support_tickets_status_idx').on(t.status),
    assignedIdx: index('support_tickets_assigned_idx').on(t.assignedAdminId),
    openerIdx: index('support_tickets_opener_idx').on(t.openedByActorType, t.openedByActorId),
  }),
);

/**
 * Threaded message on a ticket. Sender is polymorphic per the same pattern; system messages
 * (e.g. "ticket auto-closed") use senderType = 'system'.
 */
export const supportMessages = pgTable(
  'support_messages',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => supportTickets.id, { onDelete: 'cascade' }),
    senderType: supportSenderType('sender_type').notNull(),
    senderId: text('sender_id').notNull(), // polymorphic; 'system' literal for system msgs
    body: text('body').notNull(),
    attachments: jsonb('attachments').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    at: timestamp('at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => ({
    ticketAtIdx: index('support_messages_ticket_at_idx').on(t.ticketId, t.at),
  }),
);

// ===== Relations =====

export const supportTicketsRelations = relations(supportTickets, ({ one, many }) => ({
  order: one(orders, {
    fields: [supportTickets.orderId],
    references: [orders.id],
  }),
  assignedAdmin: one(adminAccounts, {
    fields: [supportTickets.assignedAdminId],
    references: [adminAccounts.id],
  }),
  messages: many(supportMessages),
}));

export const supportMessagesRelations = relations(supportMessages, ({ one }) => ({
  ticket: one(supportTickets, {
    fields: [supportMessages.ticketId],
    references: [supportTickets.id],
  }),
}));
