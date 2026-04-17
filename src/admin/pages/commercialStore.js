/* ══════════════════════════════════════════════════════════════
   Live store for Centre d'appel ↔ Calendrier (realtime)
   - Source of truth: `public.appointments` where type='visit'
   - Payload is stored inside `appointments.notes` as JSON:
     { name, phone, project, motorise, extraNotes }
   ══════════════════════════════════════════════════════════════ */
import { useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase.js'
import { deleteAppointment, fetchAppointments, upsertAppointment } from '../../lib/db.js'

export const SLOT_OPTIONS = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00']

let calls = []
let listeners = new Set()
function emit() { listeners.forEach(fn => fn()) }

let channel = null
let refreshPromise = null

function safeJsonParse(s) {
  if (!s || typeof s !== 'string') return null
  const trimmed = s.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function toCallPayload(notesJsonOrText) {
  // If notes contain JSON, it's the new format.
  const parsed = safeJsonParse(notesJsonOrText)
  if (parsed && typeof parsed === 'object') {
    return {
      name: String(parsed.name || '').trim(),
      phone: String(parsed.phone || '').trim(),
      project: String(parsed.project || '').trim(),
      motorise: Boolean(parsed.motorise),
      extraNotes: String(parsed.extraNotes || parsed.notes || '').trim(),
    }
  }

  // Fallback for legacy/unstructured notes.
  return {
    name: '',
    phone: '',
    project: '',
    motorise: false,
    extraNotes: String(notesJsonOrText || '').trim(),
  }
}

function mapAppointmentToCall(apt) {
  const payload = toCallPayload(apt.notes)
  return {
    id: apt.id,
    name: payload.name,
    phone: payload.phone,
    project: payload.project,
    date: apt.date,
    time: apt.time,
    motorise: payload.motorise,
    notes: payload.extraNotes,
    type: apt.type,
    status: apt.status,
  }
}

async function refreshCalls() {
  if (refreshPromise) return refreshPromise
  refreshPromise = (async () => {
    const rows = await fetchAppointments()
    const visits = (rows || []).filter((a) => String(a.type || 'visit') === 'visit')
    calls = visits.map(mapAppointmentToCall)
    emit()
  })()
  try {
    await refreshPromise
  } finally {
    refreshPromise = null
  }
}

function ensureRealtime() {
  if (channel) return
  channel = supabase
    .channel('realtime-call-center-appointments')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'appointments' },
      () => void refreshCalls(),
    )
    .subscribe()
}

function maybeStopRealtime() {
  if (listeners.size > 0) return
  if (!channel) return
  supabase.removeChannel(channel)
  channel = null
}

export const callStore = {
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  getSnapshot() { return calls },
  async add(entry) {
    const payload = {
      name: entry.name || '',
      phone: entry.phone || '',
      project: entry.project || '',
      motorise: Boolean(entry.motorise),
      extraNotes: entry.notes || '',
    }

    await upsertAppointment({
      id: null,
      type: 'visit',
      status: 'new',
      date: entry.date,
      time: entry.time,
      notes: JSON.stringify(payload),
    })

    await refreshCalls()
  },
  async remove(id) {
    await deleteAppointment(id)
    await refreshCalls()
  },
}

export function useCalls() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      ensureRealtime()
      void refreshCalls()
      return () => {
        listeners.delete(fn)
        maybeStopRealtime()
      }
    },
    callStore.getSnapshot,
  )
}

export function initials(name) {
  const p = String(name || '').trim().split(/\s+/).filter(Boolean)
  return p.length ? `${p[0][0]}${p[1]?.[0] || ''}`.toUpperCase() : 'CL'
}

export function fmtDateFull(iso) {
  if (!iso) return '—'
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { weekday: 'long', day: '2-digit', month: 'long' }) }
  catch { return String(iso) }
}

export function fmtDateShort(iso) {
  if (!iso) return '—'
  try { return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }) }
  catch { return String(iso) }
}

export function todayIso() { return new Date().toISOString().slice(0, 10) }
