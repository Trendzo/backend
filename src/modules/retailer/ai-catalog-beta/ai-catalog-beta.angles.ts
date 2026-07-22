/**
 * Angle / pose presets — moved to `@/shared/ai-catalog/angles.ts` so the BETA
 * submission flow and the bulk-mockup queue share one source. Re-exported here
 * for back-compat with existing imports.
 */
export {
  type AnglePreset,
  PRODUCT_ANGLES,
  MODEL_POSES,
  ALL_ANGLE_NAMES,
} from '@/shared/ai-catalog/angles.js';
