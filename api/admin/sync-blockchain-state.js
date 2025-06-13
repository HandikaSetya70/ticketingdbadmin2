// /api/admin/sync-blockchain-state.js
// Syncs database ticket states with actual blockchain state

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Blockchain configuration
const BLOCKCHAIN_CONFIG = {
  rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://sepolia.infura.io/v3/' + process.env.INFURA_PROJECT_ID,
  contractAddress: process.env.REVOCATION_CONTRACT_ADDRESS || '0x86d22947cE0D2908eC0CAC78f7EC405f15cB9e50',
  privateKey: process.env.ADMIN_PRIVATE_KEY,
  network: 'sepolia'
};

// Contract ABI for reading ticket states
const CONTRACT_ABI = [
  "function getTicketStatus(uint256 tokenId) external view returns (uint8)",
  "function isRevoked(uint256 tokenId) external view returns (bool)",
  "function owner() external view returns (address)"
];

export default async function handler(req, res) {
  console.log('🔄 ============ BLOCKCHAIN STATE SYNC STARTED ============');
  console.log('⏰ Timestamp:', new Date().toISOString());
  
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle OPTIONS preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
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
    console.log('👮 Admin role:', adminUser.role);

    // Parse request parameters
    const { 
      limit = 100,           // How many tickets to sync at once
      force_resync = false   // Force resync even if recently synced
    } = req.body || {};

    console.log('📋 Sync parameters:');
    console.log('   📊 Limit:', limit);
    console.log('   🔄 Force resync:', force_resync);

    // Start the blockchain sync process
    const syncResult = await performBlockchainSync(limit, force_resync);

    if (syncResult.success) {
      console.log('✅ ============ BLOCKCHAIN SYNC SUCCESSFUL ============');
      console.log('📊 Sync summary:');
      console.log('   🎫 Total tickets checked:', syncResult.totalChecked);
      console.log('   🔄 Database updates made:', syncResult.updatedCount);
      console.log('   ✅ Successfully synced:', syncResult.successfulSyncs);
      console.log('   ❌ Failed syncs:', syncResult.failedSyncs);
      console.log('   ⏱️ Sync duration:', syncResult.duration + 'ms');

      return res.status(200).json({
        status: 'success',
        message: `Blockchain sync completed successfully. Updated ${syncResult.updatedCount} tickets.`,
        data: {
          total_checked: syncResult.totalChecked,
          updated_count: syncResult.updatedCount,
          successful_syncs: syncResult.successfulSyncs,
          failed_syncs: syncResult.failedSyncs,
          sync_duration_ms: syncResult.duration,
          discrepancies_found: syncResult.discrepanciesFound,
          last_sync: new Date().toISOString(),
          sync_details: syncResult.details
        }
      });

    } else {
      console.error('❌ ============ BLOCKCHAIN SYNC FAILED ============');
      console.error('🔥 Error:', syncResult.error);
      console.error('📄 Details:', syncResult.details);

      return res.status(500).json({
        status: 'error',
        message: 'Blockchain sync failed',
        data: {
          error: syncResult.error,
          details: syncResult.details,
          partial_results: syncResult.partialResults || null,
          last_sync_attempt: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('❌ Critical error in blockchain sync:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error during blockchain sync',
      error: error.message
    });
  }
}

// Main blockchain sync function
async function performBlockchainSync(limit, forceResync) {
  const startTime = Date.now();
  
  try {
    console.log('🔍 ============ FETCHING TICKETS FOR SYNC ============');

    // Get tickets that have blockchain token IDs
    let query = supabase
      .from('tickets')
      .select(`
        ticket_id,
        nft_token_id,
        ticket_status,
        blockchain_registered,
        nft_mint_status,
        blockchain_tx_hash,
        users!inner(id_name),
        events!inner(event_name)
      `)
      .not('nft_token_id', 'is', null)
      .limit(limit)
      .order('purchase_date', { ascending: false });

    // If not forcing resync, only get tickets that haven't been synced recently
    if (!forceResync) {
      // Only sync tickets that were last synced more than 1 hour ago or never synced
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      query = query.or(`last_blockchain_sync.is.null,last_blockchain_sync.lt.${oneHourAgo}`);
    }

    const { data: tickets, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch tickets: ${fetchError.message}`);
    }

    if (!tickets || tickets.length === 0) {
      console.log('ℹ️ No tickets found that need syncing');
      return {
        success: true,
        totalChecked: 0,
        updatedCount: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        discrepanciesFound: 0,
        duration: Date.now() - startTime,
        details: 'No tickets required syncing'
      };
    }

    console.log(`📋 Found ${tickets.length} tickets to sync`);

    // Initialize blockchain connection
    console.log('🔗 ============ CONNECTING TO BLOCKCHAIN ============');
    const ethersModule = await import('ethers');
    const ethers = ethersModule.default || ethersModule;

    const provider = new ethers.providers.JsonRpcProvider(BLOCKCHAIN_CONFIG.rpcUrl);
    const wallet = new ethers.Wallet(BLOCKCHAIN_CONFIG.privateKey, provider);
    const contract = new ethers.Contract(BLOCKCHAIN_CONFIG.contractAddress, CONTRACT_ABI, wallet);

    console.log('✅ Blockchain connection established');
    console.log('   👛 Wallet:', wallet.address);
    console.log('   📋 Contract:', BLOCKCHAIN_CONFIG.contractAddress);

    // Sync each ticket
    console.log('🔄 ============ SYNCING TICKET STATES ============');

    let updatedCount = 0;
    let successfulSyncs = 0;
    let failedSyncs = 0;
    let discrepanciesFound = 0;
    const syncDetails = [];

    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      console.log(`\n🎫 ---- Syncing Ticket ${i + 1}/${tickets.length} ----`);
      console.log(`   🆔 Ticket ID: ${ticket.ticket_id}`);
      console.log(`   🔢 Token ID: ${ticket.nft_token_id}`);
      console.log(`   📊 DB Status: ${ticket.ticket_status}`);
      console.log(`   ⛓️ DB Registered: ${ticket.blockchain_registered}`);

      try {
        // Get blockchain status for this token
        const tokenId = ticket.nft_token_id.toString();
        const blockchainStatus = await contract.getTicketStatus(tokenId);
        const blockchainStatusInt = parseInt(blockchainStatus.toString());

        console.log(`   🔗 Blockchain Status: ${blockchainStatusInt}`);

        // Interpret blockchain status
        let expectedTicketStatus;
        let expectedBlockchainRegistered;
        
        switch (blockchainStatusInt) {
          case 0: // Unregistered
            expectedTicketStatus = ticket.ticket_status; // Keep current status
            expectedBlockchainRegistered = false;
            break;
          case 1: // Registered
            expectedTicketStatus = 'valid';
            expectedBlockchainRegistered = true;
            break;
          case 2: // Revoked
            expectedTicketStatus = 'revoked';
            expectedBlockchainRegistered = true;
            break;
          default:
            console.warn(`   ⚠️ Unknown blockchain status: ${blockchainStatusInt}`);
            expectedTicketStatus = ticket.ticket_status;
            expectedBlockchainRegistered = ticket.blockchain_registered;
        }

        // Check if update is needed
        const needsUpdate = 
          ticket.ticket_status !== expectedTicketStatus ||
          ticket.blockchain_registered !== expectedBlockchainRegistered;

        if (needsUpdate) {
          console.log(`   🔄 Discrepancy found - updating database`);
          console.log(`      📊 Status: ${ticket.ticket_status} → ${expectedTicketStatus}`);
          console.log(`      ⛓️ Registered: ${ticket.blockchain_registered} → ${expectedBlockchainRegistered}`);

          // Update the ticket in database
          const { error: updateError } = await supabase
            .from('tickets')
            .update({
              ticket_status: expectedTicketStatus,
              blockchain_registered: expectedBlockchainRegistered,
              nft_mint_status: blockchainStatusInt > 0 ? 'minted' : ticket.nft_mint_status,
              last_blockchain_sync: new Date().toISOString(),
              blockchain_sync_status: blockchainStatusInt
            })
            .eq('ticket_id', ticket.ticket_id);

          if (updateError) {
            console.error(`   ❌ Failed to update ticket: ${updateError.message}`);
            failedSyncs++;
            syncDetails.push({
              ticket_id: ticket.ticket_id,
              token_id: ticket.nft_token_id,
              status: 'failed',
              error: updateError.message
            });
          } else {
            console.log(`   ✅ Ticket updated successfully`);
            updatedCount++;
            successfulSyncs++;
            discrepanciesFound++;
            syncDetails.push({
              ticket_id: ticket.ticket_id,
              token_id: ticket.nft_token_id,
              status: 'updated',
              old_status: ticket.ticket_status,
              new_status: expectedTicketStatus,
              blockchain_status: blockchainStatusInt
            });
          }

        } else {
          console.log(`   ✅ Ticket already in sync`);
          
          // Just update the last sync timestamp
          await supabase
            .from('tickets')
            .update({
              last_blockchain_sync: new Date().toISOString(),
              blockchain_sync_status: blockchainStatusInt
            })
            .eq('ticket_id', ticket.ticket_id);

          successfulSyncs++;
          syncDetails.push({
            ticket_id: ticket.ticket_id,
            token_id: ticket.nft_token_id,
            status: 'in_sync',
            blockchain_status: blockchainStatusInt
          });
        }

        // Add small delay to avoid rate limiting
        if (i < tickets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }

      } catch (error) {
        console.error(`   ❌ Failed to sync ticket ${ticket.ticket_id}:`, error.message);
        failedSyncs++;
        syncDetails.push({
          ticket_id: ticket.ticket_id,
          token_id: ticket.nft_token_id,
          status: 'failed',
          error: error.message
        });

        // Continue with next ticket even if this one fails
        continue;
      }
    }

    const duration = Date.now() - startTime;

    console.log('✅ ============ SYNC OPERATION COMPLETED ============');
    console.log(`📊 Final summary:`);
    console.log(`   🎫 Total tickets processed: ${tickets.length}`);
    console.log(`   🔄 Database updates made: ${updatedCount}`);
    console.log(`   ✅ Successful syncs: ${successfulSyncs}`);
    console.log(`   ❌ Failed syncs: ${failedSyncs}`);
    console.log(`   🔍 Discrepancies found: ${discrepanciesFound}`);
    console.log(`   ⏱️ Total duration: ${duration}ms`);

    return {
      success: true,
      totalChecked: tickets.length,
      updatedCount: updatedCount,
      successfulSyncs: successfulSyncs,
      failedSyncs: failedSyncs,
      discrepanciesFound: discrepanciesFound,
      duration: duration,
      details: `Processed ${tickets.length} tickets, found ${discrepanciesFound} discrepancies`,
      syncDetails: syncDetails
    };

  } catch (error) {
    console.error('🔥 ============ SYNC OPERATION FAILED ============');
    console.error('❌ Error message:', error.message);
    console.error('📊 Error stack:', error.stack);

    return {
      success: false,
      error: error.message,
      details: 'Blockchain sync operation failed',
      duration: Date.now() - startTime
    };
  }
}