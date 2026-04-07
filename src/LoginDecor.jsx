/** Decorative SVGs matching zaytouna_bladi_login.html */

export function LoginWatermarkRight() {
  return (
    <div className="login-watermark login-watermark--right" aria-hidden="true">
      <svg viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <path
          d="M100 10 C160 40 190 100 180 180 C170 250 130 280 100 290 C70 280 30 250 20 180 C10 100 40 40 100 10Z"
          fill="#7ab632"
        />
        <line x1="100" y1="20" x2="100" y2="280" stroke="#7ab632" strokeWidth="4" />
        <line x1="100" y1="80" x2="60" y2="120" stroke="#7ab632" strokeWidth="2.5" />
        <line x1="100" y1="120" x2="145" y2="155" stroke="#7ab632" strokeWidth="2.5" />
        <line x1="100" y1="160" x2="58" y2="195" stroke="#7ab632" strokeWidth="2.5" />
        <line x1="100" y1="200" x2="142" y2="230" stroke="#7ab632" strokeWidth="2.5" />
      </svg>
    </div>
  )
}

export function LoginWatermarkLeft() {
  return (
    <div className="login-watermark login-watermark--left" aria-hidden="true">
      <svg viewBox="0 0 200 300" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <path
          d="M100 10 C160 40 190 100 180 180 C170 250 130 280 100 290 C70 280 30 250 20 180 C10 100 40 40 100 10Z"
          fill="#7ab632"
        />
        <line x1="100" y1="20" x2="100" y2="280" stroke="#7ab632" strokeWidth="4" />
      </svg>
    </div>
  )
}

export function LoginLogoMark() {
  return (
    <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" className="login-logo-svg" aria-hidden="true">
      <path d="M50 5 L88 35 L88 70 L50 95 L12 70 L12 35 Z" fill="none" stroke="#8ab830" strokeWidth="3" opacity="0.7" />
      <path
        d="M50 15 C72 25 80 48 72 68 C64 82 50 88 50 88 C50 88 36 82 28 68 C20 48 28 25 50 15Z"
        fill="#6a9a20"
        opacity="0.9"
      />
      <line x1="50" y1="18" x2="50" y2="85" stroke="#4a7010" strokeWidth="1.5" />
      <line x1="50" y1="40" x2="38" y2="55" stroke="#4a7010" strokeWidth="1" />
      <line x1="50" y1="55" x2="62" y2="67" stroke="#4a7010" strokeWidth="1" />
      <circle cx="50" cy="60" r="7" fill="#3a5a10" />
      <ellipse cx="50" cy="55" rx="3" ry="2" fill="#7ab830" opacity="0.6" />
      <path d="M50 78 C48 82 47 86 50 90 C53 86 52 82 50 78Z" fill="#8ab830" opacity="0.8" />
    </svg>
  )
}

export function IconGoogle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

export function IconFacebook() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1877F2" />
      <path d="M13.5 8H15V5.5h-2C11.3 5.5 10 6.8 10 8.5V10H8v3h2v8.5h3V13h2l.5-3h-2.5V8.5c0-.28.22-.5.5-.5z" fill="white" />
    </svg>
  )
}

export function IconUser() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  )
}

export function IconKey() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" aria-hidden="true">
      <circle cx="8" cy="15" r="3" />
      <path d="M11 15h8M16 15v-4" />
      <path d="M8 12V8" />
    </svg>
  )
}

export function IconEyeOff() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

export function IconEye() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function IconLogout() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  )
}

export function IconBell() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}
