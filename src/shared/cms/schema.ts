/**
 * The Home CMS section catalogue — one declarative entry per content slot.
 *
 * This file is the single source of truth for three things that would otherwise drift apart:
 *   1. what the backend accepts on a write (validators check `content` against `itemFields`),
 *   2. what the admin portal renders (it fetches this over GET /admin/cms/schema and builds
 *      the form from it, so there is ONE panel component rather than twenty bespoke pages),
 *   3. which section keys exist at all (the seed and the app's registry both key off these).
 *
 * Adding a section later is an entry here + a `useCmsSection` call in the app. No new admin
 * page, no new endpoint, no migration.
 *
 * Why so many small sections rather than a few big ones: a section is the unit that has ONE
 * item shape. The reels row, for example, holds two editorial split-cards, two video tiles and
 * a delivery banner — three different shapes — so it is three sections that the admin UI groups
 * under a single tab. That keeps the generic form renderer genuinely generic; a section whose
 * items sometimes have `copy` and sometimes have `videoUrl` would push per-type branching back
 * into the UI, which is the thing this design is avoiding.
 */

/** How the admin portal renders a field, and what the backend will accept in it. */
export type CmsFieldKind =
  | 'text' // single line
  | 'textarea' // multi-line editorial copy
  | 'color' // #rrggbb
  | 'string_list' // array of short strings (chips, tags)
  | 'number';

export type CmsFieldSpec = {
  /** Key inside `content` (items) or `config` (sections). */
  key: string;
  label: string;
  kind: CmsFieldKind;
  required?: boolean;
  help?: string;
  maxLength?: number;
};

/** Section-level copy lives in real columns, not `config` — these name which ones apply. */
export type CmsSectionCopyField = 'title' | 'subtitle' | 'kicker' | 'ctaLabel';

export type CmsSectionSpec = {
  /** Widget type. The app's section registry keys off this. */
  type: string;
  /** Admin tab that hosts this section. Several sections may share a tab. */
  tab: string;
  label: string;
  description: string;
  /** True when HER and HIM show different items and admin should get a rail switcher. */
  genderSplit: boolean;
  /** What kind of media an item carries. 'none' = copy-only items. */
  media: 'image' | 'video' | 'none';
  /** Whether an item carries a tap target. */
  link: boolean;
  /**
   * Item count bounds, PER RAIL. A gender-split section holds both rails' items in one row
   * set, so "the Steals bento holds 3 tiles" means 3 on HER and 3 on HIM, not 3 in total —
   * the counts are what the layout renders, and the layout only ever renders one rail.
   * An item marked `all` counts toward both. maxItems 0 = section-level copy only.
   */
  minItems: number;
  maxItems: number;
  /** Which of the section's copy columns this section uses. */
  copyFields: CmsSectionCopyField[];
  /** Extra section-level settings, stored in `cms_sections.config`. */
  configFields: CmsFieldSpec[];
  /** Per-item copy, stored in `cms_items.content`. */
  itemFields: CmsFieldSpec[];
};

/**
 * Route names the app's RootNav stack actually registers
 * (`customer-app/src/navigation/RootNav.tsx`). A link naming anything else is rejected on
 * write, so a typo in admin surfaces as a 422 rather than as a dead tap in production.
 */
export const CMS_ROUTES = [
  'Categories',
  'Category',
  'CategoryZoom',
  'ProductDetail',
  'Search',
  'ImageSearch',
  'Steals',
  'TopStories',
  'ShopByOccasion',
  'FlashFit',
  'ForHer',
  'ForHim',
  'OccasionShopping',
  'NewArrivals',
  'DiscoverBrands',
  'TryOnPicker',
  'TryAndBuy',
  'ReelsTab',
  'CartTab',
  'CategoryTab',
  'HomeTab',
  'CommunityFeed',
  'MoodBoard',
  'CouponWallet',
  'LoyaltyRewards',
  'ReferralRewards',
  'GiftCard',
  'SpinWheel',
  'DailyReward',
  'LuckyDraw',
  'StyleQuiz',
  'InviteFriends',
  'AppChallenges',
  'SavedAddresses',
  'Profile',
  'OrderHistory',
  'About',
  'Sustainability',
  'FashionCalendar',
  'StorePickup',
] as const;

export type CmsRoute = (typeof CMS_ROUTES)[number];

// ─── Reusable field groups ────────────────────────────────────────────────────

const LABEL: CmsFieldSpec = { key: 'label', label: 'Label', kind: 'text', maxLength: 60 };
const TINT: CmsFieldSpec = {
  key: 'tint',
  label: 'Dominant tint',
  kind: 'color',
  help: 'Light pastel sampled from the artwork; drives the adaptive header fade.',
};

// ─── The catalogue ────────────────────────────────────────────────────────────

export const SECTION_SCHEMA = {
  // ═══ HOME ═══════════════════════════════════════════════════════════════════

  'home.hero': {
    type: 'hero_carousel',
    tab: 'hero',
    label: 'Hero banners',
    description:
      'The full-bleed auto-rotating campaign posters at the top of Home. Art is 3:4 and carries its own baked-in typography, so no headline is overlaid.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 1,
    maxItems: 8,
    copyFields: [],
    configFields: [
      {
        key: 'autoplayMs',
        label: 'Slide duration (ms)',
        kind: 'number',
        help: 'How long each poster holds before advancing. 3500 is the current value.',
      },
    ],
    itemFields: [TINT],
  },

  'home.header': {
    type: 'header_copy',
    tab: 'chrome',
    label: 'Header overlay',
    description:
      'The wordmark, delivery-ETA headline and search placeholder floating on top of the hero banner.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 0,
    copyFields: ['title', 'subtitle', 'kicker'],
    configFields: [
      {
        key: 'searchPlaceholder',
        label: 'Search placeholder',
        kind: 'text',
        maxLength: 60,
      },
    ],
    itemFields: [],
  },

  'home.marquee': {
    type: 'marquee',
    tab: 'chrome',
    label: 'Marquee ticker',
    description: 'The scrolling strip directly under the hero banner.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 0,
    copyFields: [],
    configFields: [
      {
        key: 'text',
        label: 'Ticker text',
        kind: 'textarea',
        required: true,
        help: 'Separate claims with "  //  " — the strip repeats this string end to end.',
      },
    ],
    itemFields: [],
  },

  'home.explore_grid': {
    type: 'bento_grid',
    tab: 'explore',
    label: 'Categories to explore',
    description:
      'The 3 / (1 + headline) / 3 bento grid of model cards. Tapping a card opens the category zoom.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 7,
    maxItems: 7,
    copyFields: ['title'],
    configFields: [
      {
        key: 'highlightColor',
        label: 'Headline highlighter',
        kind: 'color',
        help: 'The block behind the headline words. Currently #F2E63C.',
      },
    ],
    itemFields: [
      { ...LABEL, required: true },
      {
        key: 'tint',
        label: 'Zoom tint',
        kind: 'color',
        help: 'Backdrop colour of the category-zoom transition this card flies into.',
      },
    ],
  },

  'home.steals': {
    type: 'bento_steals',
    tab: 'steals',
    label: 'Steals (home bento)',
    description:
      'One tall hero tile plus two stacked tiles. The first item is always the tall one.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 3,
    maxItems: 3,
    copyFields: ['title', 'ctaLabel'],
    configFields: [],
    itemFields: [
      { ...LABEL, required: true },
      {
        key: 'priceLine',
        label: 'Price line',
        kind: 'text',
        required: true,
        maxLength: 24,
        help: 'Shown verbatim, e.g. "Under ₹999". Nothing validates this against real prices.',
      },
      { key: 'qualifier', label: 'Qualifier', kind: 'text', maxLength: 24 },
    ],
  },

  'home.top_stories': {
    type: 'story_carousel',
    tab: 'stories',
    label: 'Top stories (home carousel)',
    description:
      'Poster-only editorial carousel. The posters carry their own typography; copy for the full story page lives in the Story pages section.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 2,
    maxItems: 8,
    copyFields: ['title', 'ctaLabel'],
    configFields: [],
    itemFields: [],
  },

  'home.reels_features': {
    type: 'editorial_pair',
    tab: 'reels',
    label: 'Reels — editorial cards',
    description: 'The two alternating image + copy-panel split cards above the video tiles.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 2,
    copyFields: [],
    configFields: [],
    itemFields: [
      { key: 'label', label: 'Eyebrow', kind: 'text', maxLength: 40 },
      { key: 'title', label: 'Title', kind: 'text', required: true, maxLength: 40 },
      { key: 'copy', label: 'Body copy', kind: 'textarea', maxLength: 200 },
      { key: 'cta', label: 'CTA label', kind: 'text', maxLength: 24 },
      { key: 'accent', label: 'Accent colour', kind: 'color' },
    ],
  },

  'home.reels_previews': {
    type: 'video_row',
    tab: 'reels',
    label: 'Reels — video tiles',
    description:
      'The two autoplaying portrait clips. Bundled clips cost APK size — a 9 MB clip was removed once for exactly that reason — so prefer uploads here.',
    genderSplit: true,
    media: 'video',
    link: true,
    minItems: 0,
    maxItems: 2,
    copyFields: [],
    configFields: [],
    itemFields: [],
  },

  'home.reels_banner': {
    type: 'promo_banner',
    tab: 'reels',
    label: 'Reels — delivery banner',
    description: 'The pastel banner under the video tiles. Items are its feature chips.',
    genderSplit: false,
    media: 'none',
    link: true,
    minItems: 0,
    maxItems: 4,
    copyFields: ['title', 'subtitle', 'ctaLabel'],
    configFields: [
      { key: 'gradientHer', label: 'HER gradient (comma-separated)', kind: 'text' },
      { key: 'gradientHim', label: 'HIM gradient (comma-separated)', kind: 'text' },
    ],
    itemFields: [{ ...LABEL, required: true }],
  },

  'home.occasion': {
    type: 'occasion_rail',
    tab: 'occasion',
    label: 'Shop by occasion (home rail)',
    description:
      'Full-bleed campaign background with a centred heading and a swipeable row of occasion cards sitting on its empty lower area.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 2,
    maxItems: 8,
    copyFields: ['title'],
    configFields: [
      {
        key: 'backgroundAssetKey',
        label: 'Background asset key',
        kind: 'text',
        help: 'Bundled art behind the whole section. Currently github-import/top/bg.',
      },
      { key: 'backgroundImageUrl', label: 'Background image URL', kind: 'text' },
    ],
    itemFields: [{ ...LABEL, required: true }],
  },

  'home.flash_fit': {
    type: 'flash_fit',
    tab: 'flash',
    label: 'Flash fit of the day',
    description: 'The three-tile outfit grid with the countdown.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 3,
    maxItems: 3,
    copyFields: ['title', 'subtitle', 'ctaLabel'],
    configFields: [],
    itemFields: [{ ...LABEL, required: true }],
  },

  'home.try_on': {
    type: 'promo_band',
    tab: 'tryon',
    label: 'See it on you',
    description: 'The Try & Buy band with the cutout models over the big wordmark.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 1,
    copyFields: ['title', 'subtitle', 'ctaLabel'],
    configFields: [
      { key: 'wordmark', label: 'Background wordmark', kind: 'text', maxLength: 24 },
    ],
    itemFields: [],
  },

  'home.footer': {
    type: 'footer_copy',
    tab: 'chrome',
    label: 'Footer',
    description: 'The two lines at the very bottom of the home feed.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 0,
    copyFields: ['title', 'subtitle'],
    configFields: [],
    itemFields: [],
  },

  // ═══ SECTION PAGES ══════════════════════════════════════════════════════════

  'page.steals_hero': {
    type: 'page_hero',
    tab: 'page_steals',
    label: 'Steals page — hero',
    description: 'The editorial cover at the top of the Steals page.',
    genderSplit: true,
    media: 'image',
    link: false,
    minItems: 1,
    maxItems: 1,
    copyFields: ['kicker', 'title', 'subtitle'],
    configFields: [],
    itemFields: [],
  },

  'page.steals_bento': {
    type: 'bento_steals',
    tab: 'page_steals',
    label: 'Steals page — deal tiles',
    description: 'The small bento of hero deals under the band selector.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 3,
    maxItems: 3,
    copyFields: [],
    configFields: [],
    itemFields: [
      { ...LABEL, required: true },
      { key: 'priceLine', label: 'Price line', kind: 'text', required: true, maxLength: 24 },
    ],
  },

  'page.steals_bands': {
    type: 'price_bands',
    tab: 'page_steals',
    label: 'Steals page — price bands',
    description:
      'The band selector. `maxPaise` filters the grid; leave it blank on the "All deals" band.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 1,
    maxItems: 8,
    copyFields: [],
    configFields: [],
    itemFields: [
      { ...LABEL, required: true },
      {
        key: 'maxPaise',
        label: 'Ceiling (paise)',
        kind: 'number',
        help: 'Blank = no ceiling. 99900 means "Under ₹999".',
      },
    ],
  },

  'page.top_stories': {
    type: 'story_list',
    tab: 'page_stories',
    label: 'Story pages',
    description:
      'The full Top Stories feed — every poster carries its own headline, blurb, read time and tags.',
    genderSplit: true,
    media: 'image',
    link: true,
    minItems: 1,
    maxItems: 12,
    copyFields: ['kicker', 'title', 'subtitle'],
    configFields: [],
    itemFields: [
      { key: 'tag', label: 'Chapter tag', kind: 'text', required: true, maxLength: 40 },
      { key: 'title', label: 'Headline', kind: 'text', required: true, maxLength: 60 },
      { key: 'blurb', label: 'Blurb', kind: 'textarea', required: true, maxLength: 240 },
      { key: 'read', label: 'Read time', kind: 'text', maxLength: 12 },
      { key: 'tags', label: 'Tags', kind: 'string_list' },
    ],
  },

  'page.occasion': {
    type: 'occasion_list',
    tab: 'page_occasion',
    label: 'Shop by occasion page',
    description:
      'The pill selector and its themed heroes. Each occasion re-dresses the page with its own tint pair.',
    genderSplit: true,
    media: 'image',
    link: false,
    minItems: 1,
    maxItems: 10,
    copyFields: ['title', 'subtitle'],
    configFields: [],
    itemFields: [
      { ...LABEL, required: true },
      { key: 'note', label: 'Styling note', kind: 'textarea', required: true, maxLength: 200 },
      { key: 'tintFrom', label: 'Tint (from)', kind: 'color', required: true },
      { key: 'tintTo', label: 'Tint (to)', kind: 'color', required: true },
      { key: 'accent', label: 'Accent', kind: 'color', required: true },
    ],
  },

  'page.flash_fit': {
    type: 'page_copy',
    tab: 'flash',
    label: 'Flash fit page',
    description: 'Heading and blurb on the Flash Fit page.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 0,
    copyFields: ['kicker', 'title', 'subtitle'],
    configFields: [],
    itemFields: [],
  },

  'page.edit_her': {
    type: 'edit_page',
    tab: 'page_edits',
    label: 'Her Edit — cover',
    description: 'Cover art, headline and trailing poster for the campaign page the HER hero opens.',
    genderSplit: false,
    media: 'image',
    link: false,
    minItems: 0,
    maxItems: 1,
    copyFields: ['kicker', 'title', 'subtitle', 'ctaLabel'],
    configFields: [
      { key: 'gridTitle', label: 'Product grid heading', kind: 'text', maxLength: 40 },
      { key: 'posterAssetKey', label: 'Closing poster asset key', kind: 'text' },
      { key: 'posterImageUrl', label: 'Closing poster URL', kind: 'text' },
    ],
    itemFields: [],
  },

  'page.edit_her_chips': {
    type: 'chip_row',
    tab: 'page_edits',
    label: 'Her Edit — promise chips',
    description: 'The short claims under the cover headline.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 6,
    copyFields: [],
    configFields: [],
    itemFields: [{ ...LABEL, required: true }],
  },

  'page.edit_her_cats': {
    type: 'cutout_row',
    tab: 'page_edits',
    label: 'Her Edit — category tiles',
    description: 'The numbered cutout category tiles.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 12,
    copyFields: [],
    configFields: [],
    itemFields: [{ ...LABEL, required: true }],
  },

  'page.edit_her_features': {
    type: 'editorial_pair',
    tab: 'page_edits',
    label: 'Her Edit — editorial bands',
    description: 'The alternating image / copy-panel bands.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 4,
    copyFields: [],
    configFields: [],
    itemFields: [
      { key: 'tag', label: 'Eyebrow', kind: 'text', required: true, maxLength: 40 },
      {
        key: 'title',
        label: 'Title',
        kind: 'text',
        required: true,
        maxLength: 40,
        help: 'A newline splits the headline across two lines, as in "New week,\\nnew closet."',
      },
      { key: 'copy', label: 'Body copy', kind: 'textarea', required: true, maxLength: 200 },
    ],
  },

  'page.edit_him': {
    type: 'edit_page',
    tab: 'page_edits',
    label: 'His Code — cover',
    description: 'Cover art, headline and trailing poster for the campaign page the HIM hero opens.',
    genderSplit: false,
    media: 'image',
    link: false,
    minItems: 0,
    maxItems: 1,
    copyFields: ['kicker', 'title', 'subtitle', 'ctaLabel'],
    configFields: [
      { key: 'gridTitle', label: 'Product grid heading', kind: 'text', maxLength: 40 },
      { key: 'posterAssetKey', label: 'Closing poster asset key', kind: 'text' },
      { key: 'posterImageUrl', label: 'Closing poster URL', kind: 'text' },
    ],
    itemFields: [],
  },

  'page.edit_him_chips': {
    type: 'chip_row',
    tab: 'page_edits',
    label: 'His Code — promise chips',
    description: 'The short claims under the cover headline.',
    genderSplit: false,
    media: 'none',
    link: false,
    minItems: 0,
    maxItems: 6,
    copyFields: [],
    configFields: [],
    itemFields: [{ ...LABEL, required: true }],
  },

  'page.edit_him_cats': {
    type: 'cutout_row',
    tab: 'page_edits',
    label: 'His Code — category tiles',
    description: 'The numbered cutout category tiles.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 12,
    copyFields: [],
    configFields: [],
    itemFields: [{ ...LABEL, required: true }],
  },

  'page.edit_him_features': {
    type: 'editorial_pair',
    tab: 'page_edits',
    label: 'His Code — editorial bands',
    description: 'The alternating image / copy-panel bands.',
    genderSplit: false,
    media: 'image',
    link: true,
    minItems: 0,
    maxItems: 4,
    copyFields: [],
    configFields: [],
    itemFields: [
      { key: 'tag', label: 'Eyebrow', kind: 'text', required: true, maxLength: 40 },
      { key: 'title', label: 'Title', kind: 'text', required: true, maxLength: 40 },
      { key: 'copy', label: 'Body copy', kind: 'textarea', required: true, maxLength: 200 },
    ],
  },

  'page.category_banners': {
    type: 'category_banner_map',
    tab: 'category_banners',
    label: 'Category banners',
    description:
      'The banner shown at the top of each category in Browse. The item key must be the category slug — that is how the screen looks it up.',
    genderSplit: true,
    media: 'image',
    link: false,
    minItems: 0,
    maxItems: 200,
    copyFields: [],
    configFields: [],
    itemFields: [
      { key: 'headline', label: 'Headline', kind: 'text', maxLength: 60 },
      // Placement is picked per banner by finding the emptiest region of the art, so the label
      // lands in negative space rather than across the model's face. It is two fields because
      // the screen positions horizontally and vertically independently.
      {
        key: 'textH',
        label: 'Text — horizontal',
        kind: 'text',
        help: 'left | center | right',
        maxLength: 6,
      },
      { key: 'textV', label: 'Text — vertical', kind: 'text', help: 'top | bottom', maxLength: 6 },
    ],
  },
} as const satisfies Record<string, CmsSectionSpec>;

export type CmsSectionKey = keyof typeof SECTION_SCHEMA;

export const CMS_SECTION_KEYS = Object.keys(SECTION_SCHEMA) as CmsSectionKey[];

export function isCmsSectionKey(key: string): key is CmsSectionKey {
  return Object.prototype.hasOwnProperty.call(SECTION_SCHEMA, key);
}

export function getSectionSpec(key: string): CmsSectionSpec | null {
  return isCmsSectionKey(key) ? (SECTION_SCHEMA[key] as CmsSectionSpec) : null;
}

/**
 * Admin tabs, in display order. `sections` is what the tab's panel renders, top to bottom.
 * Derived from the catalogue rather than listed twice, so a new section shows up in admin the
 * moment it is declared above.
 */
export const CMS_TABS = [
  { key: 'hero', label: 'Hero banners' },
  { key: 'explore', label: 'Categories to explore' },
  { key: 'steals', label: 'Steals' },
  { key: 'stories', label: 'Top stories' },
  { key: 'reels', label: 'Reels row' },
  { key: 'occasion', label: 'Shop by occasion' },
  { key: 'flash', label: 'Flash fit' },
  { key: 'tryon', label: 'Try & Buy' },
  { key: 'chrome', label: 'Header, marquee & footer' },
  { key: 'page_steals', label: 'Steals page' },
  { key: 'page_stories', label: 'Story pages' },
  { key: 'page_occasion', label: 'Occasion page' },
  { key: 'page_edits', label: 'Her / His Edit pages' },
  { key: 'category_banners', label: 'Category banners' },
] as const;

export type CmsTabKey = (typeof CMS_TABS)[number]['key'];

/** `{ tabKey: [sectionKey, …] }`, preserving catalogue order within each tab. */
export function sectionsByTab(): Record<string, CmsSectionKey[]> {
  const out: Record<string, CmsSectionKey[]> = {};
  for (const key of CMS_SECTION_KEYS) {
    const spec = SECTION_SCHEMA[key] as CmsSectionSpec;
    (out[spec.tab] ??= []).push(key);
  }
  return out;
}

/**
 * Which rails an item appears on. `all` shows on both, which is why it counts against both
 * rails' caps rather than being a free slot.
 */
export function railsOf(gender: 'her' | 'him' | 'all'): ('her' | 'him')[] {
  return gender === 'all' ? ['her', 'him'] : [gender];
}

/** The whole catalogue, shaped for the portal's form renderer. */
export function schemaPayload() {
  const byTab = sectionsByTab();
  return {
    routes: CMS_ROUTES,
    tabs: CMS_TABS.map((t) => ({
      ...t,
      sections: (byTab[t.key] ?? []).map((key) => ({
        key,
        ...(SECTION_SCHEMA[key] as CmsSectionSpec),
      })),
    })),
  };
}
