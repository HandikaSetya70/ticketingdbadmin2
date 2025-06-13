// /api/admin/verify-all-tokens.js
// Batch verify all tokens against blockchain and generate verification report

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

// Contract ABI for verification operations
const CONTRACT_ABI = [
  "function getTicketStatus(uint256 tokenId) external view returns (uint8)",
  "function isRevoked(uint256 tokenId) external view returns (bool)",
  "function owner() external view returns (address)",
  "function balanceOf(address owner) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)"
];

export default async function handler(req, res) {
  console.log('🔍 ============ TOKEN VERIFICATION STARTED ============');
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
      limit = 200,                    // How many tokens to verify at once
      verification_type = 'all',      // 'all', 'registered_only', 'flagged_only'
      include_detailed_report = true, // Include per-token verification details
      check_contract_state = true     // Also verify contract-level information
    } = req.body || {};

    console.log('📋 Verification parameters:');
    console.log('   📊 Limit:', limit);
    console.log('   🎯 Type:', verification_type);
    console.log('   📄 Detailed report:', include_detailed_report);
    console.log('   📋 Check contract:', check_contract_state);

    // Start the token verification process
    const verificationResult = await performTokenVerification(
      limit, 
      verification_type, 
      include_detailed_report, 
      check_contract_state
    );

    if (verificationResult.success) {
      console.log('✅ ============ TOKEN VERIFICATION SUCCESSFUL ============');
      console.log('📊 Verification summary:');
      console.log('   🎫 Total tokens checked:', verificationResult.totalChecked);
      console.log('   ✅ Valid tokens:', verificationResult.validTokens);
      console.log('   ❌ Invalid tokens:', verificationResult.invalidTokens);
      console.log('   🔄 Revoked tokens:', verificationResult.revokedTokens);
      console.log('   ⚠️ Inconsistencies found:', verificationResult.inconsistencies);
      console.log('   ⏱️ Verification duration:', verificationResult.duration + 'ms');

      return res.status(200).json({
        status: 'success',
        message: `Token verification completed. Checked ${verificationResult.totalChecked} tokens.`,
        data: {
          total_checked: verificationResult.totalChecked,
          valid_tokens: verificationResult.validTokens,
          invalid_tokens: verificationResult.invalidTokens,
          revoked_tokens: verificationResult.revokedTokens,
          unregistered_tokens: verificationResult.unregisteredTokens,
          inconsistencies_found: verificationResult.inconsistencies,
          verification_duration_ms: verificationResult.duration,
          contract_info: verificationResult.contractInfo,
          verification_report: include_detailed_report ? verificationResult.detailedReport : null,
          summary_stats: verificationResult.summaryStats,
          last_verification: new Date().toISOString()
        }
      });

    } else {
      console.error('❌ ============ TOKEN VERIFICATION FAILED ============');
      console.error('🔥 Error:', verificationResult.error);
      console.error('📄 Details:', verificationResult.details);

      return res.status(500).json({
        status: 'error',
        message: 'Token verification failed',
        data: {
          error: verificationResult.error,
          details: verificationResult.details,
          partial_results: verificationResult.partialResults || null,
          last_verification_attempt: new Date().toISOString()
        }
      });
    }

  } catch (error) {
    console.error('❌ Critical error in token verification:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Internal server error during token verification',
      error: error.message
    });
  }
}

// Main token verification function
async function performTokenVerification(limit, verificationType, includeDetailedReport, checkContractState) {
  const startTime = Date.now();
  
  try {
    console.log('🔍 ============ FETCHING TOKENS FOR VERIFICATION ============');

    // Build query based on verification type
    let query = supabase
      .from('tickets')
      .select(`
        ticket_id,
        nft_token_id,
        ticket_status,
        blockchain_registered,
        nft_mint_status,
        blockchain_tx_hash,
        blockchain_sync_status,
        last_blockchain_sync,
        users!inner(id_name, id_number),
        events!inner(event_name, event_date)
      `)
      .not('nft_token_id', 'is', null)
      .limit(limit)
      .order('purchase_date', { ascending: false });

    // Apply verification type filters
    switch (verificationType) {
      case 'registered_only':
        query = query.eq('blockchain_registered', true);
        break;
      case 'flagged_only':
        // Get tickets that might have inconsistencies
        query = query.or('blockchain_registered.eq.false,nft_mint_status.eq.failed');
        break;
      case 'all':
      default:
        // No additional filter - check all tokens with IDs
        break;
    }

    const { data: tickets, error: fetchError } = await query;

    if (fetchError) {
      throw new Error(`Failed to fetch tickets: ${fetchError.message}`);
    }

    if (!tickets || tickets.length === 0) {
      console.log('ℹ️ No tokens found for verification');
      return {
        success: true,
        totalChecked: 0,
        validTokens: 0,
        invalidTokens: 0,
        revokedTokens: 0,
        unregisteredTokens: 0,
        inconsistencies: 0,
        duration: Date.now() - startTime,
        contractInfo: null,
        detailedReport: [],
        summaryStats: {}
      };
    }

    console.log(`📋 Found ${tickets.length} tokens to verify`);

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

    // Get contract-level information if requested
    let contractInfo = null;
    if (checkContractState) {
      console.log('📋 ============ GATHERING CONTRACT INFO ============');
      try {
        contractInfo = {
          owner: await contract.owner(),
          network: BLOCKCHAIN_CONFIG.network,
          contract_address: BLOCKCHAIN_CONFIG.contractAddress,
          current_block: await provider.getBlockNumber(),
          gas_price_gwei: ethers.utils.formatUnits(await provider.getGasPrice(), 'gwei')
        };
        console.log('✅ Contract info gathered');
        console.log('   👑 Owner:', contractInfo.owner);
        console.log('   📦 Block:', contractInfo.current_block);
        console.log('   ⛽ Gas Price:', contractInfo.gas_price_gwei, 'Gwei');
      } catch (error) {
        console.warn('⚠️ Failed to gather contract info:', error.message);
        contractInfo = { error: error.message };
      }
    }

    // Verify each token
    console.log('🔍 ============ VERIFYING TOKEN STATES ============');

    let validTokens = 0;
    let invalidTokens = 0;
    let revokedTokens = 0;
    let unregisteredTokens = 0;
    let inconsistencies = 0;
    const detailedReport = [];
    const verificationErrors = [];

    // Process tokens in batches to avoid overwhelming the RPC
    const batchSize = 10;
    for (let i = 0; i < tickets.length; i += batchSize) {
      const batch = tickets.slice(i, Math.min(i + batchSize, tickets.length));
      console.log(`\n📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(tickets.length/batchSize)} (${batch.length} tokens)`);

      // Process batch with Promise.all for parallel verification
      const batchPromises = batch.map(async (ticket, batchIndex) => {
        const globalIndex = i + batchIndex + 1;
        console.log(`🎫 Verifying token ${globalIndex}/${tickets.length}: ${ticket.nft_token_id}`);

        try {
          const tokenId = ticket.nft_token_id.toString();
          const startTokenTime = Date.now();

          // Get blockchain status
          const [blockchainStatus, isRevoked] = await Promise.all([
            contract.getTicketStatus(tokenId),
            contract.isRevoked(tokenId)
          ]);

          const blockchainStatusInt = parseInt(blockchainStatus.toString());
          const tokenVerificationTime = Date.now() - startTokenTime;

          console.log(`   🔗 Blockchain status: ${blockchainStatusInt} (revoked: ${isRevoked})`);
          console.log(`   💾 Database status: ${ticket.ticket_status} (registered: ${ticket.blockchain_registered})`);

          // Analyze verification results
          const verification = analyzeTokenVerification(ticket, blockchainStatusInt, isRevoked);
          verification.verification_time_ms = tokenVerificationTime;

          // Update counters
          switch (blockchainStatusInt) {
            case 0:
              unregisteredTokens++;
              break;
            case 1:
              validTokens++;
              break;
            case 2:
              revokedTokens++;
              break;
            default:
              invalidTokens++;
          }

          if (verification.has_inconsistency) {
            inconsistencies++;
            console.log(`   ⚠️ Inconsistency detected: ${verification.inconsistency_reason}`);
          } else {
            console.log(`   ✅ Verification passed`);
          }

          if (includeDetailedReport) {
            detailedReport.push(verification);
          }

          return verification;

        } catch (error) {
          console.error(`   ❌ Verification failed for token ${ticket.nft_token_id}:`, error.message);
          invalidTokens++;
          verificationErrors.push({
            ticket_id: ticket.ticket_id,
            token_id: ticket.nft_token_id,
            error: error.message
          });

          if (includeDetailedReport) {
            detailedReport.push({
              ticket_id: ticket.ticket_id,
              token_id: ticket.nft_token_id,
              user_name: ticket.users.id_name,
              event_name: ticket.events.event_name,
              verification_status: 'failed',
              error: error.message,
              has_inconsistency: true,
              inconsistency_reason: `Verification failed: ${error.message}`
            });
          }

          return null;
        }
      });

      // Wait for batch to complete
      await Promise.all(batchPromises);

      // Add delay between batches to be nice to the RPC
      if (i + batchSize < tickets.length) {
        console.log('⏸️ Waiting 1 second before next batch...');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Generate summary statistics
    const summaryStats = {
      total_tokens: tickets.length,
      valid_percentage: ((validTokens / tickets.length) * 100).toFixed(2),
      revoked_percentage: ((revokedTokens / tickets.length) * 100).toFixed(2),
      unregistered_percentage: ((unregisteredTokens / tickets.length) * 100).toFixed(2),
      inconsistency_percentage: ((inconsistencies / tickets.length) * 100).toFixed(2),
      verification_errors: verificationErrors.length,
      average_verification_time_ms: includeDetailedReport ? 
        (detailedReport.reduce((sum, r) => sum + (r.verification_time_ms || 0), 0) / detailedReport.length).toFixed(2) : 
        null
    };

    const duration = Date.now() - startTime;

    console.log('✅ ============ VERIFICATION COMPLETED ============');
    console.log(`📊 Final verification summary:`);
    console.log(`   🎫 Total tokens verified: ${tickets.length}`);
    console.log(`   ✅ Valid (status 1): ${validTokens} (${summaryStats.valid_percentage}%)`);
    console.log(`   ❌ Revoked (status 2): ${revokedTokens} (${summaryStats.revoked_percentage}%)`);
    console.log(`   ⚪ Unregistered (status 0): ${unregisteredTokens} (${summaryStats.unregistered_percentage}%)`);
    console.log(`   🔄 Verification errors: ${verificationErrors.length}`);
    console.log(`   ⚠️ Inconsistencies: ${inconsistencies} (${summaryStats.inconsistency_percentage}%)`);
    console.log(`   ⏱️ Total duration: ${duration}ms`);

    return {
      success: true,
      totalChecked: tickets.length,
      validTokens: validTokens,
      invalidTokens: verificationErrors.length,
      revokedTokens: revokedTokens,
      unregisteredTokens: unregisteredTokens,
      inconsistencies: inconsistencies,
      duration: duration,
      contractInfo: contractInfo,
      detailedReport: detailedReport,
      summaryStats: summaryStats,
      verificationErrors: verificationErrors
    };

  } catch (error) {
    console.error('🔥 ============ VERIFICATION FAILED ============');
    console.error('❌ Error message:', error.message);
    console.error('📊 Error stack:', error.stack);

    return {
      success: false,
      error: error.message,
      details: 'Token verification operation failed',
      duration: Date.now() - startTime
    };
  }
}

// Analyze individual token verification results
function analyzeTokenVerification(ticket, blockchainStatus, isRevoked) {
  const result = {
    ticket_id: ticket.ticket_id,
    token_id: ticket.nft_token_id,
    user_name: ticket.users.id_name,
    user_id_number: ticket.users.id_number,
    event_name: ticket.events.event_name,
    event_date: ticket.events.event_date,
    
    // Database state
    db_ticket_status: ticket.ticket_status,
    db_blockchain_registered: ticket.blockchain_registered,
    db_mint_status: ticket.nft_mint_status,
    db_last_sync: ticket.last_blockchain_sync,
    
    // Blockchain state
    blockchain_status: blockchainStatus,
    blockchain_is_revoked: isRevoked,
    blockchain_status_text: getStatusText(blockchainStatus),
    
    // Verification results
    verification_status: 'verified',
    has_inconsistency: false,
    inconsistency_reason: null,
    recommended_action: null
  };

  // Check for inconsistencies
  const inconsistencies = [];

  // Check status consistency
  if (blockchainStatus === 0 && ticket.blockchain_registered === true) {
    inconsistencies.push('Token marked as registered in DB but unregistered on blockchain');
  }
  
  if (blockchainStatus === 1 && ticket.ticket_status !== 'valid') {
    inconsistencies.push('Token registered on blockchain but not marked as valid in DB');
  }
  
  if (blockchainStatus === 2 && ticket.ticket_status !== 'revoked') {
    inconsistencies.push('Token revoked on blockchain but not marked as revoked in DB');
  }

  if (isRevoked && ticket.ticket_status === 'valid') {
    inconsistencies.push('Token is revoked on blockchain but marked as valid in DB');
  }

  if (ticket.blockchain_registered === false && blockchainStatus > 0) {
    inconsistencies.push('Token exists on blockchain but not marked as registered in DB');
  }

  // Set inconsistency status
  if (inconsistencies.length > 0) {
    result.has_inconsistency = true;
    result.inconsistency_reason = inconsistencies.join('; ');
    result.recommended_action = 'Run blockchain sync to fix inconsistencies';
  }

  return result;
}

// Helper function to get human-readable status text
function getStatusText(status) {
  switch (status) {
    case 0: return 'Unregistered';
    case 1: return 'Registered';
    case 2: return 'Revoked';
    default: return `Unknown (${status})`;
  }
}