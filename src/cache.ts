import { CacheLoadResult, GiteaIssue, IssueRef, MAX_BACKOFF_MS } from "./types";

/** Per-key state held by {@link CoalescingCache}. */
export interface CacheEntry<T> {
	/** Last successfully fetched value — the stale/offline fallback source. */
	value: T | null;
	/** When `value` was last refreshed (ms epoch). */
	fetchedAt: number;
	/** In-flight request shared by every concurrent caller (the coalescer). */
	inFlight: Promise<CacheLoadResult<T>> | null;
	/** Consecutive failures, driving the exponential backoff. */
	failureCount: number;
	/** Earliest time (ms epoch) a new fetch is allowed while backing off. */
	nextRetryAt: number;
	/** Most recent error, surfaced on the stale/error card. */
	lastError: Error | null;
}

/**
 * Shared in-memory cache and request coalescer, generic over the lookup
 * argument and the fetched value.
 *
 * Gitea exposes no ETag and no rate limiter, so the plugin must self-throttle.
 * This collapses N callers pointing at the same key down to a single fetch per
 * interval (via a freshness window plus a shared in-flight promise) and, when
 * the server is unreachable, serves the last-known value as stale data while
 * backing off exponentially until it recovers. Single-issue cards (keyed by
 * `owner/repo#index`) and search blocks (keyed by their query) share it.
 */
export class CoalescingCache<TArg, TValue> {
	private readonly entries = new Map<string, CacheEntry<TValue>>();

	constructor(
		private readonly keyOf: (arg: TArg) => string,
		private readonly fetcher: (arg: TArg) => Promise<TValue>
	) {}

	private ensure(key: string): CacheEntry<TValue> {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = {
				value: null,
				fetchedAt: 0,
				inFlight: null,
				failureCount: 0,
				nextRetryAt: 0,
				lastError: null,
			};
			this.entries.set(key, entry);
		}
		return entry;
	}

	/** Drop a cached entry so the next load fetches fresh (used after edits). */
	invalidate(arg: TArg): void {
		this.entries.delete(this.keyOf(arg));
	}

	/**
	 * Resolve the value for `arg`, fetching only when necessary. Data younger
	 * than ~80% of the refresh interval is reused without a network call so
	 * callers on the same key coalesce to one fetch per interval; concurrent
	 * callers share one in-flight request; and while backing off after failures
	 * the last-known value is returned as stale rather than re-hitting the server.
	 */
	async load(arg: TArg, intervalMs: number): Promise<CacheLoadResult<TValue>> {
		const entry = this.ensure(this.keyOf(arg));
		const now = Date.now();
		const maxAgeMs = Math.max(0, intervalMs * 0.8);

		// Fresh enough — serve from cache, no fetch (cross-caller coalescing).
		if (entry.value !== null && now - entry.fetchedAt < maxAgeMs) {
			return { value: entry.value, stale: false, error: null };
		}
		// Backing off — serve stale data (or the last error) without a request.
		if (now < entry.nextRetryAt) {
			return entry.value !== null
				? { value: entry.value, stale: true, error: entry.lastError }
				: { value: null, stale: false, error: entry.lastError };
		}
		// Coalesce every concurrent caller onto one shared request.
		if (!entry.inFlight) {
			entry.inFlight = this.runFetch(arg, entry, intervalMs);
		}
		return entry.inFlight;
	}

	private async runFetch(
		arg: TArg,
		entry: CacheEntry<TValue>,
		intervalMs: number
	): Promise<CacheLoadResult<TValue>> {
		try {
			const value = await this.fetcher(arg);
			entry.value = value;
			entry.fetchedAt = Date.now();
			entry.failureCount = 0;
			entry.nextRetryAt = 0;
			entry.lastError = null;
			return { value, stale: false, error: null };
		} catch (error) {
			const err =
				error instanceof Error ? error : new Error("Failed to load.");
			entry.failureCount += 1;
			entry.lastError = err;
			const backoff = Math.min(
				MAX_BACKOFF_MS,
				intervalMs * Math.pow(2, entry.failureCount - 1)
			);
			entry.nextRetryAt = Date.now() + backoff;
			return entry.value !== null
				? { value: entry.value, stale: true, error: err }
				: { value: null, stale: false, error: err };
		} finally {
			entry.inFlight = null;
		}
	}
}

/**
 * Shared cache/coalescer for single-issue cards, keyed by `owner/repo#index`.
 * A thin specialisation of {@link CoalescingCache} preserving the F1/F2 API.
 */
export class IssueCache extends CoalescingCache<IssueRef, GiteaIssue> {
	constructor(fetcher: (ref: IssueRef) => Promise<GiteaIssue>) {
		super((ref) => `${ref.owner}/${ref.repo}#${ref.index}`, fetcher);
	}
}
