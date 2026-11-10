import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { textOnlyErrorResults, transformOAuthPayload, unaliasDisplayedText, unaliasStreamEvent } from "./payload.ts";

export function isAnthropicOAuth(ctx: Pick<ExtensionContext, "model" | "modelRegistry">): boolean {
	const model = ctx.model as Model<any> | undefined;
	return !!model && model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model);
}

export default function piCcUse(pi: ExtensionAPI): void {
	let activeOAuth = false;

	const syncActivation = (ctx: Pick<ExtensionContext, "model" | "modelRegistry">): void => {
		activeOAuth = isAnthropicOAuth(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		syncActivation(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		activeOAuth = isAnthropicOAuth({ model: event.model, modelRegistry: ctx.modelRegistry });
	});

	pi.on("session_shutdown", () => {
		activeOAuth = false;
	});

	pi.on("before_provider_request", (event, ctx) => {
		activeOAuth = isAnthropicOAuth(ctx);
		if ((ctx.model as Model<any> | undefined)?.provider !== "anthropic") return undefined;
		const payload = textOnlyErrorResults(event.payload);
		if (activeOAuth) return transformOAuthPayload(payload);
		return payload === event.payload ? undefined : payload;
	});

	// before_provider_request set activeOAuth for this request's stream.
	pi.on("provider_stream_event", (event) => {
		if (!activeOAuth || event.provider !== "anthropic") return;
		unaliasStreamEvent(event.data);
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		if (!activeOAuth || (context.messageType !== "assistant" && context.messageType !== "assistant-thinking")) {
			return markdown;
		}
		return unaliasDisplayedText(markdown);
	});
}

export * from "./aliases.ts";
export * from "./payload.ts";
