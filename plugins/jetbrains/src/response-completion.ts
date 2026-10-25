// Protocol decoders can cancel the body after their terminal event, before EOF.
export function observeResponseCompletion(response: Response, onComplete: () => void | Promise<void>): Response {
  if (!response.ok || !response.body) return response
  const reader = response.body.getReader()
  let completed = false
  const complete = () => {
    if (completed) return
    completed = true
    try { void Promise.resolve(onComplete()).catch(() => {}) }
    catch { /* Balance reporting must not interrupt inference. */ }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          reader.releaseLock()
          controller.close()
          complete()
        } else controller.enqueue(result.value)
      } catch (error) {
        reader.releaseLock()
        controller.error(error)
      }
    },
    async cancel(reason) {
      complete()
      try { await reader.cancel(reason) }
      finally { reader.releaseLock() }
    },
  }, { highWaterMark: 0 })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
