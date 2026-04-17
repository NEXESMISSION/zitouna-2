/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const ToastCtx = createContext({ addToast: () => {} })

export function useToast() { return useContext(ToastCtx) }

function Toast({ id, message, type, onRemove }) {
  useEffect(() => {
    const t = setTimeout(() => onRemove(id), 1800)
    return () => clearTimeout(t)
  }, [id, onRemove])

  return (
    <div className={`adm-toast adm-toast--${type}`}>
      <span className="adm-toast-icon">
        {type === 'success' ? '✓' : type === 'error' ? '✕' : 'ⓘ'}
      </span>
      <span style={{ flex: 1 }}>{message}</span>
      <button
        onClick={() => onRemove(id)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'inherit', fontSize: 9, fontWeight: 700,
          padding: '0 0 0 4px', lineHeight: 1, opacity: 0.45,
        }}
      >✕</button>
    </div>
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const counter = useRef(0)

  const addToast = useCallback((message, type = 'success') => {
    const id = ++counter.current
    setToasts((prev) => [...prev, { id, message, type }])
  }, [])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastCtx.Provider value={{ addToast }}>
      {children}
      <div className="adm-toast-container">
        {toasts.map((t) => (
          <Toast key={t.id} id={t.id} message={t.message} type={t.type} onRemove={removeToast} />
        ))}
      </div>
    </ToastCtx.Provider>
  )
}
