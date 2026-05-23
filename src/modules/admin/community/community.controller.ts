import { ok } from '@/shared/http/envelope.js';

// Community posts and product reviews tables are not yet in the schema.
// These endpoints return empty queues until the community/reviews schema is added.

export async function listCommunityModeration() {
  return ok([]);
}

export async function listReviewsModeration() {
  return ok([]);
}
