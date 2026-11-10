const SHARED_GUIDANCE = [
	"- Default to standalone Tasks or Tasks with appropriate subtasks/milestones within them. An agent may ask Algorant whether an Epic is warranted, but must not create one unless Algorant explicitly requests or approves an Epic; scope size or coordination needs alone do not authorize one. Read the tandem skill before choosing the hierarchy.",
	"- Normalize unambiguous conversational Task references such as ‘task 94’ to `task-94` before lookup or tool use; preserve canonical IDs, including `task-92-2`, and clarify genuinely ambiguous references rather than guessing.",
	"- Use Tandem tools/CLI for coordination; Tandem owns IDs, hierarchy, workflow, and board synchronization. Archived records are read-only to agents.",
	"- Tandem syncs the board itself. Treat `pending` as saved locally, not as failure. Surface conflicts and held edits to Algorant; resolve them only with `tandem sync resolve` when authorized. Never stage, commit, push, edit, delete, or rename `.tandem/` or the `tandem` branch.",
] as const;
export function tandemPromptGuidance(workspaceRoot?: string, workspaceDetected = Boolean(workspaceRoot)): string {
	const workspace = workspaceRoot
		? `A Tandem workspace is present at ${workspaceRoot}.`
		: workspaceDetected
			? "A Tandem workspace is present without a Git repository root."
			: "No Tandem workspace is currently detected from the working directory.";
	return `\n\n## Tandem coordination guidance\n\n${workspace}\n\n${SHARED_GUIDANCE.join("\n")}\n`;
}
export function promptMentionsDurableCoordination(prompt: string): boolean {
	return /\b(tandem|durable coordination|task board|accord|work agreement|validation|review queue|project rules|workflow friction|papercut)\b/i.test(
		prompt,
	);
}
