import { useEffect, useRef } from 'react'
import { getAdminPreviewScrollLockEl } from '../previewScrollLock.js'

export default function AdminDrawer({ open, onClose, title, subtitle, children, footer, width = 480, className = '', preventOverlayClose = false }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    if (!open) return
    function onKey(e) {
      if (e.key === 'Escape' && !preventOverlayClose) onClose()
    }
    window.addEventListener('keydown', onKey)
    const lockEl = getAdminPreviewScrollLockEl(overlayRef.current) || document.body
    const hadOverflow = lockEl.style.overflow
    lockEl.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      if (lockEl === document.body) {
        const otherModal = document.querySelector('.zadm-modal-overlay, .adm-modal-overlay')
        if (!otherModal) lockEl.style.overflow = hadOverflow || ''
      } else {
        lockEl.style.overflow = hadOverflow || ''
      }
    }
  }, [open, onClose, preventOverlayClose])

  if (!open) return null

  return (
    <div className="zadm-drawer-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current && !preventOverlayClose) onClose() }}>
      <aside className={`zadm-drawer${className ? ` ${className}` : ''}`} style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <header className="zadm-drawer__header">
          <div className="zadm-drawer__head-text">
            <h3 className="zadm-drawer__title">{title}</h3>
            {subtitle ? <p className="zadm-drawer__subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="zadm-drawer__close" onClick={onClose} aria-label="Fermer">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </header>
        <div className="zadm-drawer__body">{children}</div>
        {footer ? <div className="zadm-drawer__footer">{footer}</div> : null}
      </aside>
    </div>
  )
}
