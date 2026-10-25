// Coalesce polling reads, while preserving a manual refresh queued behind one.
export class StatusRequests<T> {
  pending?: Promise<T | undefined>
  private forced = false
  private queued?: Promise<T | undefined>
  private generation = 0

  clear(): void {
    this.generation++
    this.pending = undefined
    this.queued = undefined
  }

  run(force: boolean, request: () => Promise<T | undefined>): Promise<T | undefined> {
    if (this.pending) {
      if (!force || this.forced) return this.pending
      if (this.queued) return this.queued
      const generation = this.generation
      const queued = this.pending.catch(() => undefined).then(() => {
        if (generation === this.generation) {
          if (this.queued === queued) this.queued = undefined
          return this.run(true, request)
        }
      }).finally(() => { if (this.queued === queued) this.queued = undefined })
      this.queued = queued
      return queued
    }
    this.forced = force
    const pending = Promise.resolve().then(request).finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }
}
