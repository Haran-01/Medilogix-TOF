const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

function loadSupabaseConfig(app) {
  const appRoot = app.getAppPath();
  dotenv.config({ path: path.join(appRoot, '.env'), quiet: true });
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!url || !key) return { configured: false, reason: 'missing_config' };
  let parsed;
  try { parsed = new URL(url); } catch { return { configured: false, reason: 'invalid_url' }; }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return { configured: false, reason: 'invalid_url' };
  }
  return { configured: true, url: parsed.toString().replace(/\/$/, ''), key };
}

function getEmailConfirmationRedirectUrl() {
  const configured = String(process.env.SUPABASE_EMAIL_REDIRECT_URL || '').trim();
  const redirectUrl = configured || 'https://medilogix-recordings.vercel.app/email-confirmed.html';
  let parsed;
  try { parsed = new URL(redirectUrl); } catch { throw new Error('Email confirmation redirect URL is invalid.'); }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('Email confirmation redirect URL must use HTTPS.');
  }
  return parsed.toString();
}

function createAuthStorage(app, safeStorage) {
  const sessionFile = path.join(app.getPath('userData'), 'supabase-auth-session.enc');
  const storageKey = 'medilogix-supabase-auth';
  return {
    async getItem(key) {
      if (key !== storageKey || !safeStorage.isEncryptionAvailable() || !fs.existsSync(sessionFile)) return null;
      try { return safeStorage.decryptString(fs.readFileSync(sessionFile)); }
      catch { return null; }
    },
    async setItem(key, value) {
      if (key !== storageKey) return;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure session storage is unavailable on this computer.');
      const tempFile = `${sessionFile}.tmp`;
      fs.writeFileSync(tempFile, safeStorage.encryptString(value));
      fs.renameSync(tempFile, sessionFile);
    },
    async removeItem(key) {
      if (key === storageKey && fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    }
  };
}

function createSupabaseBackend({ app, safeStorage, onAuthChange = () => {} }) {
  const config = loadSupabaseConfig(app);
  if (!config.configured) {
    return {
      configured: false,
      status: async () => ({ configured: false, email: null, userId: null, reason: config.reason }),
      signInWithPassword: async () => { throw new Error('Supabase is not configured.'); },
      signUpWithPassword: async () => { throw new Error('Supabase is not configured.'); },
      updateProfile: async () => { throw new Error('Supabase is not configured.'); },
      signOutUser: async () => { throw new Error('Supabase is not configured.'); },
      getUser: async () => null,
      syncRecording: async () => { throw new Error('Supabase is not configured.'); },
      listSessions: async () => { throw new Error('Supabase is not configured.'); },
      getSessionRecords: async () => { throw new Error('Supabase is not configured.'); }
    };
  }

  const supabase = createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      storage: createAuthStorage(app, safeStorage),
      storageKey: 'medilogix-supabase-auth'
    }
  });
  const profileDetails = (user) => ({
    doctorName: user?.user_metadata?.doctor_name || '',
    phoneNumber: user?.user_metadata?.phone_number || ''
  });
  supabase.auth.onAuthStateChange((_event, session) => {
    onAuthChange({ configured: true, email: session?.user?.email || null, userId: session?.user?.id || null, ...profileDetails(session?.user) });
  });

  const currentUser = async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data.session?.user || null;
  };

  const status = async () => {
    const user = await currentUser();
    return { configured: true, email: user?.email || null, userId: user?.id || null, ...profileDetails(user) };
  };

  async function syncRecording(metadata, records) {
    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user) throw new Error('Sign in again before syncing recordings to Supabase.');
    const user = data.user;
    if (!metadata.cloudOwnerId || metadata.cloudOwnerId !== user.id) {
      throw new Error('This recording was started under a different account. Sign in to that account to sync it.');
    }

    const device = metadata.device || {};
    const sessionRow = {
      id: metadata.sessionId,
      user_id: user.id,
      device_name: device.portName || device.label || null,
      vendor_id: device.vendorId || null,
      product_id: device.productId || null,
      baud_rate: metadata.baudRate,
      data_bits: metadata.dataBits,
      parity: metadata.parity,
      stop_bits: metadata.stopBits,
      started_at: metadata.startedAt,
      ended_at: metadata.endedAt || null,
      status: metadata.status,
      simulated: Boolean(metadata.simulated),
      imported: Boolean(metadata.imported),
      recording_date: metadata.recordingDate || null,
      patient_name: metadata.patientName || null,
      patient_age: metadata.patientAge == null ? null : Number(metadata.patientAge),
      patient_gender: metadata.patientGender || null,
      source_file_name: metadata.sourceFileName || null,
      updated_at: new Date().toISOString(),
      device_metadata: { recordFormat: metadata.recordFormat || null, endDetail: metadata.endDetail || null }
    };
    const { error: sessionError } = await supabase.from('recording_sessions').upsert(sessionRow, { onConflict: 'id' });
    if (sessionError) throw sessionError;

    const chunkSize = 250;
    for (let offset = 0; offset < records.length; offset += chunkSize) {
      const rows = records.slice(offset, offset + chunkSize).map((record) => ({
        session_id: metadata.sessionId,
        user_id: user.id,
        sequence: record.sequence,
        received_at: record.receivedAt,
        raw: String(record.raw ?? ''),
        complete: Boolean(record.complete),
        event_type: record.type || 'unknown',
        mode: record.mode || null,
        device_time: record.deviceTime || null,
        source_date: record.sourceDate || null,
        value: record.value == null ? null : record.value,
        denominator: record.denominator == null ? null : record.denominator,
        parsed_fields: {
          interpretationConfirmed: Boolean(record.interpretationConfirmed),
          sourceMarker: record.sourceMarker || null,
          sourceSequence: record.sourceSequence || null,
          unit: record.unit || null,
          payload: record.payload || null,
          event: record.event || null
        }
      }));
      if (!rows.length) continue;
      const { error } = await supabase.from('recording_events').upsert(rows, { onConflict: 'session_id,sequence' });
      if (error) throw error;
    }
    return { synced: true, userId: user.id, recordsSynced: records.length };
  }

  return {
    configured: true,
    status,
    getUser: currentUser,
    signInWithPassword: async (email, password) => {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return { email: data.user.email, userId: data.user.id };
    },
    signUpWithPassword: async ({ email, password, doctorName, phoneNumber }) => {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { doctor_name: doctorName, phone_number: phoneNumber },
          emailRedirectTo: getEmailConfirmationRedirectUrl()
        }
      });
      if (error) throw error;
      return {
        email: data.user?.email || email,
        userId: data.user?.id || null,
        confirmationRequired: !data.session,
        ...profileDetails(data.user)
      };
    },
    updateProfile: async ({ doctorName, phoneNumber }) => {
      const name = String(doctorName || '').trim();
      const phone = String(phoneNumber || '').trim();
      if (!name || name.length > 120) throw new Error('Enter a name of 1 to 120 characters.');
      if (!phone || phone.length > 40) throw new Error('Enter a phone number of 1 to 40 characters.');
      const { data, error } = await supabase.auth.updateUser({
        data: { doctor_name: name, phone_number: phone }
      });
      if (error) throw error;
      return { ...profileDetails(data.user), email: data.user.email || null, userId: data.user.id };
    },
    signOutUser: async () => {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    },
    syncRecording,
    async listSessions() {
      const { data, error } = await supabase.from('recording_sessions')
        .select('id,device_name,baud_rate,started_at,ended_at,status,simulated,imported,recording_date,patient_name,patient_age,patient_gender,source_file_name')
        .order('started_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async getSessionRecords(sessionId) {
      const { data: metadata, error: sessionError } = await supabase.from('recording_sessions')
        .select('id,device_name,baud_rate,started_at,ended_at,status,simulated,imported,recording_date,patient_name,patient_age,patient_gender,source_file_name')
        .eq('id', sessionId).single();
      if (sessionError) throw sessionError;
      const { data: records, error } = await supabase.from('recording_events')
        .select('sequence,received_at,raw,complete,event_type,mode,device_time,source_date,value,denominator,parsed_fields')
        .eq('session_id', sessionId).order('sequence', { ascending: true });
      if (error) throw error;
      return {
        metadata: {
          sessionId: metadata.id,
          device: { label: metadata.device_name },
          baudRate: metadata.baud_rate,
          startedAt: metadata.started_at,
          endedAt: metadata.ended_at,
          status: metadata.status,
          simulated: metadata.simulated,
          imported: metadata.imported,
          recordingDate: metadata.recording_date,
          patientName: metadata.patient_name,
          patientAge: metadata.patient_age,
          patientGender: metadata.patient_gender,
          sourceFileName: metadata.source_file_name
        },
        records: (records || []).map((record) => ({
          sequence: record.sequence,
          receivedAt: record.received_at,
          raw: record.raw,
          complete: record.complete,
          type: record.event_type,
          mode: record.mode,
          deviceTime: record.device_time,
          sourceDate: record.source_date,
          value: record.value,
          denominator: record.denominator,
          ...(record.parsed_fields || {})
        }))
      };
    }
  };
}

module.exports = { createSupabaseBackend, loadSupabaseConfig };
