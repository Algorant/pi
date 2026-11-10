import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pi's built-in codemode writes every image() and long output to
 * `<tmpdir>/pi-codemode-*` and never removes them; /tmp is RAM-backed tmpfs
 * here. At session start, delete those files once they are a day old, so a
 * later turn can still reuse a recent path. The path itself is Pi's and cannot
 * be moved from an extension.
 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function registerCodemodeTempCleanup(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		void (async () => {
			const dir = tmpdir();
			const cutoff = Date.now() - MAX_AGE_MS;
			for (const name of await readdir(dir)) {
				if (!name.startsWith("pi-codemode-")) continue;
				const path = join(dir, name);
				try {
					if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
				} catch {
					// Another session removed it first, or it is not ours to remove.
				}
			}
		})().catch((error) => console.error(`[pi-ui] codemode temp cleanup failed: ${error}`));
	});
}
