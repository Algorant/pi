import type { ApiMedia, ApiTweet, Thread } from "./note.ts";
import { NO_THREAD } from "./note.ts";
import { conversationPage, XurlError, type XurlExec } from "./xurl.ts";

// Self-thread follow-ups. X offers only search by conversation_id; recent search covers about 7 days, so this
// reads the full archive (search/all) with one request per thread: `conversation_id:<id> from:<handle>`. That
// returns every post by the author in the conversation, replies to commenters included, so only the chain of
// the author's own replies starting at the bookmarked post is kept.

/** Posts of `tweets` that reply (directly or transitively) to `headId`, oldest first. */
export function selectChain(headId: string, tweets: ApiTweet[]): ApiTweet[] {
	const sorted = [...tweets].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
	const chain = new Set<string>([headId]);
	const out: ApiTweet[] = [];
	for (const tweet of sorted) {
		if (chain.has(tweet.id)) continue;
		const parent = tweet.referenced_tweets?.find((r) => r.type === "replied_to")?.id;
		if (parent && chain.has(parent)) {
			chain.add(tweet.id);
			out.push(tweet);
		}
	}
	return out;
}

export type ThreadRead = { thread: Thread; failure?: string };

/** One read for one thread head. Never throws except on abort: a failed read is reported as an unavailable thread. */
export async function readThread(exec: XurlExec, headId: string, conversationId: string, handle: string, signal?: AbortSignal): Promise<ThreadRead> {
	try {
		const page = await conversationPage(exec, conversationId, handle, signal);
		const followUps = selectChain(headId, (page.data as ApiTweet[]).filter((t) => t && /^\d+$/.test(String(t.id))));
		if (!followUps.length && !page.nextToken) return { thread: NO_THREAD };
		const media = (page.includes.media ?? []) as ApiMedia[];
		return { thread: { state: page.nextToken ? "partial" : "complete", followUps, media } };
	} catch (error) {
		if (error instanceof XurlError && error.kind === "aborted") throw error;
		return { thread: { state: "unavailable", followUps: [], media: [] }, failure: error instanceof Error ? error.message : String(error) };
	}
}
