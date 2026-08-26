import { createClient } from '@supabase/supabase-js'

// Service role key — backend writes have no browser session, so they bypass RLS.
// Never NEXT_PUBLIC_-prefixed: that prefix means "safe to ship to a browser".
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// fail at boot, not at the first insert
if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in backend/.env')
}

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
