import { useEffect, useRef } from 'react'
import { getAdminPreviewScrollLockEl } from '../previewScrollLock.js'

export default function AdminDrawer({ open, onClose, title, subtitle, children, width = 480, className = '', preventOverlayClose = false }) {
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
        const otherModal = document.querySelector('.adm-modal-overlay')
        if (!otherModal) lockEl.style.overflow = hadOverflow || ''
      } else {
        lockEl.style.overflow = hadOverflow || ''
      }
    }
  }, [open, onClose, preventOverlayClose])

  if (!open) return null

  return (
    <div className="adm-drawer-overlay" ref={overlayRef} onClick={(e) => { if (e.target === overlayRef.current && !preventOverlayClose) onClose() }}>
      <aside className={`adm-drawer${className ? ` ${className}` : ''}`} style={{ maxWidth: width }}>
        <header className="adm-drawer-header">
          <div className="adm-drawer-head-text">
            <h3 className="adm-drawer-title">{title}</h3>
            {subtitle ? <p className="adm-drawer-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="adm-drawer-close" onClick={onClose} aria-label="Fermer">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </header>
        <div className="adm-drawer-body">{children}</div>
      </aside>
    </div>
  )
}
