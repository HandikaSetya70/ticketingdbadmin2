import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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

        const { 
            purchase_ids, 
            reason = 'Bot activity detected - rapid purchases',
            admin_id = 'system-bot-detection'
        } = req.body;

        if (!purchase_ids || !Array.isArray(purchase_ids) || purchase_ids.length === 0) {
            return res.status(400).json({ 
                status: 'error', 
                message: 'purchase_ids array is required and cannot be empty' 
            });
        }

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

        // Revoke tickets in database
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

        // Update purchase history status to 'revoked'
        const { error: updateError } = await supabase
            .from('purchase_history')
            .update({ status: 'revoked' })
            .in('id', purchase_ids);

        if (updateError) {
            console.error('⚠️ Warning: Failed to update purchase history status:', updateError);
        } else {
            console.log('✅ Updated purchase history status to revoked');
        }

        // 🆕 Add to revocation log for audit trail (with SELECT to get IDs)
        const revocationLogs = revokedTickets.map(ticket => ({
            ticket_id: ticket.ticket_id,
            admin_id: admin_id,
            reason: reason,
            revoked_at: new Date().toISOString()
        }));

        const { data: insertedLogs, error: logError } = await supabase
            .from('revocation_log')
            .insert(revocationLogs)
            .select('id, ticket_id'); // 🆕 Get the inserted log IDs

        if (logError) {
            console.error('⚠️ Warning: Failed to create revocation logs:', logError);
            // Continue without blockchain queue if revocation log fails
        } else {
            console.log(`📝 Created ${insertedLogs.length} revocation log entries`);
        }

        // 🆕 Queue blockchain revocations (now with proper revocation_log_id links)
        const blockchainQueueEntries = [];
        
        // Only process tickets that have blockchain registration
        const blockchainTickets = revokedTickets.filter(ticket => 
            ticket.blockchain_registered && ticket.nft_token_id
        );

        if (blockchainTickets.length > 0 && insertedLogs) {
            console.log(`⛓️ Preparing ${blockchainTickets.length} tickets for blockchain revocation`);
            
            blockchainTickets.forEach(ticket => {
                // Find the corresponding revocation log entry
                const logEntry = insertedLogs.find(log => log.ticket_id === ticket.ticket_id);
                
                if (logEntry) {
                    blockchainQueueEntries.push({
                        ticket_id: ticket.ticket_id,
                        revocation_log_id: logEntry.id, // 🆕 Proper link to revocation log
                        status: 'pending',
                        retry_count: 0,
                        created_at: new Date().toISOString()
                    });
                }
            });

            // Insert blockchain queue entries
            if (blockchainQueueEntries.length > 0) {
                const { error: queueError } = await supabase
                    .from('blockchain_revocation_queue')
                    .insert(blockchainQueueEntries);

                if (queueError) {
                    console.error('⚠️ Warning: Failed to queue blockchain revocations:', queueError);
                } else {
                    console.log(`⛓️ Successfully queued ${blockchainQueueEntries.length} tickets for blockchain revocation`);
                }
            }
        } else {
            console.log('ℹ️ No blockchain-registered tickets to queue for revocation');
        }

        console.log('🎉 ============ REVOCATION COMPLETE ============');
        console.log(`📊 Summary:`);
        console.log(`   🎫 Tickets revoked: ${revokedTickets.length}`);
        console.log(`   📝 Revocation logs created: ${insertedLogs?.length || 0}`);
        console.log(`   ⛓️ Blockchain revocations queued: ${blockchainQueueEntries.length}`);

        return res.status(200).json({
            status: 'success',
            message: `Successfully revoked ${revokedTickets.length} tickets from ${purchases.length} flagged purchases`,
            data: {
                revoked_tickets_count: revokedTickets.length,
                revoked_purchases_count: purchase_ids.length,
                revocation_logs_created: insertedLogs?.length || 0,
                blockchain_revocations_queued: blockchainQueueEntries.length,
                revoked_ticket_ids: revokedTickets.map(t => t.ticket_id),
                affected_users: [...new Set(purchases.map(p => p.users.id_name))],
                total_amount_affected: purchases.reduce((sum, p) => sum + parseFloat(p.payments.amount), 0)
            }
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