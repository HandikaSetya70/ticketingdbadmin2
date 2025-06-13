// /api/admin/blockchain-stats.js
// Get blockchain statistics for dashboard cards

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  console.log('📊 ============ BLOCKCHAIN STATS REQUEST ============');
  console.log('⏰ Timestamp:', new Date().toISOString());
  
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ 
      status: 'error', 
      message: 'Method not allowed' 
    });
  }

  try {
    // Verify admin authentication
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Authorization token required' 
      });
    }

    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Invalid authentication token' 
      });
    }

    // Look up admin's user_id in the users table
    const { data: adminUser, error: adminError } = await supabase
      .from('users')
      .select('user_id, id_name, role')
      .eq('auth_id', user.id)
      .single();

    if (adminError || !adminUser) {
      return res.status(401).json({ 
        status: 'error', 
        message: 'Admin user not found' 
      });
    }

    if (adminUser.role !== 'admin' && adminUser.role !== 'super_admin') {
      return res.status(403).json({ 
        status: 'error', 
        message: 'Admin privileges required' 
      });
    }

    console.log('✅ Admin authentication verified:', adminUser.id_name);

    // Gather blockchain statistics
    console.log('📊 ============ GATHERING BLOCKCHAIN STATISTICS ============');

    const stats = await gatherBlockchainStats();

    console.log('📊 Statistics gathered:');
    console.log('   🔗 Registered tokens:', stats.registered_count);
    console.log('   ❌ Revoked tokens:', stats.revoked_count);
    console.log('   ⏳ Pending tokens:', stats.pending_count);
    console.log('   💥 Failed tokens:', stats.failed_count);

    return res.status(200).json({
      status: 'success',
      message: 'Blockchain statistics retrieved successfully',
      data: stats
    });

  } catch (error) {
    console.error('❌ Error in blockchain stats endpoint:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve blockchain statistics',
      error: error.message
    });
  }
}

// Gather comprehensive blockchain statistics
async function gatherBlockchainStats() {
  try {
    console.log('🔍 Executing statistics queries...');

    // Get all blockchain tickets in one query for analysis
    const { data: allTickets, error } = await supabase
      .from('tickets')
      .select(`
        ticket_id,
        nft_token_id,
        ticket_status,
        blockchain_registered,
        nft_mint_status,
        blockchain_sync_status,
        last_blockchain_sync
      `)
      .not('nft_token_id', 'is', null);

    if (error) {
      throw new Error(`Database query failed: ${error.message}`);
    }

    console.log(`📋 Analyzing ${allTickets?.length || 0} blockchain tickets...`);

    // Initialize counters
    let registered_count = 0;
    let revoked_count = 0;
    let pending_count = 0;
    let failed_count = 0;
    let total_with_token_id = allTickets?.length || 0;

    // Analyze each ticket
    if (allTickets && allTickets.length > 0) {
      allTickets.forEach(ticket => {
        // Count based on current ticket status and blockchain registration
        if (ticket.ticket_status === 'revoked') {
          revoked_count++;
        } else if (ticket.blockchain_registered === true && ticket.ticket_status === 'valid') {
          registered_count++;
        } else if (ticket.nft_mint_status === 'failed') {
          failed_count++;
        } else {
          // Tickets that have token IDs but aren't registered yet
          pending_count++;
        }
      });
    }

    // Get additional statistics
    const additionalStats = await getAdditionalStats();

    const stats = {
      // Core blockchain statistics
      registered_count: registered_count,
      revoked_count: revoked_count,
      pending_count: pending_count,
      failed_count: failed_count,
      
      // Additional metrics
      total_with_token_id: total_with_token_id,
      total_tickets: additionalStats.total_tickets,
      blockchain_coverage_percentage: total_with_token_id > 0 ? 
        ((total_with_token_id / additionalStats.total_tickets) * 100).toFixed(2) : "0.00",
      
      // Sync statistics
      recently_synced: additionalStats.recently_synced,
      never_synced: additionalStats.never_synced,
      
      // Status breakdown percentages
      registered_percentage: total_with_token_id > 0 ? 
        ((registered_count / total_with_token_id) * 100).toFixed(2) : "0.00",
      revoked_percentage: total_with_token_id > 0 ? 
        ((revoked_count / total_with_token_id) * 100).toFixed(2) : "0.00",
      pending_percentage: total_with_token_id > 0 ? 
        ((pending_count / total_with_token_id) * 100).toFixed(2) : "0.00",
      failed_percentage: total_with_token_id > 0 ? 
        ((failed_count / total_with_token_id) * 100).toFixed(2) : "0.00",
      
      // Metadata
      last_updated: new Date().toISOString(),
      data_freshness: "real-time"
    };

    console.log('✅ Statistics analysis complete');
    return stats;

  } catch (error) {
    console.error('❌ Error gathering blockchain stats:', error);
    throw error;
  }
}

// Get additional statistics for comprehensive reporting
async function getAdditionalStats() {
  try {
    // Get total tickets count
    const { count: totalTickets, error: totalError } = await supabase
      .from('tickets')
      .select('*', { count: 'exact', head: true });

    if (totalError) {
      throw new Error(`Failed to get total tickets: ${totalError.message}`);
    }

    // Get sync statistics (only if the columns exist)
    let recently_synced = 0;
    let never_synced = 0;

    try {
      // Check for tickets synced in last 24 hours
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const { count: recentSyncCount, error: recentError } = await supabase
        .from('tickets')
        .select('*', { count: 'exact', head: true })
        .not('nft_token_id', 'is', null)
        .gte('last_blockchain_sync', oneDayAgo);

      if (!recentError) {
        recently_synced = recentSyncCount || 0;
      }

      // Check for tickets never synced
      const { count: neverSyncedCount, error: neverError } = await supabase
        .from('tickets')
        .select('*', { count: 'exact', head: true })
        .not('nft_token_id', 'is', null)
        .is('last_blockchain_sync', null);

      if (!neverError) {
        never_synced = neverSyncedCount || 0;
      }

    } catch (syncError) {
      console.warn('⚠️ Could not get sync statistics (columns may not exist yet):', syncError.message);
      // This is expected if the sync columns haven't been added yet
    }

    return {
      total_tickets: totalTickets || 0,
      recently_synced: recently_synced,
      never_synced: never_synced
    };

  } catch (error) {
    console.error('❌ Error getting additional stats:', error);
    return {
      total_tickets: 0,
      recently_synced: 0,
      never_synced: 0
    };
  }
}