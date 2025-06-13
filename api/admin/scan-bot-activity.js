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
        // Get admin token and verify
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token) {
            return res.status(401).json({ 
                status: 'error', 
                message: 'Authorization token required' 
            });
        }

        // Optional: filter by event_id
        const { event_id, time_window_minutes = 5 } = req.body;

        console.log('🔍 ============ BOT SCAN STARTED ============');
        console.log('⏰ Time window:', time_window_minutes, 'minutes');
        console.log('🎭 Event filter:', event_id || 'All events');

        // Build query for rapid purchases
        let queryConditions = `
            purchase_timestamp >= NOW() - INTERVAL '${time_window_minutes} minutes'
            AND status = 'normal'
        `;

        if (event_id) {
            queryConditions += ` AND event_id = '${event_id}'`;
        }

        // Find users with multiple purchases in time window
        const { data: rapidPurchases, error } = await supabase
            .rpc('execute_raw_sql', {
                query: `
                    SELECT 
                        user_id,
                        COUNT(*) as purchase_count,
                        array_agg(id) as purchase_ids,
                        array_agg(event_id) as event_ids,
                        array_agg(payment_id) as payment_ids,
                        array_agg(quantity) as quantities,
                        MIN(purchase_timestamp) as first_purchase,
                        MAX(purchase_timestamp) as last_purchase
                    FROM purchase_history 
                    WHERE ${queryConditions}
                    GROUP BY user_id
                    HAVING COUNT(*) >= 2
                    ORDER BY purchase_count DESC, MAX(purchase_timestamp) DESC
                `
            });

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Database scan failed',
                error: error.message
            });
        }

        console.log(`🎯 Found ${rapidPurchases?.length || 0} users with rapid purchases`);

        // Flag the suspicious purchases
        const flaggedPurchases = [];
        
        for (const userActivity of rapidPurchases || []) {
            console.log(`🚨 Flagging user ${userActivity.user_id} with ${userActivity.purchase_count} rapid purchases`);
            
            // Flag all purchases for this user as suspicious
            const { error: updateError } = await supabase
                .from('purchase_history')
                .update({ 
                    status: 'flagged', 
                    flag: 'rapid_purchase' 
                })
                .in('id', userActivity.purchase_ids);

            if (!updateError) {
                const timeSpanMinutes = Math.round(
                    (new Date(userActivity.last_purchase) - new Date(userActivity.first_purchase)) / 1000 / 60
                );

                flaggedPurchases.push({
                    user_id: userActivity.user_id,
                    purchase_count: userActivity.purchase_count,
                    total_tickets: userActivity.quantities.reduce((sum, qty) => sum + qty, 0),
                    time_span_minutes: timeSpanMinutes,
                    first_purchase: userActivity.first_purchase,
                    last_purchase: userActivity.last_purchase,
                    purchase_ids: userActivity.purchase_ids,
                    event_ids: userActivity.event_ids
                });

                console.log(`✅ Flagged ${userActivity.purchase_count} purchases for user ${userActivity.user_id}`);
            } else {
                console.error(`❌ Failed to flag purchases for user ${userActivity.user_id}:`, updateError);
            }
        }

        console.log('🎉 ============ BOT SCAN COMPLETE ============');

        return res.status(200).json({
            status: 'success',
            message: `Scan completed. Found ${flaggedPurchases.length} suspicious users`,
            data: {
                scan_timestamp: new Date().toISOString(),
                time_window_minutes,
                event_filter: event_id || null,
                flagged_users_count: flaggedPurchases.length,
                flagged_purchases: flaggedPurchases
            }
        });

    } catch (error) {
        console.error('Bot scan error:', error);
        return res.status(500).json({
            status: 'error',
            message: 'Internal server error during bot scan',
            error: error.message
        });
    }
}