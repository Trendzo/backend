/**
 * Platform-default attribute templates. A new retailer can pick one of these (or define
 * their own scoped to their store). Listed templates are owner-store-null + isPlatformDefault.
 */

import { randomUUID } from 'node:crypto';
import type { db as Db } from '@/db/client.js';
import { attributeTemplates } from '@/db/schema/index.js';

type AxisDef = { type: 'enum' | 'free_text'; required: boolean; values?: string[] };

type Template = {
  name: string;
  axes: Record<string, AxisDef>;
};

export const ATTRIBUTE_TEMPLATE_DEFAULTS: readonly Template[] = [
  {
    name: 'Apparel',
    axes: {
      size: {
        type: 'enum',
        required: true,
        values: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
      },
      colour: { type: 'free_text', required: true },
    },
  },
  {
    name: 'Footwear',
    axes: {
      size: {
        type: 'enum',
        required: true,
        values: ['UK 5', 'UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10', 'UK 11', 'UK 12'],
      },
      colour: { type: 'free_text', required: true },
    },
  },
  {
    name: 'One-size',
    axes: {
      colour: { type: 'free_text', required: false },
    },
  },
];

export async function seedAttributeTemplates(db: typeof Db): Promise<void> {
  for (const tpl of ATTRIBUTE_TEMPLATE_DEFAULTS) {
    await db
      .insert(attributeTemplates)
      .values({ id: randomUUID(), ...tpl, isPlatformDefault: true })
      .onConflictDoNothing();
  }
}
