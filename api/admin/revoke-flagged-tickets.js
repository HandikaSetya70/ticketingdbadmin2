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
        const blockchainTickets = revokedTickets.filter(ticket => 
            ticket.blockchain_registered && ticket.nft_token_id
        );

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
                const tokenIds = blockchainTickets.map(t => t.nft_token_id);
                console.log('🎫 Token IDs to revoke:', tokenIds);
                
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


async function revokeTicketsOnBlockchain(tokenIds) {
    try {
        console.log('🔗 ============ BLOCKCHAIN CONNECTION ============');
        
        // Use Web3.js instead of ethers
        const Web3 = (await import('web3')).default;
        
        if (!BLOCKCHAIN_CONFIG.privateKey || !BLOCKCHAIN_CONFIG.rpcUrl) {
            throw new Error('Blockchain configuration missing: privateKey or rpcUrl');
        }

        console.log('🌐 Connecting to blockchain...');
        console.log('   🌐 RPC URL:', BLOCKCHAIN_CONFIG.rpcUrl);
        console.log('   📋 Contract:', BLOCKCHAIN_CONFIG.contractAddress);
        console.log(`   🎫 Tokens to revoke: [${tokenIds.join(', ')}]`);
        
        // Initialize Web3 and account
        const web3 = new Web3(BLOCKCHAIN_CONFIG.rpcUrl);
        const account = web3.eth.accounts.privateKeyToAccount(BLOCKCHAIN_CONFIG.privateKey);
        web3.eth.accounts.wallet.add(account);
        
        console.log('👛 Wallet Address:', account.address);
        
        // Check wallet balance
        const balance = await web3.eth.getBalance(account.address);
        const balanceEth = web3.utils.fromWei(balance, 'ether');
        console.log(`💰 Wallet balance: ${balanceEth} ETH`);
        
        if (parseFloat(balanceEth) < 0.001) {
            throw new Error(`Insufficient gas: ${balanceEth} ETH (minimum 0.001 ETH required)`);
        }
        
        // Create contract instance
        const CONTRACT_ABI_WEB3 = [
            {
                "inputs": [{"internalType": "uint256", "name": "tokenId", "type": "uint256"}],
                "name": "revokeTicket",
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [{"internalType": "uint256[]", "name": "tokenIds", "type": "uint256[]"}],
                "name": "batchRevokeTickets", 
                "outputs": [],
                "stateMutability": "nonpayable",
                "type": "function"
            },
            {
                "inputs": [{"internalType": "uint256", "name": "tokenId", "type": "uint256"}],
                "name": "getTicketStatus",
                "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}],
                "stateMutability": "view",
                "type": "function"
            }
        ];
        
        const contract = new web3.eth.Contract(CONTRACT_ABI_WEB3, BLOCKCHAIN_CONFIG.contractAddress);
        
        // Prepare transaction
        console.log('📝 Preparing revocation transaction...');
        let method;
        
        if (tokenIds.length === 1) {
            console.log(`📝 Using single revocation for token: ${tokenIds[0]}`);
            method = contract.methods.revokeTicket(tokenIds[0]);
        } else {
            console.log(`📝 Using batch revocation for ${tokenIds.length} tokens`);
            method = contract.methods.batchRevokeTickets(tokenIds);
        }
        
        // Estimate gas
        const gasEstimate = await method.estimateGas({ from: account.address });
        const gasPrice = await web3.eth.getGasPrice();
        
        console.log(`⛽ Gas estimate: ${gasEstimate}`);
        console.log(`💰 Gas price: ${web3.utils.fromWei(gasPrice, 'gwei')} Gwei`);
        
        // Send transaction
        const transaction = await method.send({
            from: account.address,
            gas: Math.floor(gasEstimate * 1.2), // Add 20% buffer
            gasPrice: gasPrice
        });
        
        console.log('✅ ============ BLOCKCHAIN SUCCESS ============');
        console.log('🔗 Transaction Hash:', transaction.transactionHash);
        console.log('📦 Block Number:', transaction.blockNumber);
        console.log('⛽ Gas Used:', transaction.gasUsed);
        console.log('🔴 Status:', transaction.status ? 'SUCCESS' : 'FAILED');
        
        if (!transaction.status) {
            throw new Error('Transaction failed on blockchain');
        }
        
        // Verify revocation for first ticket
        console.log('🔍 Verifying revocation...');
        const firstTokenStatus = await contract.methods.getTicketStatus(tokenIds[0]).call();
        console.log('📊 First token status after revocation:', firstTokenStatus);
        
        if (firstTokenStatus !== '2') { // 2 = REVOKED
            console.error('⚠️ Warning: Token status verification failed');
            console.error('   📊 Expected: 2 (REVOKED)');
            console.error('   📊 Actual:', firstTokenStatus);
        } else {
            console.log('✅ Revocation verified successfully');
        }
        
        return {
            success: true,
            transactionHash: transaction.transactionHash,
            gasUsed: transaction.gasUsed.toString(),
            blockNumber: transaction.blockNumber,
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