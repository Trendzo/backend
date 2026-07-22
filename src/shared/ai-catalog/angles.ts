/**
 * Angle / pose presets for AI-catalog generation. Each entry becomes one
 * generated image; `pose` is fed to generateCatalogImage as a posePreferences
 * string. Shared by the BETA submission flow and the bulk-mockup queue.
 */
export type AnglePreset = { name: string; pose: string };

/** mode = 'without_model' — flat / ghost-mannequin product shots. */
export const PRODUCT_ANGLES: AnglePreset[] = [
  {
    name: 'front',
    pose: 'front view, ghost-mannequin / invisible-mannequin, centered, clean seamless white background, soft even studio lighting',
  },
  {
    name: 'back',
    pose: 'back view, ghost-mannequin, clean seamless white background (any print is on the front only, so the back is blank)',
  },
  {
    name: 'three-quarter',
    pose: 'three-quarter 45-degree angle, ghost-mannequin, subtle shadow, seamless light-grey background',
  },
  {
    name: 'flat-lay',
    pose: 'top-down flat-lay, neatly folded on a light wooden surface, minimal props, natural soft lighting',
  },
  {
    name: 'on-hanger',
    pose: 'displayed on a wooden clothes hanger against a warm neutral wall, soft daylight, boutique look',
  },
];

/** mode = 'with_model' — on-body / lifestyle shots. */
export const MODEL_POSES: AnglePreset[] = [
  {
    name: 'model-front-studio',
    pose: 'full-body front view, natural relaxed pose, neutral seamless studio backdrop, professional fashion lighting',
  },
  {
    name: 'model-three-quarter',
    pose: 'full-body three-quarter turn showing the fit from an angle, studio backdrop, soft lighting',
  },
  {
    name: 'model-back',
    pose: 'full-body back view showing the rear of the garment, studio backdrop (print is on the front only)',
  },
  {
    name: 'model-lifestyle',
    pose: 'full-body lifestyle shot, standing outdoors on a city street, soft natural daylight, candid catalog mood',
  },
];

export const ALL_ANGLE_NAMES: string[] = [...PRODUCT_ANGLES, ...MODEL_POSES].map((a) => a.name);
