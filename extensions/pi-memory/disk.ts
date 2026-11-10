// Disk backend for hosts without the Obsidian CLI: the vault is a plain directory kept current by
// Obsidian Sync (Headless Sync on homelab-server, Windows Obsidian on work-machine). Selected only by a per-machine global
// `pi-memory.vaultPath`; it is never a fallback for the Obsidian CLI.
//
// It mirrors the ObsidianClient operations pi-memory uses, with the same vault-relative paths
// and error messages. Writes are atomic: a temp file in the target directory, then link/rename.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ObsidianClient, SearchMatch, VaultFile } from "../lib/obsidian-cli.ts";
import { parseFrontmatter } from "./okf";

export type MemoryStore = Pick<ObsidianClient, "verifyVault" | "stat" | "read" | "create" | "overwrite" | "replaceOnce" | "listMarkdown" | "searchContext" | "trash">;

// Obsidian search operators the disk backend does not implement. Using one fails clearly.
const UNSUPPORTED_OPERATORS = ["path", "file", "content", "line", "block", "section", "task", "task-todo", "task-done", "match-case", "ignore-case"];
const SUPPORTED = 'plain words, "exact phrases", /regex/, and tag:name';

type TextTerm = { kind: "text"; label: string; test: (value: string) => boolean };
type TagTerm = { kind: "tag"; tag: string };
type Term = TextTerm | TagTerm;

function unsupported(token: string): never {
	throw new Error(`Search syntax ${JSON.stringify(token)} is not supported by the disk memory backend; use ${SUPPORTED}.`);
}

function textTerm(label: string, needle: string): Term {
	const lower = needle.toLowerCase();
	return { kind: "text", label, test: (value) => value.toLowerCase().includes(lower) };
}

/** Parse an Obsidian-style query into AND-ed terms; throws on anything outside the supported subset. */
function parseQuery(query: string): Term[] {
	const terms: Term[] = [];
	let i = 0;
	while (i < query.length) {
		if (/\s/.test(query[i])) { i++; continue; }
		if (query[i] === '"') {
			const end = query.indexOf('"', i + 1);
			if (end < 0) throw new Error(`Unterminated phrase in search query: ${query}`);
			const phrase = query.slice(i + 1, end);
			if (!phrase) throw new Error(`Empty phrase in search query: ${query}`);
			terms.push(textTerm(`"${phrase}"`, phrase));
			i = end + 1;
			continue;
		}
		if (query[i] === "/") {
			let j = i + 1;
			while (j < query.length && query[j] !== "/") j += query[j] === "\\" ? 2 : 1;
			if (j >= query.length) throw new Error(`Unterminated /regex/ in search query: ${query}`);
			const source = query.slice(i + 1, j);
			let regex: RegExp;
			try {
				regex = new RegExp(source, "i");
			} catch (error) {
				throw new Error(`Invalid /regex/ in search query: ${(error as Error).message}`);
			}
			terms.push({ kind: "text", label: `/${source}/`, test: (value) => regex.test(value) });
			i = j + 1;
			continue;
		}
		let j = i;
		while (j < query.length && !/\s/.test(query[j])) j++;
		const token = query.slice(i, j);
		i = j;
		if (token === "OR" || token.startsWith("-") || token.startsWith("(") || token.endsWith(")") || token.startsWith("[")) unsupported(token);
		const operator = token.match(/^([a-z-]+):(.*)$/);
		if (operator && operator[1] === "tag") {
			const tag = operator[2].replace(/^#/, "").toLowerCase();
			if (!tag) throw new Error("tag: needs a tag name, for example tag:memory/nas");
			terms.push({ kind: "tag", tag });
			continue;
		}
		if (operator && UNSUPPORTED_OPERATORS.includes(operator[1])) unsupported(token);
		terms.push(textTerm(token, token));
	}
	if (!terms.length) throw new Error("Provide a query to search memory notes.");
	return terms;
}

function hasTag(tags: string[], wanted: string): boolean {
	return tags.some((raw) => {
		const tag = raw.replace(/^#/, "").toLowerCase();
		return tag === wanted || tag.startsWith(`${wanted}/`);
	});
}

function errorCode(error: unknown): unknown {
	return (error as NodeJS.ErrnoException)?.code;
}

export class DiskStore implements MemoryStore {
	constructor(private readonly root: string) {}

	private checkRoot(): void {
		let isVault = false;
		try {
			isVault = fs.statSync(this.root).isDirectory() && fs.statSync(path.join(this.root, ".obsidian")).isDirectory();
		} catch (error) {
			if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw new Error(`Cannot access memory vault at ${this.root}: ${(error as Error).message}`);
		}
		if (!isVault) throw new Error(`pi-memory.vaultPath ${this.root} is not an Obsidian vault directory (it needs a .obsidian/ folder). Check pi-memory.vaultPath in the global settings.json and that Obsidian Sync keeps that directory current.`);
	}

	private abs(vaultPath: string): string {
		this.checkRoot();
		return path.join(this.root, ...vaultPath.split("/"));
	}

	async verifyVault(): Promise<void> {
		this.checkRoot();
	}

	async stat(vaultPath: string): Promise<"file" | "folder" | null> {
		try {
			const entry = fs.statSync(this.abs(vaultPath));
			return entry.isDirectory() ? "folder" : entry.isFile() ? "file" : null;
		} catch (error) {
			if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return null;
			throw error;
		}
	}

	private existingFile(vaultPath: string): { file: string; mode: number } {
		const file = this.abs(vaultPath);
		try {
			const entry = fs.statSync(file);
			if (entry.isFile()) return { file, mode: entry.mode & 0o777 };
		} catch (error) {
			if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ENOTDIR") throw error;
		}
		throw new Error(`File not found: ${vaultPath}`);
	}

	async read(vaultPath: string): Promise<string> {
		return fs.readFileSync(this.existingFile(vaultPath).file, "utf8");
	}

	/** Write `text` to a new dot-prefixed temp file beside `file` (Obsidian and Sync ignore dot files). */
	private writeTemp(file: string, text: string, mode: number): string {
		const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
		const fd = fs.openSync(temp, "wx", mode);
		try {
			fs.writeFileSync(fd, text, "utf8");
			fs.fsyncSync(fd);
		} catch (error) {
			fs.closeSync(fd);
			fs.rmSync(temp, { force: true });
			throw error;
		}
		fs.closeSync(fd);
		return temp;
	}

	private replaceWith(file: string, text: string, mode: number): void {
		const temp = this.writeTemp(file, text, mode);
		try {
			fs.renameSync(temp, file);
		} catch (error) {
			fs.rmSync(temp, { force: true });
			throw error;
		}
	}

	async create(vaultPath: string, text: string): Promise<void> {
		const file = this.abs(vaultPath);
		const dir = path.dirname(file);
		if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) throw new Error(`File already exists: ${path.posix.dirname(vaultPath)}`);
		fs.mkdirSync(dir, { recursive: true });
		const temp = this.writeTemp(file, text, 0o644);
		try {
			// link() publishes the complete file and fails atomically when the path exists.
			fs.linkSync(temp, file);
		} catch (error) {
			if (errorCode(error) === "EEXIST") throw new Error(`File already exists: ${vaultPath}`);
			throw error;
		} finally {
			fs.rmSync(temp, { force: true });
		}
	}

	async overwrite(vaultPath: string, text: string): Promise<void> {
		const { file, mode } = this.existingFile(vaultPath);
		this.replaceWith(file, text, mode);
	}

	async replaceOnce(vaultPath: string, oldText: string, newText: string): Promise<void> {
		const { file, mode } = this.existingFile(vaultPath);
		if (!oldText) throw new Error("oldText must not be empty");
		const data = fs.readFileSync(file, "utf8");
		let count = 0;
		let at = -1;
		for (let i = data.indexOf(oldText); i >= 0; i = data.indexOf(oldText, i + oldText.length)) {
			count++;
			at = i;
		}
		if (count === 0) throw new Error(`oldText was not found in ${vaultPath}`);
		if (count > 1) throw new Error(`oldText matches ${count} places in ${vaultPath}; make it unique`);
		this.replaceWith(file, data.slice(0, at) + newText + data.slice(at + oldText.length), mode);
	}

	// Trash semantics (the vault's .trash and how Headless Sync treats it) are not verified for headless hosts.
	async trash(): Promise<void> {
		throw new Error("memory_trash is not supported by the disk memory backend: its trash behavior with Obsidian Sync is unverified. Use a host with the Obsidian CLI.");
	}

	async listMarkdown(folder: string, withText: boolean): Promise<VaultFile[]> {
		const out: VaultFile[] = [];
		const walk = (vaultDir: string) => {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(this.abs(vaultDir), { withFileTypes: true });
			} catch (error) {
				if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return;
				throw error;
			}
			for (const entry of entries) {
				if (entry.name.startsWith(".")) continue;
				const child = `${vaultDir}/${entry.name}`;
				if (entry.isDirectory()) walk(child);
				else if (entry.isFile() && entry.name.endsWith(".md")) out.push({ path: child, text: "" });
			}
		};
		walk(folder);
		out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (withText) for (const file of out) file.text = fs.readFileSync(this.abs(file.path), "utf8");
		return out;
	}

	async searchContext(query: string, folder: string, limit: number): Promise<SearchMatch[]> {
		const terms = parseQuery(query);
		const textTerms = terms.filter((term): term is TextTerm => term.kind === "text");
		const tagTerms = terms.filter((term): term is TagTerm => term.kind === "tag");
		const results: SearchMatch[] = [];
		for (const file of await this.listMarkdown(folder, true)) {
			if (results.length >= limit) break;
			if (tagTerms.length) {
				const tags = parseFrontmatter(file.text).tags;
				if (!tagTerms.every((term) => hasTag(tags, term.tag))) continue;
			}
			if (!textTerms.every((term) => term.test(file.text))) continue;
			const matches: SearchMatch["matches"] = [];
			file.text.split(/\r?\n/).forEach((line, index) => {
				if (textTerms.some((term) => term.test(line))) matches.push({ line: index + 1, text: line.trim() });
			});
			results.push({ file: file.path, matches });
		}
		return results;
	}
}
