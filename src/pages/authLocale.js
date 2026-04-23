import { useCallback, useSyncExternalStore } from 'react'

const DEFAULT_LOCALE = 'fr'

// FR-only: Arabic support removed. Kept `useAuthLocale` / `toggle` API so
// callers don't need to change, but `toggle` is a no-op and snapshot is
// always 'fr'.
const currentLocale = DEFAULT_LOCALE
function subscribe() { return () => {} }
function getSnapshot() { return currentLocale }
function getServerSnapshot() { return DEFAULT_LOCALE }

const DICT = {
  fr: {
    dir: 'ltr',
    lang: 'fr',
    langButton: '🇫🇷 FR',
    langButtonAria: 'Changer de langue',

    tabLogin: 'Se connecter',
    tabRegister: 'Créer un compte',

    loginTitle: 'Content de vous revoir 👋',
    loginSubtitle: 'Connectez-vous pour suivre vos oliviers, consulter vos rapports drone et gérer vos échéances.',
    email: 'E-mail',
    password: 'Mot de passe',
    showPwd: 'Afficher',
    hidePwd: 'Masquer',
    showPwdAria: 'Afficher le mot de passe',
    hidePwdAria: 'Masquer le mot de passe',
    keepLogged: 'Rester connecté',
    forgotPwd: 'Mot de passe oublié ?',
    loginBtn: 'Se connecter',
    loginPending: 'Connexion en cours…',
    loginError: 'Connexion impossible.',
    retry: 'Réessayer',
    sessionCheck: 'Vérification de la session…',

    registerTitle: 'Commencez votre verger.',
    registerSubtitle: 'Un compte, un arbre, un rapport mensuel. Pas de carte bancaire requise pour explorer.',
    firstname: 'Prénom',
    lastname: 'Nom',
    phone: 'Téléphone',
    confirmPwd: 'Confirmez le mot de passe',
    firstnamePh: 'Saif',
    lastnamePh: 'Ayari',
    phonePh: '98 452 110',
    passwordPh: 'Au moins 8 caractères',
    confirmPh: '••••••••',
    phonePreviewLabel: 'Sera enregistré :',
    strengthLabels: ['', 'Faible', 'Moyen', 'Fort', 'Excellent'],
    tosText: ['En créant un compte, vous acceptez nos ', 'Conditions', ' et notre ', 'politique de confidentialité', '.'],
    registerBtn: 'Créer un compte',
    registerPending: 'Création du compte…',
    registerError: 'Impossible de créer le compte.',
    valNameRequired: 'Prénom et nom requis.',
    valEmailInvalid: 'Adresse e-mail invalide.',
    valCountryCode: 'Indicatif pays invalide.',
    valPhoneShort: 'Le numéro doit contenir au moins 6 chiffres.',
    valPwdMismatch: 'Les deux mots de passe ne correspondent pas.',
    reasonPhoneConflict: 'Ce numéro est déjà lié à un autre compte. Utilisez un autre numéro ou contactez le support si c\u2019est le vôtre.',
    reasonEmailConflict: 'Cet e-mail est déjà utilisé. Essayez « Mot de passe oublié » ou utilisez une autre adresse.',
    reasonWeakPwd: 'Mot de passe trop faible. Utilisez au moins 8 caractères avec lettres et chiffres.',
    reasonInvalidEmail: 'Adresse e-mail invalide. Vérifiez la saisie.',
    reasonProfileUnavailable: 'Le compte est créé. Connectez-vous : la liaison au profil client se terminera à la connexion.',
    successConfirm: 'Consultez votre e-mail pour confirmer le compte, puis connectez-vous.',
    successCreated: 'Compte créé avec succès !',
    signupTimeout: 'Le serveur ne répond pas (>20 s). Le compte est peut-être créé — essayez de vous connecter, ou réessayez plus tard.',

    stageSub: 'Oliveraie · Fondée en 2023',
    stageEyebrow: 'Récolte 2026 · 1 247 investisseurs actifs',
    stageH1a: 'Plantez un',
    stageH1Em: 'olivier',
    stageH1Comma: ',',
    stageH1b: 'percevez un',
    stageH1Under: 'revenu annuel',
    stageH1Dot: '.',
    stageIntro: 'Investissez dans des parcelles d\u2019oliviers certifiées Bio en Tunisie. Suivez chaque arbre en temps réel et surveillez votre production.',
    stageQuote: 'J\u2019ai planté 42 oliviers pour ma fille. Chaque mois, je reçois un rapport drone — je suis l\u2019évolution depuis Paris.',
    stageQuoteAuthor: 'Amal Kraï',
    stageQuoteAuthorSub: 'Investisseuse depuis 2024',
    stageRating: '4,9/5 · 1 247 investisseurs',
    stageKpi1V: '14 820',
    stageKpi1Unit: 'oliviers',
    stageKpi1K: 'plantés à ce jour',
    stageKpi2V: '7,4',
    stageKpi2Unit: '% / an',
    stageKpi2K: 'rendement moyen',
    stageKpi3V: '312',
    stageKpi3Unit: 'hectares',
    stageKpi3K: 'superficie certifiée',
    stageYtdLabel: 'Rendement YTD',
    stageHarvestTitle: 'Récolte 2026',
    stageHarvestSub: 'Maturité atteinte · collecte prévue nov 2026',

    footCopy: '© {year} Zitouna Bladi · Tunis',
    privacy: 'Confidentialité',
    terms: 'Conditions',
    help: 'Aide',
  },
}

export function useAuthLocale() {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const toggle = useCallback(() => {}, [])

  const t = useCallback(
    (key, vars) => {
      const s = DICT[locale]?.[key] ?? DICT[DEFAULT_LOCALE][key] ?? ''
      if (!vars) return s
      return Object.keys(vars).reduce((acc, k) => acc.replaceAll(`{${k}}`, String(vars[k])), s)
    },
    [locale],
  )

  const dict = DICT[locale] || DICT[DEFAULT_LOCALE]
  return { locale, toggle, t, dir: dict.dir, lang: dict.lang }
}
