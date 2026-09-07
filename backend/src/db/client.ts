import { createClient } from '@supabase/supabase-js'

// Service role key — backend writes have no browser session, so they bypass RLS.
// Never NEXT_PUBLIC_-prefixed: that prefix means "safe to ship to a browser".
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

// fail at boot, not at the first insert
if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in backend/.env')
}

// TARGET_CHAT_JID set = production. Refuse to boot rather than quietly write real
// business expenses into the testing table. Production gets BILLS_TABLE from
// docker-compose.yml's environment: block, so this only bites a container run
// outside Compose. Testing against a real group: set BILLS_TABLE=bills_testing.
if (process.env.TARGET_CHAT_JID && !process.env.BILLS_TABLE) {
    throw new Error('TARGET_CHAT_JID is set (production) but BILLS_TABLE is not — set BILLS_TABLE=bills')
}

/**
 * Which table this process reads and writes. Defaults to the TESTING table on
 * purpose: an unset var must never silently touch the business's real expenses,
 * so plain `npm start` is always safe. Production's `bills` is set in
 * docker-compose.yml (environment: BILLS_TABLE=${BILLS_TABLE:-bills}).
 */
export const BILLS_TABLE = process.env.BILLS_TABLE || 'bills_testing'

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
