import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

const looksLikeLegacyJwt = typeof supabaseAnonKey === 'string' && supabaseAnonKey.startsWith('eyJ')
const looksLikePublishableKey = typeof supabaseAnonKey === 'string' && supabaseAnonKey.startsWith('sb_publishable_')
export const isSupabaseConfigured = Boolean(supabaseUrl && (looksLikeLegacyJwt || looksLikePublishableKey))
export const supabase = isSupabaseConfigured ? createClient(supabaseUrl, supabaseAnonKey) : null
