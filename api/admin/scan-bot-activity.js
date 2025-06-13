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

        // Calculate the time threshold
        const timeThreshold = new Date();
        timeThreshold.setMinutes(timeThreshold.getMinutes() - time_window_minutes);
        const timeThresholdISO = timeThreshold.toISOString();

        console.log('🕐 Scanning purchases since:', timeThresholdISO);

        // Build base query for purchases in the time window
        let query = supabase
            .from('purchase_history')
            .select('*')
            .gte('purchase_timestamp', timeThresholdISO)
            .eq('status', 'normal');

        // Add event filter if specified
        if (event_id) {
            query = query.eq('event_id', event_id);
        }

        // Get all purchases in the time window
        const { data: recentPurchases, error } = await query
            .order('purchase_timestamp', { ascending: false });

        if (error) {
            console.error('Database error:', error);
            return res.status(500).json({ 
                status: 'error', 
                message: 'Database scan failed',
                error: error.message
            });
        }

        console.log(`📊 Found ${recentPurchases?.length || 0} purchases in time window`);

        if (!recentPurchases || recentPurchases.length === 0) {
            return res.status(200).json({
                status: 'success',
                message: 'Scan completed. No purchases found in time window',
                data: {
                    scan_timestamp: new Date().toISOString(),
                    time_window_minutes,
                    event_filter: event_id || null,
                    flagged_users_count: 0,
                    flagged_purchases: []
                }
            });
        }

        // Group purchases by user_id and analyze patterns
        const userPurchases = {};
        
        recentPurchases.forEach(purchase => {
            const userId = purchase.user_id;
            if (!userPurchases[userId]) {
                userPurchases[userId] = [];
            }
            userPurchases[userId].push(purchase);
        });

        console.log(`👥 Analyzing ${Object.keys(userPurchases).length} unique users`);

        // Find users with multiple purchases (suspicious activity)
        const suspiciousUsers = [];
        
        Object.entries(userPurchases).forEach(([userId, purchases]) => {
            if (purchases.length >= 2) {
                // Calculate time span between first and last purchase
                const timestamps = purchases.map(p => new Date(p.purchase_timestamp));
                const firstPurchase = new Date(Math.min(...timestamps));
                const lastPurchase = new Date(Math.max(...timestamps));
                const timeSpanMinutes = (lastPurchase - firstPurchase) / (1000 * 60);
                
                // Calculate total tickets
                const totalTickets = purchases.reduce((sum, p) => sum + p.quantity, 0);
                
                suspiciousUsers.push({
                    user_id: userId,
                    purchase_count: purchases.length,
                    purchase_ids: purchases.map(p => p.id),
                    event_ids: [...new Set(purchases.map(p => p.event_id))],
                    payment_ids: purchases.map(p => p.payment_id),
                    quantities: purchases.map(p => p.quantity),
                    total_tickets: totalTickets,
                    first_purchase: firstPurchase.toISOString(),
                    last_purchase: lastPurchase.toISOString(),
                    time_span_minutes: Math.round(timeSpanMinutes * 100) / 100,
                    purchases: purchases
                });
                
                console.log(`🚨 Suspicious user ${userId}: ${purchases.length} purchases, ${totalTickets} tickets, ${timeSpanMinutes.toFixed(1)} min span`);
            }
        });

        console.log(`🎯 Found ${suspiciousUsers.length} users with rapid purchases`);

        // Flag the suspicious purchases in the database
        const flaggedPurchases = [];
        
        for (const userActivity of suspiciousUsers) {
            console.log(`🏷️ Flagging ${userActivity.purchase_count} purchases for user ${userActivity.user_id}`);
            
            // Update all purchases for this user as flagged
            const { error: updateError } = await supabase
                .from('purchase_history')
                .update({ 
                    status: 'flagged', 
                    flag: 'rapid_purchase' 
                })
                .in('id', userActivity.purchase_ids);

            if (!updateError) {
                flaggedPurchases.push({
                    user_id: userActivity.user_id,
                    purchase_count: userActivity.purchase_count,
                    total_tickets: userActivity.total_tickets,
                    time_span_minutes: userActivity.time_span_minutes,
                    first_purchase: userActivity.first_purchase,
                    last_purchase: userActivity.last_purchase,
                    purchase_ids: userActivity.purchase_ids,
                    event_ids: userActivity.event_ids
                });

                console.log(`✅ Successfully flagged ${userActivity.purchase_count} purchases for user ${userActivity.user_id}`);
            } else {
                console.error(`❌ Failed to flag purchases for user ${userActivity.user_id}:`, updateError);
            }
        }

        console.log('🎉 ============ BOT SCAN COMPLETE ============');
        console.log(`📈 Results: ${flaggedPurchases.length} users flagged, ${flaggedPurchases.reduce((sum, u) => sum + u.purchase_count, 0)} purchases flagged`);

        return res.status(200).json({
            status: 'success',
            message: `Scan completed. Found ${flaggedPurchases.length} suspicious users`,
            data: {
                scan_timestamp: new Date().toISOString(),
                time_window_minutes,
                event_filter: event_id || null,
                flagged_users_count: flaggedPurchases.length,
                flagged_purchases: flaggedPurchases,
                scan_details: {
                    total_purchases_in_window: recentPurchases.length,
                    unique_users_in_window: Object.keys(userPurchases).length,
                    suspicious_users_found: suspiciousUsers.length,
                    time_threshold: timeThresholdISO
                }
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