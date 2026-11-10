/**
 * The boards /task works with: the current session's own board plus every other
 * open local project, discovered once per /task invocation; nothing is polled,
 * saved or kept current.
 *
 * - Native HC (`HC_TERMINAL_ID`): one `hc ls` snapshot, the same policy as
 *   Herdra's `bin/herdra-tui`: a live local terminal (address without `/`)
 *   whose `where` ends in ` / main` (its space's Ceph place), and whose cwd holds
 *   a `.tandem` board; one board per real cwd.
 * - Outside HC: only the current board.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { hcJson, isHc } from "../../pi-hc/core";
import type { BoardOption } from "./questions";

export type Board = {
	/** Jev criterion key and display name: the workspace (space) label. */
	name: string;
	/** Where `tandem` runs for this board. Every read or action on one of its Tasks uses it. */
	cwd: string;
	/** The project's agent in its space's `main` tab (native HC terminal); absent for the current session's board. */
	ceph?: { name: string; terminal: string };
	/** Deliberate description; filled by loadBoards for capture, empty in plain discovery. */
	oneLiner: string;
	/** This session's own board. */
	current: boolean;
};

/** Per session: the extension instance lives as long as the session. */
const descriptions = new Map<string, Promise<{ description?: string; file: string }>>();

/** Lowercased, leading dot stripped: ".pi" and "pi" are the same project key. */
function projectKey(value: string): string {
	return value.toLowerCase().replace(/^\./, "");
}

/** The `description:` line of a document's leading front matter, if any. */
export function frontMatterDescription(text: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
	const line = match?.[1].split(/\r?\n/).find((row) => /^description:\s*\S/.test(row));
	return line?.replace(/^description:\s*/, "").replace(/^(["'])(.*)\1$/, "$2").trim() || undefined;
}

/**
 * A project's deliberate one-line description: `description:` front matter at the top of
 * VISION.md, or README.md when there is no VISION. File names match case-insensitively
 * (ffsync has vision.md). `file` names where the line belongs.
 */
function descriptionOf(cwd: string): Promise<{ description?: string; file: string }> {
	let cached = descriptions.get(cwd);
	if (!cached) {
		cached = (async () => {
			const names = await readdir(cwd);
			for (const wanted of ["vision.md", "readme.md"]) {
				const name = names.find((entry) => entry.toLowerCase() === wanted);
				if (!name) continue;
				const file = join(cwd, name);
				return { description: frontMatterDescription(await readFile(file, "utf8")), file };
			}
			return { file: join(cwd, "VISION.md") };
		})();
		descriptions.set(cwd, cached);
	}
	return cached;
}

/**
 * The board a cwd's `tandem` commands use: the cwd itself when it holds `.tandem`,
 * else the main worktree of its Git repository when that holds one (a linked
 * worktree has no `.tandem/`). Only used to keep one entry per board.
 */
async function boardRoot(cwd: string): Promise<string> {
	const real = await realpath(cwd);
	if (existsSync(join(real, ".tandem"))) return real;
	try {
		const { stdout } = await promisify(execFile)("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: real, timeout: 5000 });
		const main = dirname(stdout.trim());
		return existsSync(join(main, ".tandem")) ? await realpath(main) : real;
	} catch {
		return real; // not a Git checkout: the cwd is its own identity
	}
}

type HcTerminal = { address?: unknown; where?: unknown; cwd?: unknown; name?: unknown; state?: unknown };

/** Native HC: one `hc ls` snapshot (herdra-tui's policy). A failed `hc ls` is an error, not a reason to use another discovery. */
async function hcBoards(cwd: string, signal: AbortSignal): Promise<Board[]> {
	const listed = await hcJson(["ls", "--json"]);
	signal.throwIfAborted();
	if (!Array.isArray(listed?.terminals)) throw new Error("hc ls returned no terminal list.");
	const terminals = listed.terminals as HcTerminal[];
	const self = terminals.find((terminal) => terminal.address === process.env.HC_TERMINAL_ID);
	const space = typeof self?.where === "string" ? self.where.split(" / ")[0] : undefined;
	const home: Board = { name: space || basename(cwd), cwd, oneLiner: "", current: true };
	const seen = new Set([await boardRoot(cwd)]);
	const others: Board[] = [];
	for (const terminal of terminals) {
		const { address, where, cwd: dir } = terminal;
		if (terminal.state !== "live" || typeof address !== "string" || address.includes("/")) continue;
		if (typeof where !== "string" || !where.endsWith(" / main") || typeof dir !== "string") continue;
		if (!existsSync(join(dir, ".tandem"))) continue;
		const real = await realpath(dir);
		if (seen.has(real)) continue;
		seen.add(real);
		others.push({
			name: where.slice(0, -" / main".length),
			cwd: real,
			ceph: { name: typeof terminal.name === "string" && terminal.name ? terminal.name : address, terminal: address },
			oneLiner: "",
			current: false,
		});
	}
	return [home, ...others];
}

/**
 * The current board first, then the other open projects in discovery order. A failed
 * discovery is an error; nothing is guessed from stale data or another host's discovery.
 * Descriptions are not read here: the read-only search shows every board.
 */
export async function discoverBoards(cwd: string, signal: AbortSignal): Promise<Board[]> {
	if (isHc()) return hcBoards(cwd, signal);
	return [{ name: basename(cwd), cwd, oneLiner: "", current: true }];
}

/**
 * Capture's boards: discovery plus each board's description. `missing` lists the
 * VISION/README files that still need a `description:` line; other boards without one
 * are not offered for filing (the current board always is).
 */
export async function loadBoards(cwd: string, signal: AbortSignal): Promise<{ boards: Board[]; missing: string[] }> {
	const missing: string[] = [];
	const boards: Board[] = [];
	for (const board of await discoverBoards(cwd, signal)) {
		const { description, file } = await descriptionOf(board.cwd);
		if (!description) missing.push(file);
		if (description || board.current) boards.push({ ...board, oneLiner: description ?? "" });
	}
	return { boards, missing };
}

/** Jev criterion for a board, and a key that stays unique when two workspaces share a name. */
export function boardOptions(boards: Board[]): BoardOption[] {
	const seen = new Set<string>();
	return boards.map((board) => {
		let key = board.name;
		if (seen.has(key)) key = `${board.name} (${board.cwd})`;
		seen.add(key);
		const parts = [board.oneLiner, board.ceph ? `Ceph ${board.ceph.name}` : undefined].filter(Boolean);
		return { key, description: parts.length > 0 ? `${board.name}: ${parts.join("; ")}` : board.name };
	});
}

/** Why a board was picked, in words: a name match in the sentence, else the board's own description. */
export function reasonFor(board: Board, sentence: string): string {
	for (const term of [board.name, board.ceph?.name]) {
		if (!term) continue;
		const escaped = projectKey(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = new RegExp(`(?<![\\w])\\.?${escaped}(?: ceph)?(?![\\w])`, "i").exec(sentence);
		if (match) return `it names "${match[0]}"`;
	}
	return board.oneLiner ? `it fits "${board.oneLiner.length > 60 ? `${board.oneLiner.slice(0, 59)}…` : board.oneLiner}"` : `it fits ${board.name}`;
}
