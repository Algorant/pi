#!/usr/bin/env bun
/**
 * Measure Pi's standing per-request prompt cost by source.
 *
 * Static file sizes and `characters / 4` cannot answer this. Generated tool
 * schemas never appear on disk, providers carry standing text in different
 * payload fields, and skill bodies are not standing cost at all. This script
 * measures the real outgoing payload instead.
 *
 * It has two roles in one file:
 *
 * - As a Pi extension, loaded explicitly with `pi -e`, it observes
 *   `before_agent_start` and `before_provider_request` and writes a capture.
 *   It never modifies a payload.
 * - As a CLI, it drives one headless `pi --print` run per model, pointing
 *   `-e` at itself, then prints a comparison table.
 *
 * It is deliberately not an auto-discovered extension. Nothing is loaded into
 * ordinary Pi sessions; measurement happens only when this script is run.
 *
 * Run it with no arguments. It measures every model in `enabledModels` and
 * writes captures to `~/.pi/cache/prompt-audit`.
 *
 * Standing cost depends on the working directory, because context-file
 * discovery and Tandem detection follow cwd. Run it from the same place when
 * comparing results.
 *
 * Privacy: context-file and skill text is measured and discarded. Prompt
 * guideline and tool snippet text is recorded, because the duplicate report
 * depends on it and that text is this project's own policy prose.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function byteLength(text) {
	if (!text) return 0;
	return encoder.encode(text).length;
}

/** UTF-8 byte length of a value once serialized as wire JSON. */
export function jsonByteLength(value) {
	if (value === undefined) return 0;
	try {
		return byteLength(JSON.stringify(value));
	} catch {
		return 0;
	}
}

function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Recursively total every `description` string inside a JSON schema.
 *
 * A raw schema size hides this. Parameter descriptions are written guidance
 * that can move or shrink; types, enums, and required lists are a mechanical
 * contract that cannot.
 */
export function schemaDescriptionBytes(value) {
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + schemaDescriptionBytes(item), 0);
	if (!isRecord(value)) return 0;
	let total = 0;
	for (const [key, child] of Object.entries(value)) {
		if (key === "description" && typeof child === "string") {
			total += byteLength(child);
			continue;
		}
		total += schemaDescriptionBytes(child);
	}
	return total;
}

/** Layers whose text may be captured, and only on request. */
const TEXT_CAPTURE_LAYERS = new Set(["prompt-guideline", "tool-snippet"]);

/**
 * Measure the structured base inputs Pi uses to build the system prompt.
 *
 * Accepts `event.systemPromptOptions` or `getSystemPromptOptions()` output.
 * Skills contribute only metadata; `Skill` carries no body, so skill files are
 * on-demand cost rather than standing cost.
 */
export function measurePromptOptions(options, includeGuidanceText = false) {
	if (!isRecord(options)) return [];
	const out = [];
	const withText = (source, value) =>
		includeGuidanceText && TEXT_CAPTURE_LAYERS.has(source.layer) ? { ...source, text: value } : source;

	if (typeof options.customPrompt === "string") {
		out.push({ key: "core-prompt:custom", layer: "core-prompt", bytes: byteLength(options.customPrompt), load: "standing" });
	}
	if (typeof options.appendSystemPrompt === "string" && options.appendSystemPrompt.length > 0) {
		out.push({
			key: "appended:--append-system-prompt",
			layer: "appended-prompt",
			bytes: byteLength(options.appendSystemPrompt),
			load: "standing",
		});
	}
	if (Array.isArray(options.contextFiles)) {
		for (const file of options.contextFiles) {
			if (!isRecord(file) || typeof file.path !== "string") continue;
			out.push({
				key: `context-file:${file.path}`,
				layer: "context-file",
				bytes: byteLength(typeof file.content === "string" ? file.content : ""),
				load: "standing",
				detail: file.path,
			});
		}
	}
	if (isRecord(options.toolSnippets)) {
		for (const [tool, snippet] of Object.entries(options.toolSnippets)) {
			if (typeof snippet !== "string") continue;
			out.push(
				withText(
					{ key: `tool-snippet:${tool}`, layer: "tool-snippet", bytes: byteLength(snippet), load: "standing", detail: tool },
					snippet,
				),
			);
		}
	}
	if (Array.isArray(options.promptGuidelines)) {
		options.promptGuidelines.forEach((line, index) => {
			if (typeof line !== "string") return;
			out.push(
				withText(
					{
						key: `prompt-guideline:${index}`,
						layer: "prompt-guideline",
						bytes: byteLength(line),
						load: "standing",
						detail: line.slice(0, 60),
					},
					line,
				),
			);
		});
	}
	if (Array.isArray(options.skills)) {
		for (const skill of options.skills) {
			if (!isRecord(skill)) continue;
			const name = typeof skill.name === "string" ? skill.name : "unknown";
			out.push({
				key: `skill-metadata:${name}`,
				layer: "skill-metadata",
				bytes:
					byteLength(name) +
					byteLength(typeof skill.description === "string" ? skill.description : "") +
					byteLength(typeof skill.location === "string" ? skill.location : ""),
				load: "standing",
				detail: name,
			});
		}
	}
	return out;
}

const SYSTEM_ROLES = new Set(["system", "developer"]);

/**
 * Report whether this capture is before or after `pi-cc-use`'s OAuth rewrite.
 *
 * Extension handler order decides what a `before_provider_request` observer
 * sees. Loaded with `-e`, this script can run before `pi-cc-use` renames tools
 * to `mcp__pi_cc__*` and rewrites the same names inside the system prompt.
 * The pre-rewrite figure understates the true Anthropic wire cost by roughly
 * 12 bytes per custom tool name, in both the tool list and the prompt text, so
 * a capture must say which side of the rewrite it observed rather than let the
 * difference look like measurement noise.
 */
export function rewriteStage(tools) {
	if (tools.length === 0) return "unknown";
	return tools.some((tool) => tool.name.startsWith("mcp__")) ? "post-rewrite" : "pre-rewrite";
}

function messageContentBytes(content) {
	if (typeof content === "string") return byteLength(content);
	if (!Array.isArray(content)) return jsonByteLength(content);
	return content.reduce((sum, block) => {
		if (typeof block === "string") return sum + byteLength(block);
		if (isRecord(block) && typeof block.text === "string") return sum + byteLength(block.text);
		return sum + jsonByteLength(block);
	}, 0);
}

function systemBlockSizes(system) {
	if (typeof system === "string") return [byteLength(system)];
	if (!Array.isArray(system)) return [];
	return system.map((block) => {
		if (typeof block === "string") return byteLength(block);
		if (isRecord(block) && typeof block.text === "string") return byteLength(block.text);
		return jsonByteLength(block);
	});
}

function measureTool(tool) {
	if (!isRecord(tool)) return undefined;
	const name = typeof tool.name === "string" ? tool.name : "(typed-tool)";
	const description = typeof tool.description === "string" ? tool.description : "";
	const schema = tool.input_schema ?? tool.parameters ?? (isRecord(tool.function) ? tool.function.parameters : undefined);
	const descriptionBytes = byteLength(description);
	const schemaBytes = jsonByteLength(schema);
	const nestedProse = schemaDescriptionBytes(schema);
	return {
		name,
		descriptionBytes,
		schemaBytes,
		schemaDescriptionBytes: nestedProse,
		proseBytes: descriptionBytes + nestedProse,
		structuralBytes: Math.max(0, schemaBytes - nestedProse),
		totalBytes: byteLength(name) + descriptionBytes + schemaBytes,
	};
}

/**
 * Measure a final provider payload.
 *
 * Providers disagree about where standing instructions live: Anthropic uses
 * `system`, the OpenAI Responses API uses `instructions`, and chat-completions
 * style uses a leading system/developer message. A measurement that knows only
 * one shape silently reports zero for the others.
 */
export function measurePayload(payload) {
	const empty = {
		systemBytes: 0,
		systemBlocks: [],
		systemCarrier: "none",
		toolCount: 0,
		toolBytes: 0,
		tools: [],
		messageBytes: 0,
		totalBytes: 0,
		payloadKeys: [],
	};
	if (!isRecord(payload)) return empty;

	let systemBlocks = systemBlockSizes(payload.system);
	let systemCarrier = systemBlocks.length > 0 ? "system" : "none";

	if (systemCarrier === "none" && typeof payload.instructions === "string") {
		systemBlocks = [byteLength(payload.instructions)];
		systemCarrier = "instructions";
	}

	let messageBytes = 0;
	if (Array.isArray(payload.messages)) {
		const leadingSystem = [];
		for (const message of payload.messages) {
			const role = isRecord(message) && typeof message.role === "string" ? message.role : "";
			const bytes = isRecord(message) ? messageContentBytes(message.content) : jsonByteLength(message);
			if (SYSTEM_ROLES.has(role)) leadingSystem.push(bytes);
			else messageBytes += bytes;
		}
		if (systemCarrier === "none" && leadingSystem.length > 0) {
			systemBlocks = leadingSystem;
			systemCarrier = "messages";
		} else if (leadingSystem.length > 0) {
			systemBlocks = [...systemBlocks, ...leadingSystem];
		}
	}

	const tools = [];
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			const measured = measureTool(tool);
			if (measured) tools.push(measured);
		}
	}
	const systemBytes = systemBlocks.reduce((sum, size) => sum + size, 0);
	const toolBytes = tools.reduce((sum, tool) => sum + tool.totalBytes, 0);

	return {
		systemBytes,
		systemBlocks,
		systemCarrier,
		toolCount: tools.length,
		toolBytes,
		tools,
		messageBytes,
		totalBytes: systemBytes + toolBytes + messageBytes,
		payloadKeys: Object.keys(payload).sort(),
		rewriteStage: rewriteStage(tools),
	};
}

/** Group tool measurements by owning extension, inferred from tool name. */
export function groupToolsByOwner(tools) {
	const rules = [
		[/sideshow_/, "pi-sideshow"],
		[/tandem_/, "pi-tandem"],
		[/(subagent_|worker_|conversation_fork)/, "pi-agency"],
		[/(web_search|fetch_content|code_search|get_search_content)/, "pi-web-tools"],
		[/memory_/, "pi-memory"],
		[/ask_me/, "pi-ask-me"],
		[/manage_todo_list/, "pi-todos"],
	];
	const out = new Map();
	for (const tool of tools) {
		const owner = rules.find(([pattern]) => pattern.test(tool.name))?.[1] ?? "core/other";
		const entry = out.get(owner) ?? { owner, tools: 0, prose: 0, structural: 0, total: 0 };
		entry.tools += 1;
		entry.prose += tool.proseBytes;
		entry.structural += tool.structuralBytes;
		entry.total += tool.totalBytes;
		out.set(owner, entry);
	}
	return [...out.values()].sort((a, b) => b.total - a.total);
}

/** Count exact duplicate strings and the bytes wasted repeating them. */
export function findDuplicates(items) {
	const counts = new Map();
	for (const text of items) counts.set(text, (counts.get(text) ?? 0) + 1);
	const duplicates = [];
	let repeatedBytes = 0;
	for (const [text, count] of counts) {
		if (count < 2) continue;
		const bytes = byteLength(text);
		repeatedBytes += bytes * (count - 1);
		duplicates.push({ text, count, bytes, wasted: bytes * (count - 1) });
	}
	duplicates.sort((a, b) => b.wasted - a.wasted);
	return { unique: counts.size, total: items.length, duplicates, repeatedBytes };
}

// --- Pi extension role -------------------------------------------------------

const OUT_DIR = join(homedir(), ".pi", "cache", "prompt-audit");
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Pi extension entry point, used only via `pi -e <this file>`.
 *
 * Strictly observational: both handlers return undefined.
 */
export default function measureStandingPrompt(pi) {
	let agentStart;

	pi.on("before_agent_start", (event, ctx) => {
		const model = ctx.model;
		agentStart = {
			systemPromptBytes: byteLength(event.systemPrompt),
			contextFileCount: Array.isArray(event.systemPromptOptions?.contextFiles)
				? event.systemPromptOptions.contextFiles.length
				: 0,
			skillCount: Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills.length : 0,
			sources: measurePromptOptions(event.systemPromptOptions, true),
			provider: model?.provider,
			modelId: model?.id,
		};
		return undefined;
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		const record = {
			provider: model?.provider,
			modelId: model?.id,
			capturedAt: new Date().toISOString(),
			payload: measurePayload(event.payload),
			agentStart,
		};
		try {
			mkdirSync(OUT_DIR, { recursive: true });
			const safe = `${model?.provider ?? "unknown"}_${model?.id ?? "unknown"}`.replace(/[^A-Za-z0-9._-]/g, "_");
			writeFileSync(join(OUT_DIR, `capture-${safe}-${record.capturedAt.replace(/[:.]/g, "-")}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
		} catch {
			// A diagnostic must never break a real request.
		}
		return undefined;
	});
}

// --- CLI role ----------------------------------------------------------------

function pad(text, width, right = false) {
	const value = String(text);
	return right ? value.padStart(width) : value.padEnd(width);
}

/**
 * Models to measure, taken from `enabledModels` in settings.
 *
 * Reading the live setting keeps the script honest when models are added or
 * removed, and removes any reason to pass model names by hand.
 */
export function enabledModels(settingsJson) {
	try {
		const settings = JSON.parse(settingsJson);
		if (Array.isArray(settings.enabledModels) && settings.enabledModels.length > 0) return settings.enabledModels;
		if (settings.defaultProvider && settings.defaultModel) return [`${settings.defaultProvider}/${settings.defaultModel}`];
	} catch {
		// Fall through to an empty list.
	}
	return [];
}

function main() {
	const models = enabledModels(readFileSync(SETTINGS_PATH, "utf8"));
	if (models.length === 0) {
		console.error(`no enabledModels found in ${SETTINGS_PATH}`);
		return 1;
	}

	const selfPath = fileURLToPath(import.meta.url);
	mkdirSync(OUT_DIR, { recursive: true });
	const before = new Set(readdirSync(OUT_DIR));

	console.log(`cwd ${process.cwd()}`);
	console.log(`measuring ${models.length} model(s); one small real request each\n`);

	for (const model of models) {
		process.stdout.write(`  ${pad(model, 30)} `);
		const result = spawnSync(
			"pi",
			["--print", "--no-session", "-e", selfPath, "--model", model, "Reply with the single word: ok"],
			{ encoding: "utf8", timeout: 180_000 },
		);
		console.log(result.status === 0 ? "ok" : `failed (${result.status})`);
		if (result.status !== 0 && result.stderr) console.error(`    ${result.stderr.trim().split("\n").slice(-2).join("\n    ")}`);
	}

	const captures = readdirSync(OUT_DIR)
		.filter((name) => name.startsWith("capture-") && !before.has(name))
		.map((name) => JSON.parse(readFileSync(join(OUT_DIR, name), "utf8")));

	if (captures.length === 0) {
		console.error("\nno captures produced");
		return 1;
	}

	console.log(
		`\n${pad("MODEL", 30)}${pad("CARRIER", 14)}${pad("STAGE", 14)}${pad("SYSTEM", 10, true)}${pad("TOOLS", 7, true)}${pad("SCHEMAS", 10, true)}${pad("STANDING", 11, true)}`,
	);
	for (const capture of captures) {
		const { payload } = capture;
		console.log(
			pad(`${capture.provider}/${capture.modelId}`, 30) +
				pad(payload.systemCarrier, 14) +
				pad(payload.rewriteStage, 14) +
				pad(payload.systemBytes, 10, true) +
				pad(payload.toolCount, 7, true) +
				pad(payload.toolBytes, 10, true) +
				pad(payload.systemBytes + payload.toolBytes, 11, true),
		);
	}

	if (captures.some((capture) => capture.payload.rewriteStage === "pre-rewrite")) {
		console.log(
			"\nnote: a pre-rewrite capture ran before pi-cc-use's OAuth tool aliasing.\n" +
				"      True Anthropic wire cost is higher by about 12 B per custom tool name,\n" +
				"      counted twice: once in the tool list and once inside the system prompt.",
		);
	}

	for (const capture of captures) {
		const owners = groupToolsByOwner(capture.payload.tools);
		const prose = capture.payload.tools.reduce((sum, tool) => sum + tool.proseBytes, 0);
		const structural = capture.payload.tools.reduce((sum, tool) => sum + tool.structuralBytes, 0);
		console.log(`\n${capture.provider}/${capture.modelId}: tool surface ${prose} B prose / ${structural} B mechanical`);
		for (const owner of owners) {
			console.log(`  ${pad(owner.owner, 16)}${pad(owner.tools, 3, true)} tools ${pad(owner.total, 7, true)} B  ${pad(Math.round((100 * owner.prose) / owner.total), 3, true)}% prose`);
		}

		const guidelines = (capture.agentStart?.sources ?? []).filter((source) => source.layer === "prompt-guideline");
		const withText = guidelines.filter((source) => typeof source.text === "string");
		if (withText.length > 0) {
			const report = findDuplicates(withText.map((source) => source.text));
			console.log(`  guideline registrations: ${report.unique} unique of ${report.total}, ${report.repeatedBytes} B repeated in source registrations (Pi deduplicates before emission)`);
			for (const duplicate of report.duplicates) {
				console.log(`    x${duplicate.count} (${duplicate.bytes} B each, ${duplicate.wasted} B repeated) ${duplicate.text.slice(0, 60)}...`);
			}
		}
	}

	console.log(`\ncaptures written to ${OUT_DIR}`);
	return 0;
}

if (import.meta.main) process.exit(main());
