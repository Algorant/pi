import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * In-process coordination between notice delivery and compaction (task-399,
 * task-438). In Pi 1.x a message delivered while a compaction runs is either
 * stranded (steer: it lands in the transcript but starts no turn) or races the
 * summary (followUp + triggerTurn), so every owner of a delivery path (the
 * inbox, the Worker handoff scan) must not send while `held`, and each is woken
 * once the compaction ended and the session is idle again. The idle-compaction
 * hook also does not start when the inbox has just started a turn.
 */
interface Owner {
  context: () => ExtensionContext | undefined;
  scan: () => void;
}

const owners = new Map<string, Owner>();

export const inboxGate = {
  /** Delivery is held: nothing is sent until release. */
  held: false,
  /** The inbox delivered a message to an idle session and a turn will follow. */
  turnPending: false,
  /**
   * Ask every registered path to scan now, with no timer: a hold that ended without an event of its
   * own (a reload that was refused or found nothing to load) must not leave its message queued.
   */
  rescan(): void {
    if (this.held) return;
    for (const owner of owners.values()) {
      const ctx = owner.context();
      if (ctx?.isIdle()) owner.scan();
    }
  },
  /** Register (or, after a reload, replace) a delivery path to rescan after each release. */
  register(name: string, owner: Owner): void { owners.set(name, owner); },
  hold(): void { this.held = true; },
  /** Release the hold; every owner rescans once its session is idle (a held-over message must start a turn). */
  release(): void {
    this.held = false;
    for (const owner of owners.values()) {
      const tick = () => {
        const ctx = owner.context();
        if (!ctx || this.held) return;
        if (ctx.isIdle()) owner.scan();
        else setTimeout(tick, 100);
      };
      setTimeout(tick, 0);
    }
  },
};
