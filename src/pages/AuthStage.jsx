import headerLogo from '../../logo-header2.png'
import { useAuthLocale } from './authLocale.js'

/*
 * AuthStage — dark brand stage on the left of Login/Register.
 * Reads every string from useAuthLocale() so toggling AR ↔ FR swaps the
 * full panel in sync with the form pane.
 */

export default function AuthStage() {
  const { t, dir } = useAuthLocale()
  return (
    <aside className="auth-stage" dir={dir}>
      <div className="auth-brand">
        <div className="auth-brand__logo" aria-hidden="true">
          <img src={headerLogo} alt="" />
        </div>
        <div className="auth-brand__tx">
          <div className="auth-brand__name">Zitouna Bladi</div>
          <div className="auth-brand__sub">{t('stageSub')}</div>
        </div>
      </div>

      <div className="auth-hero">
        <div className="auth-hero__eyebrow">
          <span className="auth-hero__dot" />
          {t('stageEyebrow')}
        </div>
        <h1>
          {t('stageH1a')} <em>{t('stageH1Em')}</em>{t('stageH1Comma')}<br />
          {t('stageH1b')} <span className="auth-u">{t('stageH1Under')}</span>{t('stageH1Dot')}
        </h1>
        <p>{t('stageIntro')}</p>

        <div className="auth-quote">
          <div className="auth-quote__q">{t('stageQuote')}</div>
          <div className="auth-quote__a">
            <b>{t('stageQuoteAuthor')}</b> · {t('stageQuoteAuthorSub')}
          </div>
        </div>
      </div>

      <div className="auth-bottom">
        <div className="auth-proof">
          <div className="auth-proof__avs" aria-hidden="true">
            <div className="auth-proof__av" style={{ background: '#D4A574' }}>AK</div>
            <div className="auth-proof__av" style={{ background: '#5B7F5C' }}>MB</div>
            <div className="auth-proof__av" style={{ background: '#8B6B4A' }}>SF</div>
            <div className="auth-proof__av" style={{ background: '#2D4A3E' }}>+</div>
          </div>
          <div className="auth-proof__txt">
            <span className="auth-proof__stars">★★★★★</span>
            <div>{t('stageRating')}</div>
          </div>
        </div>

        <div className="auth-kpi">
          <div>
            <div className="auth-kpi__v">{t('stageKpi1V')}<span className="auth-unit"> {t('stageKpi1Unit')}</span></div>
            <div className="auth-kpi__k">{t('stageKpi1K')}</div>
          </div>
          <div>
            <div className="auth-kpi__v">{t('stageKpi2V')}<span className="auth-unit">{t('stageKpi2Unit')}</span></div>
            <div className="auth-kpi__k">{t('stageKpi2K')}</div>
          </div>
          <div>
            <div className="auth-kpi__v">{t('stageKpi3V')}<span className="auth-unit"> {t('stageKpi3Unit')}</span></div>
            <div className="auth-kpi__k">{t('stageKpi3K')}</div>
          </div>
        </div>
      </div>

      <div className="auth-stage__cards" aria-hidden="true" dir="ltr">
        <div className="auth-fl auth-fl-1">
          <div className="auth-fl__row">
            <div className="auth-fl__ic">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2">
                <path d="M3 17l6-6 4 4 8-8" />
                <path d="M14 7h7v7" />
              </svg>
            </div>
            <div>
              <div className="auth-fl__t">{t('stageYtdLabel')}</div>
              <div className="auth-fl__v">+ 7.8%</div>
            </div>
          </div>
          <svg className="auth-fl__spark" viewBox="0 0 200 32" preserveAspectRatio="none">
            <defs>
              <linearGradient id="auth-spark" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#D4E4B8" />
                <stop offset="1" stopColor="#D4E4B8" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0 26 L20 22 L40 24 L60 18 L80 20 L100 14 L120 16 L140 10 L160 12 L180 6 L200 8" fill="none" stroke="#D4E4B8" strokeWidth="2" />
            <path d="M0 26 L20 22 L40 24 L60 18 L80 20 L100 14 L120 16 L140 10 L160 12 L180 6 L200 8 L200 32 L0 32 Z" fill="url(#auth-spark)" opacity="0.3" />
          </svg>
        </div>

        <div className="auth-fl auth-fl-3">
          <div className="auth-ring">
            <svg viewBox="0 0 36 36">
              <circle className="auth-ring__c auth-ring__c--t" cx="18" cy="18" r="15.9" />
              <circle className="auth-ring__c auth-ring__c--p" cx="18" cy="18" r="15.9" strokeDasharray="78 100" />
            </svg>
            <div className="auth-ring__num">78%</div>
          </div>
          <div className="auth-fl__info">
            <div className="auth-fl__t">{t('stageHarvestTitle')}</div>
            <div className="auth-fl__s">{t('stageHarvestSub')}</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
