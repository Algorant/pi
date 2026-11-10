import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { SurfacePayload } from "./validation";

const RENDER_TIMEOUT_MS = 60_000;

export type RenderedMermaid = { label: string; source: string; alt: string; png: Uint8Array };
export type MermaidUpload = (png: Uint8Array, filename: string) => Promise<string>;

export function hasMermaid(surfaces: SurfacePayload[]): boolean {
	return surfaces.some((surface) => surface.kind === "mermaid");
}

function peleScript(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "skills", "studio", "pele", "render.ts");
}

function firstLine(source: string): string {
	const line = source.split("\n").find((item) => item.trim())?.trim() ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

// Pele dies with a Bun stack dump; keep only its error line (e.g. "PeleError: No diagram type detected...").
function peleMessage(stderr: string): string {
	const line = stderr.split("\n").map((item) => item.trim()).find((item) => /^(?:\w*Error|error|pele): /.test(item));
	return (line ?? stderr.trim().slice(-400)).slice(0, 400);
}

/** Render one Mermaid source with Pele (Verdigris PNG). Throws, naming the diagram, on any failure. */
async function renderOne(source: string, label: string, signal?: AbortSignal): Promise<Uint8Array> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sideshow-pele-"));
	const name = `${label} ("${firstLine(source)}")`;
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			const child = spawn("bun", [peleScript(), "-", dir], { stdio: ["pipe", "pipe", "pipe"], signal, timeout: RENDER_TIMEOUT_MS });
			let out = "";
			let err = "";
			child.stdout.on("data", (chunk) => { out += chunk; });
			child.stderr.on("data", (chunk) => { err += chunk; });
			child.on("error", reject);
			child.on("close", (code, sig) => {
				if (code === 0) resolve(out);
				else reject(new Error(peleMessage(err) || out.trim().slice(-400) || `exited with ${code ?? sig}`));
			});
			child.stdin.on("error", () => {});
			child.stdin.end(source);
		});
		const result = JSON.parse(stdout.trim().split("\n").pop() ?? "") as { png?: string };
		if (!result.png) throw new Error("Pele printed no png path");
		return await readFile(result.png);
	} catch (error) {
		throw new Error(`Pele failed to render mermaid surface ${name}; nothing was posted: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** Render every mermaid surface with Pele before any Sideshow call, keyed by surface index. */
export async function renderMermaidSurfaces(surfaces: SurfacePayload[], path: string, signal?: AbortSignal): Promise<Map<number, RenderedMermaid>> {
	const rendered = new Map<number, RenderedMermaid>();
	for (const [index, surface] of surfaces.entries()) {
		if (surface.kind !== "mermaid") continue;
		const source = surface.mermaid ?? "";
		const label = `${path}[${index}]`;
		rendered.set(index, { label, source, alt: `Mermaid diagram: ${firstLine(source)}`, png: await renderOne(source, label, signal) });
	}
	return rendered;
}

export function imageSurface(item: RenderedMermaid, assetId: string): SurfacePayload {
	return { kind: "image", assetId, alt: item.alt };
}

export function sourceSurface(item: RenderedMermaid): SurfacePayload {
	return { kind: "code", code: item.source, language: "mermaid", title: "Mermaid source" };
}

/** Replace each rendered mermaid surface with its uploaded image followed by its source code surface. */
export async function expandMermaidSurfaces(surfaces: SurfacePayload[], rendered: Map<number, RenderedMermaid>, upload: MermaidUpload): Promise<SurfacePayload[]> {
	const out: SurfacePayload[] = [];
	for (const [index, surface] of surfaces.entries()) {
		const item = rendered.get(index);
		if (!item) {
			out.push(surface);
			continue;
		}
		out.push(imageSurface(item, await upload(item.png, `mermaid-${index}.png`)), sourceSurface(item));
	}
	return out;
}
