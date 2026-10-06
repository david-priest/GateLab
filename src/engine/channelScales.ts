/**
 * Workspace-wide ownership of display-scale settings.
 *
 * A display transform belongs to the CHANNEL, not to one FCS file. The gating plot pools the
 * checked files into one point cloud, and each file previously computed its own display
 * coordinates from its own `Sample` state, so a workspace could draw one cloud under several
 * different transforms at once. That happened in two ways:
 *
 *  - a scale control wrote only to the active file, leaving the rest frozen at the old
 *    transform (50% of the cloud with two files, 75% with four); and, worse,
 *  - the logicle W falls back to an estimate from each file's OWN data, so four real files
 *    opened with W of 0.500 / 1.143 / 0.500 / 0.500 on one channel before the user touched
 *    anything. The split cloud was the DEFAULT state, not something a control caused.
 *
 * Fanning every writer out across samples fixes the first and not the second, and holds only
 * by convention: it must be remembered by every present and future writer, and it cannot cover
 * a file that does not exist yet. So the settings live here instead, and `Sample` reads them.
 * A newly loaded file is then correct by construction rather than by being visited.
 *
 * Two scopes. The AUTO estimates (W and T) are keyed by the workspace scale context
 * (`Sample.workspaceScaleContextKey` = active assay layer plus instrument): a matrix changes the
 * negative tail they are estimated from, so Original and Compensated must not share one. The
 * EXPLICIT choices (linear or arcsinh for scatter, a cofactor, arcsinh in place of logicle, an
 * explicit W) are keyed by the instrument alone: they are the user's preference for the channel,
 * and until 2026-09-16 they were keyed by layer too, so installing a matrix silently reset every
 * axis to its default and a gate drawn on a linear axis reappeared as a curve.
 *
 * The CyTOF arcsinh cofactor is deliberately NOT owned here. It is part of compensation
 * identity — a persisted compensated layer is rejected when it disagrees with the sample's
 * cofactor — so it stays per-Sample.
 */

/** What this registry needs from a Sample. Kept minimal so tests can use a stub. */
export interface ChannelScaleParticipant {
  readonly workspaceScaleContextKey: string;
  index(channelKey: string): number | undefined;
  /** This file's OWN auto-estimated logicle W. Must not consult the registry. */
  ownAutoLogicleW(idx: number): number;
  /** This file's own top-of-scale, before workspace sharing. */
  ownAutoLogicleT(idx: number): number;
  /** Drop cached display coordinates for one channel after a settings change. */
  invalidateChannelForScales(idx: number): void;
}

// The separator is written as an escape: a raw NUL byte made git treat this file as binary.
const slot = (contextKey: string, channelKey: string) => `${contextKey}\u0000${channelKey}`;

/**
 * The scope an explicit choice lives in: the context key with its assay layer dropped. A context
 * key is `JSON.stringify([activeLayer, instrument])`; a key of any other shape is its own scope,
 * which keeps single-sample and test use unchanged.
 */
const settingsScope = (() => {
  const cache = new Map<string, string>();
  return (contextKey: string): string => {
    const hit = cache.get(contextKey);
    if (hit !== undefined) return hit;
    let scope = contextKey;
    try {
      const parsed: unknown = JSON.parse(contextKey);
      if (Array.isArray(parsed) && parsed.length >= 2) scope = JSON.stringify(parsed.slice(1));
    } catch {
      // Not a layered context key.
    }
    cache.set(contextKey, scope);
    return scope;
  };
})();
const settingsSlot = (contextKey: string, channelKey: string) => slot(settingsScope(contextKey), channelKey);

export class ChannelScales {
  private readonly explicitW = new Map<string, number>();
  private readonly explicitCofactor = new Map<string, number>();
  // Flow scatter is drawn linear unless a channel was switched to arcsinh (2026-10-06; the
  // default was arcsinh before). Explicit choices are kept, so a saved workspace that lists its
  // linear channels restores the others as arcsinh, as they were.
  private readonly scatterArcsinh = new Set<string>();
  private readonly fluorArcsinh = new Set<string>();
  private readonly sharedAutoW = new Map<string, number>();
  private readonly sharedAutoT = new Map<string, number>();
  private readonly participants = new Set<ChannelScaleParticipant>();
  private readonly listeners = new Set<() => void>();

  /**
   * Generation of the participant SET. The shared auto W is derived from the data of every
   * participating file, so it can change when a file is added or removed — but not otherwise.
   * Samples fold this into their display-transform identity, which keeps cache invalidation
   * precise: an explicit change invalidates one channel, and only a roster change is broad.
   */
  rosterVersion = 0;

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  register(participant: ChannelScaleParticipant): void {
    if (this.participants.has(participant)) return;
    this.participants.add(participant);
    this.sharedAutoW.clear();
    this.sharedAutoT.clear();
    this.rosterVersion++;
    this.notify();
  }

  unregister(participant: ChannelScaleParticipant): void {
    if (!this.participants.delete(participant)) return;
    this.sharedAutoW.clear();
    this.sharedAutoT.clear();
    this.rosterVersion++;
    this.notify();
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────

  /** An explicitly chosen W for this channel, if the user has set one. */
  logicleW(contextKey: string, channelKey: string): number | undefined {
    return this.explicitW.get(settingsSlot(contextKey, channelKey));
  }

  /**
   * One auto-estimated W shared by every file in the context.
   *
   * Files disagree because the estimate is driven by each file's own 5th percentile. The
   * largest W is taken, because W sets how many negative decades are displayed: the widest
   * request accommodates every file's negative population, whereas a smaller one would squash
   * the noisiest file's events against the axis.
   */
  autoLogicleW(contextKey: string, channelKey: string): number | undefined {
    const key = slot(contextKey, channelKey);
    const hit = this.sharedAutoW.get(key);
    if (hit !== undefined) return hit;

    let best: number | undefined;
    for (const participant of this.participants) {
      if (participant.workspaceScaleContextKey !== contextKey) continue;
      const idx = participant.index(channelKey);
      if (idx === undefined) continue;
      const w = participant.ownAutoLogicleW(idx);
      if (!Number.isFinite(w)) continue;
      if (best === undefined || w > best) best = w;
    }
    if (best !== undefined) this.sharedAutoW.set(key, best);
    return best;
  }

  scatterCofactor(contextKey: string, channelKey: string): number | undefined {
    return this.explicitCofactor.get(settingsSlot(contextKey, channelKey));
  }

  /** W alone is not a common transform: T must also be shared for locked ticks and pooled data. */
  logicleT(contextKey: string, channelKey: string): number | undefined {
    const key = slot(contextKey, channelKey);
    const hit = this.sharedAutoT.get(key);
    if (hit !== undefined) return hit;
    let top: number | undefined;
    for (const participant of this.participants) {
      if (participant.workspaceScaleContextKey !== contextKey) continue;
      const idx = participant.index(channelKey);
      if (idx === undefined) continue;
      const value = participant.ownAutoLogicleT(idx);
      if (Number.isFinite(value) && value > 0) top = Math.max(top ?? value, value);
    }
    if (top !== undefined) this.sharedAutoT.set(key, top);
    return top;
  }

  isScatterLinear(contextKey: string, channelKey: string): boolean {
    return !this.scatterArcsinh.has(settingsSlot(contextKey, channelKey));
  }

  /** True when this fluorescence channel is displayed with arcsinh instead of its logicle. */
  isFluorArcsinh(contextKey: string, channelKey: string): boolean {
    return this.fluorArcsinh.has(settingsSlot(contextKey, channelKey));
  }

  /** Explicit settings touching one sample's channels, for its display-transform identity. */
  identityFor(contextKey: string, channelKeys: readonly string[]): unknown[] {
    const out: unknown[] = [];
    for (const channelKey of channelKeys) {
      const key = settingsSlot(contextKey, channelKey);
      const w = this.explicitW.get(key);
      const cofactor = this.explicitCofactor.get(key);
      const scatterArcsinh = this.scatterArcsinh.has(key);
      const isArcsinh = this.fluorArcsinh.has(key);
      if (w === undefined && cofactor === undefined && !scatterArcsinh && !isArcsinh) continue;
      out.push([channelKey, w ?? null, cofactor ?? null, scatterArcsinh, isArcsinh]);
    }
    out.sort((a, b) => String((a as unknown[])[0]).localeCompare(String((b as unknown[])[0])));
    return out;
  }

  /** Persisted form: every explicit W in one context, keyed by channel. */
  logicleWEntries(contextKey: string): Record<string, number> {
    const out: Record<string, number> = {};
    const prefix = `${settingsScope(contextKey)}\u0000`;
    for (const [key, w] of this.explicitW) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = w;
    }
    return out;
  }

  // ── writes ───────────────────────────────────────────────────────────────────────────────

  setLogicleW(contextKey: string, channelKey: string, w: number): void {
    const clamped = Math.max(0.1, Math.min(w, 2.0));
    if (this.explicitW.get(settingsSlot(contextKey, channelKey)) === clamped) return;
    this.explicitW.set(settingsSlot(contextKey, channelKey), clamped);
    this.invalidate(contextKey, channelKey);
  }

  /** Revert to the shared auto estimate. Never reverts to a per-file estimate. */
  resetLogicleW(contextKey: string, channelKey: string): void {
    if (!this.explicitW.delete(settingsSlot(contextKey, channelKey))) return;
    this.invalidate(contextKey, channelKey);
  }

  setScatterCofactor(contextKey: string, channelKey: string, cofactor: number): void {
    if (!(cofactor > 0)) return;
    if (this.explicitCofactor.get(settingsSlot(contextKey, channelKey)) === cofactor) return;
    this.explicitCofactor.set(settingsSlot(contextKey, channelKey), cofactor);
    this.invalidate(contextKey, channelKey);
  }

  resetScatterCofactor(contextKey: string, channelKey: string): void {
    if (!this.explicitCofactor.delete(settingsSlot(contextKey, channelKey))) return;
    this.invalidate(contextKey, channelKey);
  }

  /**
   * Choose arcsinh rather than logicle for one fluorescence channel.
   *
   * Workspace-wide for the same reason W is: the gating plot pools the checked files into one
   * cloud, so a per-file setting would draw half a cloud under logicle and half under arcsinh.
   */
  setFluorArcsinh(contextKey: string, channelKey: string, on: boolean): void {
    const key = settingsSlot(contextKey, channelKey);
    if (this.fluorArcsinh.has(key) === on) return;
    if (on) this.fluorArcsinh.add(key);
    else this.fluorArcsinh.delete(key);
    this.invalidate(contextKey, channelKey);
  }

  setScatterLinear(contextKey: string, channelKey: string, isLinear: boolean): void {
    const key = settingsSlot(contextKey, channelKey);
    if (this.scatterArcsinh.has(key) === !isLinear) return;
    if (isLinear) this.scatterArcsinh.delete(key);
    else this.scatterArcsinh.add(key);
    this.invalidate(contextKey, channelKey);
  }

  /** Drop every setting, e.g. when a new workspace replaces this one. */
  clear(): void {
    const had =
      this.explicitW.size || this.explicitCofactor.size || this.scatterArcsinh.size || this.fluorArcsinh.size;
    this.explicitW.clear();
    this.explicitCofactor.clear();
    this.scatterArcsinh.clear();
    this.fluorArcsinh.clear();
    this.sharedAutoW.clear();
    this.sharedAutoT.clear();
    if (had) this.notify();
  }

  /** An explicit choice is shared by both layers, so every file on either layer redraws. */
  private invalidate(contextKey: string, channelKey: string): void {
    const scope = settingsScope(contextKey);
    for (const participant of this.participants) {
      if (settingsScope(participant.workspaceScaleContextKey) !== scope) continue;
      const idx = participant.index(channelKey);
      if (idx !== undefined) participant.invalidateChannelForScales(idx);
    }
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
