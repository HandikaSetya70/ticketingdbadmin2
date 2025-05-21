// File: workers/blockchain-revocation-worker.js
// Background worker to process the blockchain revocation queue

import { createClient } from '@supabase/supabase-js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Initialize Ethereum provider
const provider = new ethers.providers.JsonRpcProvider(process.env.ETHEREUM_RPC_URL);
const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);

// Simplified ABI for a basic ERC721 contract with a revoke function
const contractABI = [
    "function revoke(uint256 tokenId) external",
    "function isRevoked(uint256 tokenId) external view returns (bool)"
];

async function processRevocationQueue() {
    console.log('Starting blockchain revocation queue processing');

    try {
        // Get pending items from the queue, limit to 10 at a time to avoid timeouts
        const { data: pendingItems, error: fetchError } = await supabase
            .from('blockchain_revocation_queue')
            .select(`
                *,
                tickets (ticket_id, nft_contract_address, nft_token_id),
                revocation_log (id, ticket_id, reason)
            `)
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(10);

        if (fetchError) {
            console.error('Error fetching pending revocations:', fetchError);
            return;
        }

        if (!pendingItems || pendingItems.length === 0) {
            console.log('No pending revocations to process');
            return;
        }

        console.log(`Found ${pendingItems.length} pending revocations`);

        // Process each pending item
        for (const item of pendingItems) {
            try {
                // Mark as processing
                await supabase
                    .from('blockchain_revocation_queue')
                    .update({ status: 'processing' })
                    .eq('id', item.id);

                const ticket = item.tickets;
                
                // Skip if ticket doesn't have blockchain info
                if (!ticket || !ticket.nft_contract_address || !ticket.nft_token_id) {
                    console.warn(`Ticket ${item.ticket_id} missing blockchain info, marking as completed`);
                    
                    await supabase
                        .from('blockchain_revocation_queue')
                        .update({ 
                            status: 'completed',
                            processed_at: new Date().toISOString(),
                            error_message: 'Ticket has no blockchain data'
                        })
                        .eq('id', item.id);
                    
                    await supabase
                        .from('revocation_log')
                        .update({ 
                            blockchain_status: 'not_applicable' 
                        })
                        .eq('id', item.revocation_log_id);
                        
                    continue;
                }

                // Initialize contract instance
                const contract = new ethers.Contract(
                    ticket.nft_contract_address,
                    contractABI,
                    wallet
                );

                // Check if already revoked on chain
                const isAlreadyRevoked = await contract.isRevoked(ticket.nft_token_id);
                
                if (isAlreadyRevoked) {
                    console.log(`Token ${ticket.nft_token_id} already revoked on chain`);
                    
                    // Update queue item
                    await supabase
                        .from('blockchain_revocation_queue')
                        .update({ 
                            status: 'completed',
                            processed_at: new Date().toISOString(),
                            error_message: 'Already revoked on blockchain'
                        })
                        .eq('id', item.id);
                    
                    // Update revocation log
                    await supabase
                        .from('revocation_log')
                        .update({ 
                            blockchain_status: 'confirmed' 
                        })
                        .eq('id', item.revocation_log_id);
                        
                    continue;
                }

                // Call the revoke function on the contract
                console.log(`Revoking token ${ticket.nft_token_id} on contract ${ticket.nft_contract_address}`);
                const tx = await contract.revoke(ticket.nft_token_id);
                
                // Wait for transaction to be mined
                const receipt = await tx.wait();
                
                console.log(`Transaction confirmed: ${receipt.transactionHash}`);
                
                // Update queue item
                await supabase
                    .from('blockchain_revocation_queue')
                    .update({ 
                        status: 'completed',
                        processed_at: new Date().toISOString()
                    })
                    .eq('id', item.id);
                
                // Update revocation log
                await supabase
                    .from('revocation_log')
                    .update({ 
                        blockchain_status: 'confirmed',
                        blockchain_tx_hash: receipt.transactionHash
                    })
                    .eq('id', item.revocation_log_id);

            } catch (processingError) {
                console.error(`Error processing item ${item.id}:`, processingError);
                
                // Increment retry count
                const retryCount = (item.retry_count || 0) + 1;
                const status = retryCount >= 3 ? 'failed' : 'pending';
                
                // Update queue item
                await supabase
                    .from('blockchain_revocation_queue')
                    .update({ 
                        status: status,
                        retry_count: retryCount,
                        error_message: processingError.message
                    })
                    .eq('id', item.id);
                
                // If failed permanently, update revocation log
                if (status === 'failed') {
                    await supabase
                        .from('revocation_log')
                        .update({ 
                            blockchain_status: 'failed'
                        })
                        .eq('id', item.revocation_log_id);
                }
            }
        }

        console.log('Finished processing blockchain revocation queue');
    } catch (error) {
        console.error('Error in blockchain revocation worker:', error);
    }
}

// Function to run the worker
async function runWorker() {
    await processRevocationQueue();
    
    // Schedule next run after 1 minute
    setTimeout(runWorker, 60000);
}

// Start the worker
if (require.main === module) {
    console.log('Starting blockchain revocation worker...');
    runWorker().catch(console.error);
}

export default processRevocationQueue;