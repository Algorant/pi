import os from "node:os";
import path from "node:path";

// Read-only X access through xurl. Every call is launched as
//   fnox --non-interactive -c <manifest> exec -- xurl <args>
// (argv, no shell) so xurl receives its app credentials from the operator's value-free fnox manifest.
// There is no bare-xurl path, no login, and no retry. Credential values never pass through this code.

export type XurlExec = (
	command: string,
	args: string[],
	options?: { signal?: AbortSignal; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;

export type XurlErrorKind = "operator" | "auth" | "rate-limit" | "timeout" | "aborted" | "api";

export class XurlError extends Error {
	constructor(readonly kind: XurlErrorKind, message: string) {
		super(message);
		this.name = "XurlError";
	}
}

export const XURL_TIMEOUT_MS = 30_000;
const MANIFEST_RELATIVE = [".config", "fnox", "manifests", "xurl.toml"];

const OPERATOR_HINT = "operator: sign in to pass-cli / restore the xurl fnox manifest (~/.config/fnox/manifests/xurl.toml). Nothing was retried and bare xurl was not used.";
const AUTH_HINT = "X rejected the OAuth2 session or it is unusable. No login or retry was attempted; operator: re-authenticate xurl (see the utils skill, Secrets).";

export function xurlManifestPath(): string {
	return path.join(os.homedir(), ...MANIFEST_RELATIVE);
}

export function xurlLaunch(args: string[]): { command: string; args: string[] } {
	return { command: "fnox", args: ["--non-interactive", "-c", xurlManifestPath(), "exec", "--", "xurl", ...args] };
}

/** One safe diagnostic line: no ANSI, no long token-like runs, bounded length. */
export function diagnostic(text: string): string {
	const line = text.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/).map((s) => s.trim()).find(Boolean) ?? "";
	return line.replace(/[A-Za-z0-9_\-.]{24,}/g, "<redacted>").slice(0, 200);
}

/** Map failure text (fnox, pass-cli, xurl, or an X error body) to a clear, non-retrying error. */
export function classifyFailure(text: string): XurlError {
	const detail = diagnostic(text);
	const suffix = detail ? ` (${detail})` : "";
	if (/fnox::|\bfnox\b|pass-cli|proton/i.test(text) && !/Auth Error/i.test(text)) return new XurlError("operator", `${OPERATOR_HINT}${suffix}`);
	if (/\b429\b|too many requests|rate.?limit/i.test(text)) return new XurlError("rate-limit", `X rate limit reached (HTTP 429). Not retried; try again later.${suffix}`);
	if (/\b40[13]\b|unauthori[sz]ed|forbidden|NoAuthMethod|RefreshTokenError|Auth Error|expired|invalid[_ ]token/i.test(text)) return new XurlError("auth", `${AUTH_HINT}${suffix}`);
	return new XurlError("api", `xurl request failed${suffix || ": no diagnostic output"}`);
}

async function runXurl(exec: XurlExec, args: string[], signal?: AbortSignal): Promise<unknown> {
	if (signal?.aborted) throw new XurlError("aborted", "X read aborted.");
	const launch = xurlLaunch(args);
	let result: Awaited<ReturnType<XurlExec>>;
	try {
		result = await exec(launch.command, launch.args, { signal, timeout: XURL_TIMEOUT_MS });
	} catch (error) {
		if (signal?.aborted) throw new XurlError("aborted", "X read aborted.");
		const err = error as { code?: unknown; message?: unknown };
		if (err?.code === "ENOENT") throw new XurlError("operator", `fnox is not installed or not on PATH. ${OPERATOR_HINT}`);
		throw new XurlError("api", `Could not run xurl: ${diagnostic(String(err?.message ?? error))}`);
	}
	if (signal?.aborted) throw new XurlError("aborted", "X read aborted.");
	if (result.killed) throw new XurlError("timeout", `xurl timed out after ${XURL_TIMEOUT_MS} ms. Not retried.`);
	const stdout = result.stdout ?? "";
	const combined = `${stdout}\n${result.stderr ?? ""}`;
	if (result.code !== 0) throw classifyFailure(combined);
	// Misconfigured fnox prints an error and still exits 0 in some paths; xurl prints JSON.
	const trimmed = stdout.trim();
	if (!trimmed.startsWith("{")) throw classifyFailure(combined);
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new XurlError("api", `xurl returned unparseable output (${diagnostic(trimmed)}).`);
	}
	return parsed;
}

/** An X error body has no `data` and no `meta` (`title`/`detail`/`status`, or an `errors` array). */
function assertNotApiError(body: Record<string, unknown>): void {
	if (body.data !== undefined || body.meta !== undefined) return;
	const errors = Array.isArray(body.errors) ? (body.errors as Array<Record<string, unknown>>) : [];
	const first = errors[0] ?? {};
	const text = [body.status, body.title, body.detail, first.title, first.detail, first.message].filter((v) => v !== undefined).map(String).join(" ");
	throw classifyFailure(text || JSON.stringify(body).slice(0, 200));
}

export async function whoami(exec: XurlExec, signal?: AbortSignal): Promise<{ id: string; username: string }> {
	const body = (await runXurl(exec, ["whoami"], signal)) as { data?: { id?: unknown; username?: unknown } };
	assertNotApiError(body as Record<string, unknown>);
	const id = body.data?.id;
	if (typeof id !== "string" || !/^\d+$/.test(id)) throw new XurlError("api", "xurl whoami returned no user id.");
	return { id, username: String(body.data?.username ?? "") };
}

export const TWEET_FIELDS = "created_at,conversation_id,entities,note_tweet,referenced_tweets,lang,attachments,article,public_metrics";
export const EXPANSIONS = "author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys,article.cover_media";
export const USER_FIELDS = "username,name,profile_image_url,description,entities";
export const MEDIA_FIELDS = "type,url,preview_image_url,alt_text";

export type Includes = { tweets?: unknown[]; users?: unknown[]; media?: unknown[] };

export type BookmarksPage = {
	data: unknown[];
	includes: Includes;
	nextToken?: string;
};

/** One bookmarks page (newest first). Explicit GET; never a write endpoint. */
export async function bookmarksPage(exec: XurlExec, userId: string, maxResults: number, paginationToken: string | undefined, signal?: AbortSignal): Promise<BookmarksPage> {
	if (!/^\d+$/.test(userId)) throw new XurlError("api", "Invalid X user id.");
	const query = [
		`max_results=${maxResults}`,
		paginationToken ? `pagination_token=${encodeURIComponent(paginationToken)}` : "",
		`tweet.fields=${TWEET_FIELDS}`,
		`expansions=${EXPANSIONS}`,
		`user.fields=${USER_FIELDS}`,
		`media.fields=${MEDIA_FIELDS}`,
	].filter(Boolean).join("&");
	const body = (await runXurl(exec, ["-X", "GET", `/2/users/${userId}/bookmarks?${query}`], signal)) as Record<string, any>;
	assertNotApiError(body);
	return {
		data: Array.isArray(body.data) ? body.data : [],
		includes: body.includes && typeof body.includes === "object" ? body.includes : {},
		nextToken: typeof body.meta?.next_token === "string" ? body.meta.next_token : undefined,
	};
}

const CONVERSATION_PAGE_SIZE = 100;

/**
 * One full-archive search page for the author's own posts in one conversation (`conversation_id:<id> from:<handle>`).
 * Recent search only covers about 7 days, so this reads search/all. Explicit GET; one request per thread.
 */
export async function conversationPage(exec: XurlExec, conversationId: string, handle: string, signal?: AbortSignal): Promise<BookmarksPage> {
	if (!/^\d+$/.test(conversationId)) throw new XurlError("api", "Invalid X conversation id.");
	if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new XurlError("api", "Invalid X handle.");
	const query = [
		`query=${encodeURIComponent(`conversation_id:${conversationId} from:${handle}`)}`,
		`max_results=${CONVERSATION_PAGE_SIZE}`,
		"tweet.fields=created_at,author_id,referenced_tweets,note_tweet,entities,attachments",
		"expansions=attachments.media_keys",
		`media.fields=${MEDIA_FIELDS}`,
	].join("&");
	const body = (await runXurl(exec, ["-X", "GET", `/2/tweets/search/all?${query}`], signal)) as Record<string, any>;
	assertNotApiError(body);
	// Observed: search/all returns a next_token even when the page is not full (its next page only repeats the
	// oldest post), so more posts exist only when this page is full.
	const full = Number(body.meta?.result_count) >= CONVERSATION_PAGE_SIZE;
	return {
		data: Array.isArray(body.data) ? body.data : [],
		includes: body.includes && typeof body.includes === "object" ? body.includes : {},
		nextToken: full && typeof body.meta?.next_token === "string" ? body.meta.next_token : undefined,
	};
}
