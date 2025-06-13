import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Blockchain configuration
const BLOCKCHAIN_CONFIG = {
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://sepolia.infura.io/v3/' + process.env.INFURA_PROJECT_ID,
    contractAddress: process.env.REVOCATION_CONTRACT_ADDRESS || '0x86d22947cE0D2908eC0CAC78f7EC405f15cB9e50',
    privateKey: process.env.ADMIN_PRIVATE_KEY,
    network: 'sepolia'
};

// Contract ABI for revocation
const CONTRACT_ABI = [
    "function revokeTicket(uint256 tokenId) external",
    "function batchRevokeTickets(uint256[] calldata tokenIds) external",
    "function getTicketStatus(uint256 tokenId) external view returns (uint8)",
    "function isRevoked(uint256 tokenId) external view returns (bool)"
];

export default async function handler(req, res) {
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

        // 🆕 Look up admin's user_id in the users table
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
        const { 
            purchase_ids, 
            reason = 'Bot activity detected - rapid purchases',
        } = req.body;

        if (!purchase_ids || !Array.isArray(purchase_ids) || purchase_ids.length === 0) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'purchase_ids array is required and cannot be empty' 
            });
        }
        const admin_id = adminUser.user_id;

        console.log('🔨 ============ REVOKING FLAGGED TICKETS ============');
        console.log('📋 Purchase IDs to revoke:', purchase_ids);
        console.log('📝 Reason:', reason);
        console.log('👮 Admin ID:', admin_id);

        // Get purchase details with payment info
        const { data: purchases, error: fetchError } = await supabase
            .from('purchase_history')
            .select(`
                *,
                payments!inner(payment_id, user_id, amount),
                users!inner(user_id, id_name),
                events!inner(event_id, event_name)
            `)
            .in('id', purchase_ids);

        if (fetchError || !purchases || purchases.length === 0) {
            console.error('❌ Failed to retrieve purchase details:', fetchError);
            return res.status(400).json({ 
                status: 'error', 
                message: 'Failed to retrieve purchase details or no purchases found' 
            });
        }

        console.log(`📋 Found ${purchases.length} purchases to process`);

        // Get all tickets associated with these payments
        const paymentIds = purchases.map(p => p.payments.payment_id);
        console.log('💳 Associated payment IDs:', paymentIds);

        const { data: ticketsToRevoke, error: ticketsError } = await supabase
            .from('tickets')
            .select('*')
            .in('payment_id', paymentIds)
            .eq('ticket_status', 'valid'); // Only revoke valid tickets

        if (ticketsError) {
            console.error('❌ Failed to retrieve tickets:', ticketsError);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to retrieve tickets for revocation' 
            });
        }

        console.log(`🎫 Found ${ticketsToRevoke?.length || 0} tickets to revoke`);

        if (!ticketsToRevoke || ticketsToRevoke.length === 0) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'No valid tickets found for the specified purchases' 
            });
        }

        // 1. REVOKE TICKETS IN DATABASE
        console.log('💾 ============ DATABASE REVOCATION ============');
        const ticketIdsToRevoke = ticketsToRevoke.map(t => t.ticket_id);
        
        const { data: revokedTickets, error: revokeError } = await supabase
            .from('tickets')
            .update({ ticket_status: 'revoked' })
            .in('ticket_id', ticketIdsToRevoke)
            .select();

        if (revokeError) {
            console.error('❌ Error revoking tickets:', revokeError);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to revoke tickets in database',
                error: revokeError.message
            });
        }

        console.log(`✅ Successfully revoked ${revokedTickets?.length || 0} tickets in database`);

        // 2. UPDATE PURCHASE HISTORY STATUS
        const { error: updateError } = await supabase
            .from('purchase_history')
            .update({ status: 'revoked' })
            .in('id', purchase_ids);

        if (updateError) {
            console.error('⚠️ Warning: Failed to update purchase history status:', updateError);
        } else {
            console.log('✅ Updated purchase history status to revoked');
        }

        // 3. CREATE REVOCATION LOG ENTRIES
        console.log('📝 ============ CREATING REVOCATION LOGS ============');
        const revocationLogs = revokedTickets.map(ticket => ({
            ticket_id: ticket.ticket_id,
            admin_id: admin_id,
            reason: reason,
            revoked_at: new Date().toISOString(),
            blockchain_status: 'pending',
            blockchain_tx_hash: null,
            blockchain_error: null
        }));

        const { data: insertedLogs, error: logError } = await supabase
            .from('revocation_log')
            .insert(revocationLogs)
            .select('id, ticket_id');

        if (logError) {
            console.error('❌ Failed to create revocation logs:', logError);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Failed to create revocation audit logs' 
            });
        }

        console.log(`📝 Created ${insertedLogs.length} revocation log entries`);

        // 4. IMMEDIATE BLOCKCHAIN REVOCATION
        console.log('⛓️ ============ BLOCKCHAIN REVOCATION ============');
        
        // Filter tickets that need blockchain revocation
        const blockchainTickets = revokedTickets.filter(ticket => {
            console.log(`🔍 Checking ticket ${ticket.ticket_id}:`);
            console.log(`   ⛓️ blockchain_registered: ${ticket.blockchain_registered}`);
            console.log(`   🎫 nft_token_id: ${ticket.nft_token_id} (type: ${typeof ticket.nft_token_id})`);
            console.log(`   📝 Raw value: "${ticket.nft_token_id}"`);
            
            // Check if blockchain_registered is true
            const isRegistered = ticket.blockchain_registered === true;
            
            // Check if nft_token_id exists (handles 0, "0", and other values)
            const hasTokenId = ticket.nft_token_id !== null && 
                            ticket.nft_token_id !== undefined && 
                            ticket.nft_token_id !== '' &&
                            String(ticket.nft_token_id).trim() !== '';
            
            console.log(`   ✅ Is registered: ${isRegistered}`);
            console.log(`   🎯 Has token ID: ${hasTokenId}`);
            console.log(`   🔄 Will include: ${isRegistered && hasTokenId}`);
            
            return isRegistered && hasTokenId;
        });

        let blockchainResults = {
            attempted: blockchainTickets.length,
            successful: 0,
            failed: 0,
            transaction_hash: null,
            gas_used: null,
            errors: []
        };

        if (blockchainTickets.length > 0) {
            console.log(`🔗 Attempting to revoke ${blockchainTickets.length} tickets on blockchain...`);
            
            try {
                // 🚀 FIXED: Improved token ID cleaning that handles all edge cases
                const tokenIds = blockchainTickets.map(t => {
                    const rawTokenId = t.nft_token_id;
                    console.log(`🧹 Processing token ID: ${rawTokenId} (type: ${typeof rawTokenId})`);
                    
                    // Convert to string and clean
                    let tokenId = String(rawTokenId).trim();
                    
                    // Remove any non-numeric characters (just in case)
                    tokenId = tokenId.replace(/[^0-9]/g, '');
                    
                    // Validate it's a valid number
                    if (!/^\d+$/.test(tokenId)) {
                        throw new Error(`Invalid token ID format: ${rawTokenId} -> ${tokenId}`);
                    }
                    
                    console.log(`✅ Clean token ID: ${tokenId}`);
                    return tokenId;
                });
                
                console.log('🎫 Final token IDs to revoke:', tokenIds);
                
                const blockchainResult = await revokeTicketsOnBlockchain(tokenIds);
                
                if (blockchainResult.success) {
                    blockchainResults.successful = blockchainTickets.length;
                    blockchainResults.transaction_hash = blockchainResult.transactionHash;
                    blockchainResults.gas_used = blockchainResult.gasUsed;
                    
                    console.log(`✅ Successfully revoked ${blockchainTickets.length} tickets on blockchain`);
                    console.log(`   🔗 Transaction Hash: ${blockchainResult.transactionHash}`);
                    console.log(`   ⛽ Gas Used: ${blockchainResult.gasUsed}`);
                    
                    // Update revocation logs with blockchain success
                    const blockchainTicketIds = blockchainTickets.map(t => t.ticket_id);
                    await supabase
                        .from('revocation_log')
                        .update({ 
                            blockchain_status: 'completed',
                            blockchain_tx_hash: blockchainResult.transactionHash
                        })
                        .in('ticket_id', blockchainTicketIds);
                        
                    // Update tickets with blockchain transaction hash
                    await supabase
                        .from('tickets')
                        .update({ 
                            blockchain_tx_hash: blockchainResult.transactionHash 
                        })
                        .in('ticket_id', blockchainTicketIds);
                        
                } else {
                    blockchainResults.failed = blockchainTickets.length;
                    blockchainResults.errors.push(blockchainResult.error);
                    
                    console.error(`❌ Failed to revoke tickets on blockchain: ${blockchainResult.error}`);
                    
                    // Update revocation logs with blockchain failure
                    const blockchainTicketIds = blockchainTickets.map(t => t.ticket_id);
                    await supabase
                        .from('revocation_log')
                        .update({ 
                            blockchain_status: 'failed',
                            blockchain_error: blockchainResult.error
                        })
                        .in('ticket_id', blockchainTicketIds);
                }
                
            } catch (error) {
                blockchainResults.failed = blockchainTickets.length;
                blockchainResults.errors.push(error.message);
                
                console.error(`❌ Blockchain revocation exception: ${error.message}`);
                
                // Update revocation logs with error
                const blockchainTicketIds = blockchainTickets.map(t => t.ticket_id);
                await supabase
                    .from('revocation_log')
                    .update({ 
                        blockchain_status: 'failed',
                        blockchain_error: error.message
                    })
                    .in('ticket_id', blockchainTicketIds);
            }
        } else {
            console.log('ℹ️ No blockchain-registered tickets found for revocation');
            
            // 🚀 ADDED: Debug information to help identify the issue
            console.log('🔍 ============ DEBUGGING INFO ============');
            console.log(`📊 Total tickets to revoke: ${revokedTickets.length}`);
            revokedTickets.forEach((ticket, index) => {
                console.log(`🎫 Ticket ${index + 1}:`);
                console.log(`   🆔 ID: ${ticket.ticket_id}`);
                console.log(`   ⛓️ Blockchain registered: ${ticket.blockchain_registered}`);
                console.log(`   🎯 NFT token ID: ${ticket.nft_token_id} (type: ${typeof ticket.nft_token_id})`);
                console.log(`   📝 Raw: "${ticket.nft_token_id}"`);
                console.log(`   ✅ Passes filter: ${ticket.blockchain_registered && ticket.nft_token_id !== null && ticket.nft_token_id !== undefined && ticket.nft_token_id !== '' && String(ticket.nft_token_id).trim() !== ''}`);
            });
        }

        console.log('🎉 ============ REVOCATION COMPLETE ============');
        console.log(`📊 Summary:`);
        console.log(`   🎫 Total tickets revoked: ${revokedTickets.length}`);
        console.log(`   📝 Revocation logs created: ${insertedLogs.length}`);
        console.log(`   ⛓️ Blockchain attempts: ${blockchainResults.attempted}`);
        console.log(`   ✅ Blockchain successful: ${blockchainResults.successful}`);
        console.log(`   ❌ Blockchain failed: ${blockchainResults.failed}`);

        const isPartialSuccess = blockchainResults.failed > 0 && blockchainResults.successful > 0;
        const responseStatus = blockchainResults.failed === 0 ? 'success' : 
                              blockchainResults.successful === 0 ? 'partial_success' : 'partial_success';

        return res.status(200).json({
            status: responseStatus,
            message: `Successfully revoked ${revokedTickets.length} tickets from ${purchases.length} flagged purchases`,
            data: {
                revoked_tickets_count: revokedTickets.length,
                revoked_purchases_count: purchase_ids.length,
                revocation_logs_created: insertedLogs.length,
                blockchain_revocation: blockchainResults,
                revoked_ticket_ids: revokedTickets.map(t => t.ticket_id),
                affected_users: [...new Set(purchases.map(p => p.users.id_name))],
                total_amount_affected: purchases.reduce((sum, p) => sum + parseFloat(p.payments.amount), 0)
            },
            warnings: blockchainResults.errors.length > 0 ? [
                `Blockchain revocation failed for ${blockchainResults.failed} tickets: ${blockchainResults.errors.join(', ')}`
            ] : []
        });

    } catch (error) {
        console.error('❌ Error revoking tickets:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error during revocation',
            error: error.message
        });
    }
}

// Blockchain revocation function
async function revokeTicketsOnBlockchain(tokenIds) {
    try {
        console.log('🔗 ============ BLOCKCHAIN CONNECTION ============');
        
        const ethersModule = await import('ethers');
        const ethers = ethersModule.default || ethersModule;
        
        if (!BLOCKCHAIN_CONFIG.privateKey || !BLOCKCHAIN_CONFIG.rpcUrl) {
            throw new Error('Blockchain configuration missing: privateKey or rpcUrl');
        }

        console.log('🌐 Connecting to blockchain...');
        console.log('   🌐 RPC URL:', BLOCKCHAIN_CONFIG.rpcUrl);
        console.log('   📋 Contract:', BLOCKCHAIN_CONFIG.contractAddress);
        console.log(`   🎫 Tokens to revoke: [${tokenIds.join(', ')}]`);
        
        const provider = new ethers.providers.JsonRpcProvider(BLOCKCHAIN_CONFIG.rpcUrl);
        const wallet = new ethers.Wallet(BLOCKCHAIN_CONFIG.privateKey, provider);
        const contract = new ethers.Contract(BLOCKCHAIN_CONFIG.contractAddress, CONTRACT_ABI, wallet);
        
        console.log('👛 Wallet Address:', wallet.address);
        
        // Check wallet balance
        const balance = await wallet.getBalance();
        const balanceEth = ethers.utils.formatEther(balance);
        console.log(`💰 Wallet balance: ${balanceEth} ETH`);
        
        if (balance.lt(ethers.utils.parseEther('0.001'))) {
            throw new Error(`Insufficient gas: ${balanceEth} ETH (minimum 0.001 ETH required)`);
        }
        
        // Execute revocation transaction
        console.log('📝 Preparing revocation transaction...');
        let transaction;
        
        if (tokenIds.length === 1) {
            console.log(`📝 Using single revocation for token: ${tokenIds[0]}`);
            transaction = await contract.revokeTicket(tokenIds[0]);
        } else {
            console.log(`📝 Using batch revocation for ${tokenIds.length} tokens`);
            transaction = await contract.batchRevokeTickets(tokenIds);
        }
        
        console.log(`⏳ Transaction sent: ${transaction.hash}`);
        console.log('⏱️ Waiting for confirmation...');
        
        // Wait for confirmation with timeout
        const receipt = await Promise.race([
            transaction.wait(2), // Wait for 2 confirmations
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Transaction timeout after 3 minutes')), 180000)
            )
        ]);
        
        console.log('✅ ============ BLOCKCHAIN SUCCESS ============');
        console.log('🔗 Transaction Hash:', receipt.transactionHash);
        console.log('📦 Block Number:', receipt.blockNumber);
        console.log('⛽ Gas Used:', receipt.gasUsed.toString());
        console.log('🔴 Status:', receipt.status === 1 ? 'SUCCESS' : 'FAILED');
        
        if (receipt.status !== 1) {
            throw new Error('Transaction failed on blockchain');
        }
        
        // Verify revocation for first ticket
        console.log('🔍 Verifying revocation...');
        const firstTokenStatus = await contract.getTicketStatus(tokenIds[0]);
        console.log('📊 First token status after revocation:', firstTokenStatus.toString());
        
        if (firstTokenStatus.toString() !== '2') { // 2 = REVOKED
            console.error('⚠️ Warning: Token status verification failed');
            console.error('   📊 Expected: 2 (REVOKED)');
            console.error('   📊 Actual:', firstTokenStatus.toString());
        } else {
            console.log('✅ Revocation verified successfully');
        }
        
        return {
            success: true,
            transactionHash: transaction.hash,
            gasUsed: receipt.gasUsed.toString(),
            blockNumber: receipt.blockNumber,
            tokensRevoked: tokenIds.length
        };
        
    } catch (error) {
        console.error('🔥 ============ BLOCKCHAIN FAILURE ============');
        console.error('❌ Error message:', error.message);
        console.error('📊 Error type:', error.code || 'Unknown');
        
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}