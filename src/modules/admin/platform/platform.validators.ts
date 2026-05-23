import { z } from 'zod';

export const CapabilityParam = z.object({ capability: z.string() });
export const ModeBody = z.object({ mode: z.enum(['open', 'locked']) });
