/* eslint-disable no-console -- CLI seed: console output is the intended UX */
/**
 * Product review seed — 5 reviewer consumers + ~50 reviews spread across the active
 * catalog so the consumer app's product detail reviews tab has real data.
 *
 * Idempotent: reviewers are matched by email; the review block is skipped entirely
 * when any review by a seeded reviewer already exists.
 *
 * Run standalone: npx tsx src/db/seed/product-reviews.ts
 * Or via orchestrator: npm run db:seed
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client.js';
import type { db as Db } from '@/db/client.js';
import { consumers, productListings, productReviews } from '@/db/schema/index.js';
import { hashPassword } from '@/shared/auth/password.js';
import { IdPrefix, newId } from '@/shared/ids.js';

// Phones in the 984x-988x range — demo-retailer's consumers use 981/982/983
// (consumers.phone has a unique index).
const REVIEWER_SPECS = [
  { name: 'Sneha Kulkarni', email: 'sneha.reviews.closetx@gmail.com', phone: '9844567890' },
  { name: 'Arjun Nair', email: 'arjun.reviews.closetx@gmail.com', phone: '9855678901' },
  { name: 'Meera Iyer', email: 'meera.reviews.closetx@gmail.com', phone: '9866789012' },
  { name: 'Kabir Singh', email: 'kabir.reviews.closetx@gmail.com', phone: '9877890123' },
  { name: 'Tanvi Desai', email: 'tanvi.reviews.closetx@gmail.com', phone: '9888901234' },
];

const REVIEW_BODIES: { rating: number; body: string }[] = [
  { rating: 5, body: 'Fits perfectly and the fabric feels premium. Delivery in under an hour!' },
  { rating: 4, body: 'Really good quality for the price. Runs slightly large, size down if in doubt.' },
  { rating: 5, body: 'Exactly as shown in the photos. Already ordered a second one.' },
  { rating: 3, body: 'Decent, but the color is a shade lighter than the pictures.' },
  { rating: 5, body: 'Obsessed. Wore it the same evening it arrived — got so many compliments.' },
  { rating: 4, body: 'Stitching and finish are solid. Took a star off because my size was almost out of stock.' },
  { rating: 5, body: 'The 60-minute delivery is no joke. Quality is store-level, not online-shopping-level.' },
  { rating: 4, body: 'Comfortable and true to size. Material is a bit thinner than expected but drapes well.' },
  { rating: 5, body: 'Third purchase from this store. Consistent quality every single time.' },
  { rating: 3, body: 'Okay product. Packaging was great but the fit is boxier than the model shot.' },
  { rating: 5, body: 'Premium feel, neat stitching, fast delivery. Easy five stars.' },
  { rating: 4, body: 'Looks even better in person. Wish there were more color options.' },
  { rating: 5, body: 'Bought it for a function — fit like it was tailored. Highly recommend.' },
  { rating: 4, body: 'Great everyday piece. Washed twice already, no fading or shrinkage.' },
  { rating: 5, body: 'Try-on feature sold me, the real thing is even better. Zero regrets.' },
  { rating: 3, body: 'Average. Does the job but nothing special at this price point.' },
];

export async function seedProductReviews(database: typeof Db): Promise<void> {
  // 1. Reviewer consumers — idempotent by email.
  const pwd = await hashPassword('Consumer@1234');
  const reviewerIds: string[] = [];
  for (const r of REVIEWER_SPECS) {
    const existing = await database.query.consumers.findFirst({
      where: eq(consumers.email, r.email),
    });
    if (existing) {
      reviewerIds.push(existing.id);
      continue;
    }
    const id = newId(IdPrefix.Consumer);
    await database.insert(consumers).values({
      id,
      email: r.email,
      phone: r.phone,
      name: r.name,
      passwordHash: pwd,
      status: 'active',
    });
    reviewerIds.push(id);
    console.log(`  → seeded reviewer '${r.email}'`);
  }

  // 2. Idempotency anchor: any review by a seeded reviewer means a prior full run.
  const existing = await database.query.productReviews.findFirst({
    where: inArray(productReviews.consumerId, reviewerIds),
  });
  if (existing) {
    console.log('  → product reviews already seeded, skipping');
    return;
  }

  // 3. Active listings in deterministic order.
  const listings = await database.query.productListings.findMany({
    where: eq(productListings.status, 'active'),
    columns: { id: true },
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });

  // 4. 0-2 reviews per listing via deterministic index math (~50 total over ~74
  //    listings), createdAt spread over the past 60 days.
  let count = 0;
  for (const [i, l] of listings.entries()) {
    const perListing = i % 3 === 2 ? 0 : (i % 2) + 1;
    for (let j = 0; j < perListing; j++) {
      const spec = REVIEW_BODIES[(i * 2 + j) % REVIEW_BODIES.length]!;
      const createdAt = new Date();
      createdAt.setDate(createdAt.getDate() - ((i * 7 + j * 3) % 60));
      createdAt.setHours(9 + ((i + j) % 12), (i * 11) % 60, 0, 0);
      await database.insert(productReviews).values({
        id: newId(IdPrefix.ProductReview),
        consumerId: reviewerIds[(i + j) % reviewerIds.length]!,
        listingId: l.id,
        rating: spec.rating,
        body: spec.body,
        status: 'active',
        createdAt,
      });
      count++;
    }
  }
  console.log(`  → seeded ${count} product reviews across ${listings.length} listings`);
}

// Standalone entry: npx tsx src/db/seed/product-reviews.ts
const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('product-reviews.ts');
if (isMain) {
  seedProductReviews(db)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error(err);
      process.exit(1);
    });
}
