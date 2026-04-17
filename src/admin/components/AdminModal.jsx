import { useEffect, useRef } from 'react'
import { getAdminPreviewScrollLockEl } from '../previewScrollLock.js'

export default function AdminModal({ open, onClose, title, children, footer, width = 520 }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    const lockEl = getAdminPreviewScrollLockEl(overlayRef.current) || document.body
    const hadOverflow = lockEl.style.overflow
    lockEl.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (lockEl === document.body) {
        const otherOverlay = document.querySelector('.adm-drawer-overlay')
        if (!otherOverlay) lockEl.style.overflow = hadOverflow || ''
      } else {
        lockEl.style.overflow = hadOverflow || ''
      }
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="adm-modal-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current) onClose() }}>
      <div className="adm-modal" style={{ maxWidth: width }}>
        {title ? (
          <header className="adm-modal-header">
            <h3 className="adm-modal-title">{title}</h3>
            <button className="adm-modal-close" onClick={onClose} aria-label="Fermer">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </header>
        ) : (
          <button className="adm-modal-close adm-modal-close--floating" onClick={onClose} aria-label="Fermer">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        )}
        <div className="adm-modal-body">{children}</div>
        {footer && <div className="adm-modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
