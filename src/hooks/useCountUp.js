import { useEffect, useState } from 'react'

export function useCountUp(target, { duration = 900, delay = 0 } = {}) {
  const [value, setValue] = useState(0)

  useEffect(() => {
    const end = Number(target) || 0
    let raf = 0
    let timeout = 0
    const startAt = performance.now()

    const step = (now) => {
      const t = Math.min((now - startAt) / Math.max(1, duration), 1)
      setValue(end * t)
      if (t < 1) raf = requestAnimationFrame(step)
    }

    timeout = window.setTimeout(() => {
      setValue(0)
      raf = requestAnimationFrame(step)
    }, Math.max(0, delay))

    return () => {
      window.clearTimeout(timeout)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [target, duration, delay])

  return value
}

