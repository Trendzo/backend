/**
 * MCP (Model Context Protocol) server for ClosetX commerce.
 *
 * Exposes the platform's public READ surface — products, offers, coupons, brands,
 * categories, collections — as MCP tools so third-party agentic layers can query us
 * through a single endpoint (POST /mcp) without installing anything. They point their
 * MCP client at our URL; every tool below maps 1:1 to an existing controller and is
 * called IN-PROCESS (no self-HTTP hop), so tools inherit the same DB reads, store
 * browsability rules, and envelope shaping the REST routes already enforce.
 *
 * Read-only by design: no tool mutates state. Adding write tools (place order, apply
 * coupon) later means wiring the consumer auth context through the transport first —
 * intentionally out of scope for this endpoint.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  listBrands,
  listCategories,
  listCollections,
  listFacets,
  listProducts,
  listProductReviews,
  listSizeScales,
  getCollection,
  getProduct,
} from '@/modules/catalog/catalog.controller.js';
import { listActivePromotions } from '@/modules/promotions/public.routes.js';
import {
  CollectionKindEnum,
  GenderEnum,
  ProductSortEnum,
} from '@/modules/catalog/catalog.validators.js';
import { AppError } from '@/shared/errors/app-error.js';
import type { SuccessEnvelope } from '@/shared/http/envelope.js';

/** MCP tool result — text content (for models) + structuredContent (for programmatic agents). */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Unwrap a controller's `{ success, data }` envelope into a tool result. */
function toolOk(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: { data },
  };
}

/** Translate a thrown AppError (or unknown) into a non-protocol tool error. */
function toolErr(e: unknown): ToolResult {
  const code = e instanceof AppError ? e.code : 'internal_error';
  const message = e instanceof AppError ? e.message : 'Internal error';
  return {
    content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
    isError: true,
  };
}

/**
 * Run a controller call and shape its envelope into a tool result. A thrown AppError
 * (e.g. 404 product-not-found) becomes `isError: true` rather than a JSON-RPC protocol
 * error, so the calling agent sees a clean, recoverable tool failure.
 */
async function run(fn: () => Promise<SuccessEnvelope<unknown>>): Promise<ToolResult> {
  try {
    const env = await fn();
    return toolOk(env.data);
  } catch (e) {
    return toolErr(e);
  }
}

const SERVER_INFO = { name: 'closetx-commerce', version: '0.1.0' } as const;

/**
 * Build a fresh McpServer with every tool registered. In stateless Streamable-HTTP
 * mode a new instance is created per request, so this must stay cheap and side-effect
 * free (tool handlers hit the DB lazily, only when actually called).
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      'ClosetX commerce read API. Use these tools to browse products, read offers and ' +
      'coupons, and resolve brands, categories, and curated collections. All tools are ' +
      'read-only. IDs returned by one tool (categoryId, storeId, listing id, collection ' +
      'slug) are the inputs for the others.',
  });

  server.registerTool(
    'search_products',
    {
      title: 'Search products',
      description:
        'Browse active product listings with their shoppable variants (price, images, ' +
        'availability). Filter by gender, category, store, or free-text name search. ' +
        'Paginated; newest-first unless `sort` says otherwise.',
      inputSchema: {
        gender: GenderEnum.optional().describe("'her' | 'him' | 'unisex'"),
        categoryId: z
          .string()
          .optional()
          .describe('Category id from list_categories. Includes sub-categories.'),
        categorySlug: z
          .string()
          .optional()
          .describe("Category slug, e.g. 'tops' or 'tops-tshirts'. Includes sub-categories."),
        storeId: z.string().optional().describe('Restrict to a single store'),
        search: z.string().min(1).max(120).optional().describe('Case-insensitive name match'),
        sort: ProductSortEnum.default('newest').describe(
          "'newest' | 'price_asc' | 'price_desc' | 'rating'",
        ),
        limit: z.number().int().positive().max(100).default(50),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async (args) =>
      run(() =>
        listProducts({
          query: {
            ...(args.gender !== undefined && { gender: args.gender }),
            ...(args.categoryId !== undefined && { categoryId: args.categoryId }),
            ...(args.categorySlug !== undefined && { categorySlug: args.categorySlug }),
            ...(args.storeId !== undefined && { storeId: args.storeId }),
            ...(args.search !== undefined && { search: args.search }),
            sort: args.sort,
            // MCP consumers want the whole listing, not the grid-card subset.
            view: 'full' as const,
            limit: args.limit,
            offset: args.offset,
          },
        }),
      ),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        'Fetch a single active product listing by id, with variants, groups, brand, ' +
        'category, store, and rating. Errors if not found or its store is not browsable.',
      inputSchema: { id: z.string().describe('Listing id') },
    },
    async (args) => run(() => getProduct(args.id)),
  );

  server.registerTool(
    'list_product_reviews',
    {
      title: 'List product reviews',
      description: 'Active reviews for a product listing, newest first. Paginated.',
      inputSchema: {
        listingId: z.string().describe('Listing id'),
        limit: z.number().int().positive().max(100).default(20),
        offset: z.number().int().nonnegative().default(0),
      },
    },
    async (args) =>
      run(() =>
        listProductReviews(args.listingId, { limit: args.limit, offset: args.offset }),
      ),
  );

  server.registerTool(
    'list_active_promotions',
    {
      title: 'List active offers and coupons',
      description:
        'All live promotions right now — both auto-applied offers and typeable coupon ' +
        'codes. For coupons, `code` is the string a shopper enters at checkout. Includes ' +
        'the discount config (percent / amount / caps) and any store scope.',
    },
    async () => run(() => listActivePromotions()),
  );

  server.registerTool(
    'list_categories',
    {
      title: 'List categories',
      description:
        'The category tree, flat — build it with `parentId`. Two levels: parents like ' +
        "'tops' and leaves like 'tops-tshirts'. Filtering by gender returns that gender " +
        'plus shared (unisex) nodes.',
      inputSchema: {
        gender: GenderEnum.optional(),
        activeOnly: z.boolean().default(true).describe('Only active categories'),
        withCounts: z
          .boolean()
          .default(false)
          .describe('Attach descendant-inclusive listingCount to each row'),
      },
    },
    async (args) =>
      run(() =>
        listCategories({
          query: {
            ...(args.gender !== undefined && { gender: args.gender }),
            activeOnly: args.activeOnly,
            withCounts: args.withCounts,
          },
        }),
      ),
  );

  server.registerTool(
    'list_brands',
    {
      title: 'List brands',
      description: 'Brands, alphabetical.',
      inputSchema: { activeOnly: z.boolean().default(true).describe('Only active brands') },
    },
    async (args) => run(() => listBrands({ query: { activeOnly: args.activeOnly } })),
  );

  server.registerTool(
    'list_collections',
    {
      title: 'List collections',
      description:
        'Curated collections (outfits, occasions, drops, edits, trends) that are live ' +
        'now, with piece counts and bundle price. Filter by kind, gender, or featured.',
      inputSchema: {
        kind: CollectionKindEnum.optional().describe(
          "'outfit' | 'occasion' | 'drop' | 'edit' | 'trend'",
        ),
        gender: GenderEnum.optional(),
        featured: z.boolean().optional(),
      },
    },
    async (args) =>
      run(() =>
        listCollections({
          query: {
            ...(args.kind !== undefined && { kind: args.kind }),
            ...(args.gender !== undefined && { gender: args.gender }),
            ...(args.featured !== undefined && { featured: args.featured }),
          },
        }),
      ),
  );

  server.registerTool(
    'get_collection',
    {
      title: 'Get collection',
      description:
        'A single active collection by slug, with its resolved member listings shaped ' +
        'like search_products results.',
      inputSchema: { slug: z.string().describe('Collection slug') },
    },
    async (args) => run(() => getCollection(args.slug)),
  );

  server.registerTool(
    'list_facets',
    {
      title: 'List product facets',
      description:
        'Faceted counts over active listings — products per gender and per category — ' +
        'for building browse nav. Each facet excludes its own dimension from its counts.',
      inputSchema: {
        gender: GenderEnum.optional(),
        categoryId: z.string().optional().describe('Includes sub-categories'),
        categorySlug: z.string().optional().describe('Includes sub-categories'),
        storeId: z.string().optional(),
        search: z.string().min(1).max(120).optional(),
      },
    },
    async (args) =>
      run(() =>
        listFacets({
          query: {
            ...(args.gender !== undefined && { gender: args.gender }),
            ...(args.categoryId !== undefined && { categoryId: args.categoryId }),
            ...(args.categorySlug !== undefined && { categorySlug: args.categorySlug }),
            ...(args.storeId !== undefined && { storeId: args.storeId }),
            ...(args.search !== undefined && { search: args.search }),
          },
        }),
      ),
  );

  server.registerTool(
    'list_size_scales',
    {
      title: 'List size scales',
      description:
        'Size scales, optionally narrowed to those applicable to a category (universal ' +
        'scales plus any matching the category or its ancestors).',
      inputSchema: { categoryId: z.string().optional() },
    },
    async (args) =>
      run(() =>
        listSizeScales({
          query: { ...(args.categoryId !== undefined && { categoryId: args.categoryId }) },
        }),
      ),
  );

  return server;
}