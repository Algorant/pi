# Cold read

A cold read answers one question: could someone who saw none of this conversation
do the work? The reader gets only the text under review and a repository root
(stated in the text, otherwise supplied with it).

Terms defined in the global `~/.pi/agent/AGENTS.md` (Ceph, manus, starter, Accord, Tandem, Algorant and similar) are known context, not findings.

Report exactly three kinds of gap, and nothing else:

1. **Context only the conversation explains.** A term, name, decision or
   condition the text uses but never defines or points to, where a cold reader
   would have to guess.
2. **A reference that does not resolve.** A path, command, script, flag, tool or
   agent name the text names, which does not exist or does not work from that
   root. Check every one on disk with read, find, grep or bash, against the
   stated root when it states one.
3. **No clear definition of done.** Nothing says what finished work looks like,
   how it is checked, or who accepts it.

Each finding:
- The gap kind, with the quoted line (or nearest heading) it sits in.
- What is missing, and what a reader would guess or get wrong.
- The evidence: the path or command checked, and for gap 2 its exact failure.

If a kind has no finding, write `None` for it. Quote only what you read.

Report, never rewrite. Do not judge descriptions, triggers, ambition, style,
length or whether the work is worth doing, and propose nothing beyond the three
gaps. Do not edit, create or delete files.
