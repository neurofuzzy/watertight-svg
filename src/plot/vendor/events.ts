/**
 * Replaces nib's `src/core/events.ts`, which extended Node's `EventEmitter`
 * (a bare `import { EventEmitter } from 'events'`). That is the one Node
 * dependency reachable from nib's browser entry point, so it is reimplemented
 * here with the same typed surface and no imports.
 *
 * Only the subset the EBB backend actually emits is kept — the job/layer
 * events belong to nib's multi-layer CLI job runner, which we do not vendor.
 */

import type { JobMetrics } from './job.ts'

export interface PlotEvents {
  'pen:up': []
  'pen:down': []
  'progress': [fraction: number, etaS: number]
  'complete': [metrics: JobMetrics]
  'abort': [stoppedAt: number]
  'pause': []
  'resume': []
}

type Listener = (...args: never[]) => void

export class PlotEmitter {
  private listeners = new Map<keyof PlotEvents, Set<Listener>>()

  emit<K extends keyof PlotEvents>(event: K, ...args: PlotEvents[K]): boolean {
    const set = this.listeners.get(event)
    if (!set || set.size === 0) return false
    // Copy first: a listener may call off() on itself while we iterate.
    for (const fn of [...set]) (fn as (...a: PlotEvents[K]) => void)(...args)
    return true
  }

  on<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(listener as Listener)
    return this
  }

  once<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    const wrapper = ((...args: PlotEvents[K]) => {
      this.off(event, wrapper)
      listener(...args)
    }) as (...args: PlotEvents[K]) => void
    return this.on(event, wrapper)
  }

  off<K extends keyof PlotEvents>(event: K, listener: (...args: PlotEvents[K]) => void): this {
    this.listeners.get(event)?.delete(listener as Listener)
    return this
  }

  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }
}
