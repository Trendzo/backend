/**
 * Driver earnings summary — backs the app Home/Profile stat tiles. Aggregates
 * `driver_earnings` for the calling driver over today / the last 7 days (IST day
 * boundaries), plus today's COD cash collected (from delivered orders).
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@/db/client.js';
import { driverEarnings, orders } from '@/db/schema/index.js';
import { ok } from '@/shared/http/envelope.js';
import type { AccessTokenPayload } from '@/shared/auth/jwt.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** UTC Date for IST-midnight `daysAgo` days back (0 = start of today). */
function istDayStart(daysAgo: number): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

export async function earningsSummary(input: { auth: AccessTokenPayload }) {
  const driverId = input.auth.sub;
  const todayStart = istDayStart(0);
  const weekStart = istDayStart(6); // 7-day window incl. today

  const agg = async (since: Date) => {
    const [row] = await db
      .select({
        total: sql<number>`coalesce(sum(${driverEarnings.totalPaise}), 0)::int`,
        deliveries: sql<number>`count(*)::int`,
        days: sql<number>`count(distinct date(${driverEarnings.earnedAt} at time zone 'Asia/Kolkata'))::int`,
      })
      .from(driverEarnings)
      .where(and(eq(driverEarnings.driverId, driverId), gte(driverEarnings.earnedAt, since)));
    return row ?? { total: 0, deliveries: 0, days: 0 };
  };

  const [today, week] = await Promise.all([agg(todayStart), agg(weekStart)]);

  const [codRow] = await db
    .select({ cod: sql<number>`coalesce(sum(${orders.codCollectedPaise}), 0)::int` })
    .from(orders)
    .where(and(eq(orders.assignedAgentId, driverId), gte(orders.deliveredAt, todayStart)));

  return ok({
    today: {
      earningsPaise: today.total,
      deliveries: today.deliveries,
      codCollectedPaise: codRow?.cod ?? 0,
    },
    week: {
      earningsPaise: week.total,
      deliveries: week.deliveries,
      days: week.days,
    },
  });
}
