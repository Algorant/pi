import { httpUrl, type ApiMedia, type ApiTweet, type ApiUrl, type Includes } from "./note.ts";

// Cover lookup. Order: the post's own photo/video thumbnail/GIF, media of the quoted or replied-to post, an X
// article's cover image, the preview image of the first expanded link; only a genuinely text-only post gets a
// generated card. A post that should have a cover but whose lookup yields nothing is a failure, never a card.

export type CoverSource = "media" | "quoted media" | "article" | "link";

export type Cover =
	| { kind: "url"; url: string; from: CoverSource }
	| { kind: "card" }
	| { kind: "failed"; reason: string };

const X_HOST = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i;

function largestImage(entity: ApiUrl): string | undefined {
	const images = (entity.images ?? []).filter((i) => httpUrl(i.url));
	images.sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
	return httpUrl(images[0]?.url);
}

export function resolveCover(tweet: ApiTweet, includes: Includes): Cover {
	const media = new Map((includes.media ?? []).map((m: ApiMedia) => [m.media_key, m]));
	const tweets = new Map((includes.tweets ?? []).map((t) => [t.id, t]));
	const missing: string[] = [];

	const mediaUrl = (key: string | undefined): string | undefined => {
		const item = key ? media.get(key) : undefined;
		return item ? httpUrl(item.url) ?? httpUrl(item.preview_image_url) : undefined;
	};
	const fromAttachments = (t: ApiTweet, label: string): string | undefined => {
		const keys = t.attachments?.media_keys ?? [];
		for (const key of keys) {
			const url = mediaUrl(key);
			if (url) return url;
		}
		if (keys.length) missing.push(`${label} media has no usable image in the X response`);
		return undefined;
	};

	const own = fromAttachments(tweet, "the post's");
	if (own) return { kind: "url", url: own, from: "media" };

	const refs: ApiTweet[] = [];
	for (const ref of tweet.referenced_tweets ?? []) {
		const t = ref.id ? tweets.get(ref.id) : undefined;
		if (t) refs.push(t);
		else missing.push(`the ${ref.type ?? "referenced"} post was not expanded in the X response`);
	}
	for (const t of refs) {
		const url = fromAttachments(t, "the referenced post's");
		if (url) return { kind: "url", url, from: "quoted media" };
	}

	for (const t of [tweet, ...refs]) {
		if (!t.article) continue;
		const url = mediaUrl(t.article.cover_media);
		if (url) return { kind: "url", url, from: "article" };
		missing.push(t.article.cover_media ? "the article cover is not in the X response" : "the article has no cover image");
	}

	const entities = [...(tweet.entities?.urls ?? []), ...(tweet.note_tweet?.entities?.urls ?? [])];
	for (const entity of entities) {
		const expanded = httpUrl(entity.expanded_url);
		if (!expanded || entity.media_key || X_HOST.test(expanded)) continue;
		const url = largestImage(entity);
		if (url) return { kind: "url", url, from: "link" };
	}

	return missing.length ? { kind: "failed", reason: missing[0] } : { kind: "card" };
}
